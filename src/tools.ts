import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig, RepoRuntime, ToolTextResult } from './types.js';
import {
  ensurePathAllowed,
  ensureTextFileReadable,
  makeBackup,
  normalizeRelativePath,
  parsePatchTouchedPaths,
  resolveRepo,
  sha256Buffer,
  sha256Text,
  UserFacingError,
} from './security.js';
import {
  assertSuccess,
  currentBranch,
  currentHead,
  git,
  gitOutput,
  runCommand,
  shellQuote,
  validateBranchName,
  validateCommitMessage,
  writeTempPatch,
} from './git.js';

function result<T extends Record<string, unknown>>(structuredContent: T): ToolTextResult<T> {
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function clipText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function getRepo(config: AppConfig, repos: RepoRuntime[], repoName: string): RepoRuntime {
  return resolveRepo(repos, repoName);
}

function isAllowedReadPath(config: AppConfig, repo: RepoRuntime, rel: string): boolean {
  try {
    ensurePathAllowed(config, repo, rel, 'read');
    return true;
  } catch {
    return false;
  }
}

async function listChangedFiles(repo: RepoRuntime, staged: boolean): Promise<string[]> {
  const args = staged ? ['diff', '--cached', '--name-only'] : ['diff', '--name-only'];
  const out = await gitOutput(repo, args, 'List changed files');
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function walkFiles(config: AppConfig, repo: RepoRuntime, startRel: string, maxFiles: number): string[] {
  const files: string[] = [];
  const startAbs = path.join(repo.absPath, startRel === '.' ? '' : startRel);
  const stack = [startAbs];

  while (stack.length && files.length < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(repo.absPath, abs).replace(/\\/g, '/') || '.';
      if (!isAllowedReadPath(config, repo, rel)) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        files.push(rel);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

export function createMcpServer(config: AppConfig, repos: RepoRuntime[]): McpServer {
  const server = new McpServer(
    { name: 'chatgpt-local-git-mcp', version: '0.1.0' },
    {
      instructions:
        'Safety-first Git MCP. Work only inside configured local Git repos. Never push to GitHub or any remote. Read files, edit allowed paths, show git diff, run whitelisted tasks, create local commits, then use prepare_push to return a command for the human to run manually.',
    },
  );

  server.registerTool(
    'list_repos',
    {
      title: 'List configured local Git repos',
      description: 'Use this when you need to discover which local Git repositories this MCP server can access.',
      inputSchema: {},
      outputSchema: {
        repos: z.array(z.object({ name: z.string(), path: z.string(), defaultBranch: z.string().optional() })),
      },
      annotations: { readOnlyHint: true },
    },
    async () => result({ repos: repos.map((repo) => ({ name: repo.name, path: repo.absPath, defaultBranch: repo.defaultBranch })) }),
  );

  server.registerTool(
    'repo_tree',
    {
      title: 'List files in a repo',
      description: 'Use this when you need a safe file listing from an allowed local Git repo. Denied paths are filtered out.',
      inputSchema: {
        repo: z.string().describe('Configured repo name from list_repos.'),
        pathPrefix: z.string().default('.').describe('Optional repo-relative folder or prefix to list.'),
        maxEntries: z.number().int().min(1).max(1000).default(200),
      },
      outputSchema: { repo: z.string(), files: z.array(z.string()), truncated: z.boolean() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, pathPrefix = '.', maxEntries = 200 }) => {
      const repo = getRepo(config, repos, repoName);
      const prefix = ensurePathAllowed(config, repo, pathPrefix, 'read');
      const raw = await gitOutput(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '--', prefix === '.' ? '' : prefix], 'List repo files');
      const allFiles = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((rel) => isAllowedReadPath(config, repo, rel));
      const files = allFiles.slice(0, maxEntries);
      return result({ repo: repo.name, files, truncated: allFiles.length > files.length });
    },
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a text file from a repo',
      description: 'Use this when you need to inspect an allowed text file before editing. Returns sha256 for safe overwrite checks.',
      inputSchema: {
        repo: z.string(),
        path: z.string().describe('Repo-relative file path.'),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      outputSchema: {
        repo: z.string(),
        path: z.string(),
        text: z.string(),
        sha256: z.string(),
        bytes: z.number(),
        totalLines: z.number(),
        returnedLines: z.object({ start: z.number(), end: z.number() }),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, path: relInput, startLine, endLine }) => {
      const repo = getRepo(config, repos, repoName);
      const rel = ensurePathAllowed(config, repo, relInput, 'read');
      const abs = path.join(repo.absPath, rel);
      const buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      const start = startLine ?? 1;
      const end = endLine ?? lines.length;
      if (end < start) throw new UserFacingError('endLine must be greater than or equal to startLine.');
      const selected = lines.slice(start - 1, end).join('\n');
      return result({
        repo: repo.name,
        path: rel,
        text: selected,
        sha256: sha256Buffer(buffer),
        bytes: buffer.length,
        totalLines: lines.length,
        returnedLines: { start, end: Math.min(end, lines.length) },
      });
    },
  );

  server.registerTool(
    'search_code',
    {
      title: 'Search text in repo files',
      description: 'Use this when you need to find code or text in an allowed local Git repo without reading the whole project.',
      inputSchema: {
        repo: z.string(),
        query: z.string().min(1),
        pathPrefix: z.string().default('.'),
        maxMatches: z.number().int().min(1).max(100).default(30),
      },
      outputSchema: {
        repo: z.string(),
        query: z.string(),
        matches: z.array(z.object({ path: z.string(), line: z.number(), preview: z.string() })),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, query, pathPrefix = '.', maxMatches = 30 }) => {
      const repo = getRepo(config, repos, repoName);
      const prefix = ensurePathAllowed(config, repo, pathPrefix, 'read');
      const files = walkFiles(config, repo, prefix, 5000);
      const matches: Array<{ path: string; line: number; preview: string }> = [];
      const needle = query.toLowerCase();
      for (const rel of files) {
        if (matches.length >= maxMatches) break;
        const abs = path.join(repo.absPath, rel);
        let buffer: Buffer;
        try {
          buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
        } catch {
          continue;
        }
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ path: rel, line: i + 1, preview: lines[i].trim().slice(0, 300) });
            if (matches.length >= maxMatches) break;
          }
        }
      }
      return result({ repo: repo.name, query, matches, truncated: matches.length >= maxMatches });
    },
  );

  server.registerTool(
    'git_status',
    {
      title: 'Show Git status',
      description: 'Use this when you need the current branch, HEAD and short Git status for a configured repo.',
      inputSchema: { repo: z.string() },
      outputSchema: { repo: z.string(), branch: z.string(), head: z.string(), status: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName }) => {
      const repo = getRepo(config, repos, repoName);
      const [branch, head, status] = await Promise.all([
        currentBranch(repo),
        currentHead(repo),
        gitOutput(repo, ['status', '--short'], 'Get git status'),
      ]);
      return result({ repo: repo.name, branch, head, status });
    },
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Show Git diff',
      description: 'Use this before committing so the human can review changes. Denied paths are filtered out.',
      inputSchema: {
        repo: z.string(),
        staged: z.boolean().default(false),
        paths: z.array(z.string()).default([]),
      },
      outputSchema: { repo: z.string(), staged: z.boolean(), diff: z.string(), truncated: z.boolean(), files: z.array(z.string()) },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, staged = false, paths = [] }) => {
      const repo = getRepo(config, repos, repoName);
      const selectedFiles = paths.length
        ? paths.map((p) => ensurePathAllowed(config, repo, p, 'read'))
        : (await listChangedFiles(repo, staged)).filter((rel) => isAllowedReadPath(config, repo, rel));
      if (selectedFiles.length === 0) return result({ repo: repo.name, staged, diff: '', truncated: false, files: [] });
      const args = staged ? ['diff', '--cached', '--', ...selectedFiles] : ['diff', '--', ...selectedFiles];
      const out = await gitOutput(repo, args, 'Get git diff');
      const clipped = clipText(out, config.security.maxReadBytes * 2);
      return result({ repo: repo.name, staged, diff: clipped.text, truncated: clipped.truncated, files: selectedFiles });
    },
  );

  server.registerTool(
    'create_branch',
    {
      title: 'Create and switch to a local Git branch',
      description: 'Use this before editing to isolate work on a local branch. This does not push to any remote.',
      inputSchema: {
        repo: z.string(),
        branch: z.string().describe('New local branch name, for example feat/chatgpt-admin-fix.'),
        baseRef: z.string().optional().describe('Optional base ref. Defaults to current HEAD.'),
      },
      outputSchema: { repo: z.string(), branch: z.string(), previousBranch: z.string(), head: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, branch, baseRef }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(branch);
      if (baseRef && !/^[A-Za-z0-9._/@-]+$/.test(baseRef)) throw new UserFacingError('baseRef contains unsupported characters.');
      const previousBranch = await currentBranch(repo);
      const check = await git(repo, ['check-ref-format', '--branch', branch]);
      assertSuccess(check, 'Validate branch name');
      const args = baseRef ? ['switch', '-c', branch, baseRef] : ['switch', '-c', branch];
      const switched = await git(repo, args);
      assertSuccess(switched, 'Create local branch');
      return result({ repo: repo.name, branch: await currentBranch(repo), previousBranch, head: await currentHead(repo) });
    },
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write an allowed text file',
      description: 'Use this to create or overwrite a text file in allowedWritePaths only. Existing files require expected_sha256 by default.',
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        content: z.string(),
        expected_sha256: z.string().optional().describe('sha256 returned by read_file. Required for overwriting existing files when configured.'),
      },
      outputSchema: { repo: z.string(), path: z.string(), sha256: z.string(), bytes: z.number(), backupPath: z.string().nullable() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, path: relInput, content, expected_sha256 }) => {
      const repo = getRepo(config, repos, repoName);
      const rel = ensurePathAllowed(config, repo, relInput, 'write');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > config.security.maxWriteBytes) throw new UserFacingError(`Content too large (${bytes} bytes).`);
      const abs = path.join(repo.absPath, rel);
      if (fs.existsSync(abs)) {
        const current = ensureTextFileReadable(abs, config.security.maxReadBytes);
        const currentSha = sha256Buffer(current);
        if (config.security.requireExpectedShaForOverwrite && !expected_sha256) {
          throw new UserFacingError(`expected_sha256 is required to overwrite '${rel}'. Call read_file first.`);
        }
        if (expected_sha256 && expected_sha256 !== currentSha) {
          throw new UserFacingError(`sha256 mismatch for '${rel}'. Current=${currentSha}, expected=${expected_sha256}. Re-read the file before writing.`);
        }
      }
      const backupPath = makeBackup(repo, [rel]);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return result({ repo: repo.name, path: rel, sha256: sha256Text(content), bytes, backupPath });
    },
  );

  server.registerTool(
    'apply_patch',
    {
      title: 'Apply a unified diff patch',
      description: 'Use this to apply a Git unified diff to allowedWritePaths only. The server validates touched paths and runs git apply --check first.',
      inputSchema: { repo: z.string(), patch: z.string().min(1) },
      outputSchema: { repo: z.string(), touchedPaths: z.array(z.string()), backupPath: z.string().nullable(), status: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, patch }) => {
      const repo = getRepo(config, repos, repoName);
      if (Buffer.byteLength(patch, 'utf8') > config.security.maxWriteBytes * 4) throw new UserFacingError('Patch is too large.');
      const touchedPaths = parsePatchTouchedPaths(patch);
      if (touchedPaths.length === 0) throw new UserFacingError('Patch does not contain recognizable file paths.');
      for (const rel of touchedPaths) ensurePathAllowed(config, repo, rel, 'write');
      const backupPath = makeBackup(repo, touchedPaths);
      const patchPath = await writeTempPatch(patch);
      const check = await git(repo, ['apply', '--check', patchPath]);
      assertSuccess(check, 'Validate patch');
      const applied = await git(repo, ['apply', '--whitespace=nowarn', patchPath]);
      assertSuccess(applied, 'Apply patch');
      return result({ repo: repo.name, touchedPaths, backupPath, status: 'applied' });
    },
  );

  server.registerTool(
    'run_task',
    {
      title: 'Run a whitelisted repo task',
      description: 'Use this to run only preconfigured safe tasks such as tests or builds. It cannot run arbitrary shell commands.',
      inputSchema: {
        repo: z.string(),
        task: z.string().describe('Allowed task key from config.yaml repos.<repo>.allowedTasks.'),
      },
      outputSchema: { repo: z.string(), task: z.string(), command: z.array(z.string()), code: z.number().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(), success: z.boolean() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, task }) => {
      const repo = getRepo(config, repos, repoName);
      const taskConfig = repo.allowedTasks?.[task];
      if (!taskConfig) {
        const available = Object.keys(repo.allowedTasks ?? {});
        throw new UserFacingError(`Task '${task}' is not allowed. Available tasks: ${available.join(', ') || '(none)'}`);
      }
      if (!Array.isArray(taskConfig.command) || taskConfig.command.length === 0) throw new UserFacingError(`Task '${task}' has invalid command config.`);
      const run = await runCommand(repo.absPath, taskConfig.command[0], taskConfig.command.slice(1), taskConfig.timeoutMs ?? config.security.commandTimeoutMs);
      const stdout = clipText(run.stdout, config.security.maxReadBytes);
      const stderr = clipText(run.stderr, config.security.maxReadBytes);
      return result({ repo: repo.name, task, command: taskConfig.command, code: run.code, stdout: stdout.text, stderr: stderr.text, timedOut: run.timedOut, success: run.code === 0 && !run.timedOut });
    },
  );

  server.registerTool(
    'git_add',
    {
      title: 'Stage allowed files',
      description: 'Use this after reviewing changes to stage specific allowed files for local commit. This does not commit or push.',
      inputSchema: { repo: z.string(), paths: z.array(z.string()).min(1) },
      outputSchema: { repo: z.string(), stagedPaths: z.array(z.string()), status: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, paths }) => {
      const repo = getRepo(config, repos, repoName);
      const rels = paths.map((p) => ensurePathAllowed(config, repo, p, 'write'));
      const add = await git(repo, ['add', '--', ...rels]);
      assertSuccess(add, 'Stage files');
      const status = await gitOutput(repo, ['status', '--short'], 'Get git status');
      return result({ repo: repo.name, stagedPaths: rels, status });
    },
  );

  server.registerTool(
    'git_commit',
    {
      title: 'Create a local Git commit',
      description: 'Use this only after showing git_diff to the human. Commits staged allowed files locally. It never pushes.',
      inputSchema: { repo: z.string(), message: z.string() },
      outputSchema: { repo: z.string(), commit: z.string(), branch: z.string(), message: z.string(), note: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, message }) => {
      const repo = getRepo(config, repos, repoName);
      const msg = validateCommitMessage(message);
      const staged = await gitOutput(repo, ['diff', '--cached', '--name-only'], 'List staged files');
      const stagedFiles = staged.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (stagedFiles.length === 0) throw new UserFacingError('No staged files. Call git_add first.');
      const unauthorized = stagedFiles.filter((rel) => {
        try {
          ensurePathAllowed(config, repo, rel, 'write');
          return false;
        } catch {
          return true;
        }
      });
      if (unauthorized.length > 0) {
        throw new UserFacingError(`Refusing to commit unauthorized staged paths: ${unauthorized.join(', ')}`);
      }
      const commit = await git(repo, ['commit', '-m', msg], config.security.commandTimeoutMs);
      assertSuccess(commit, 'Create local commit');
      const hash = await currentHead(repo);
      return result({ repo: repo.name, commit: hash, branch: await currentBranch(repo), message: msg, note: 'Local commit created. No remote push was performed.' });
    },
  );

  server.registerTool(
    'prepare_push',
    {
      title: 'Prepare manual push command',
      description: 'Use this at the end to generate a git push command for the human. This tool does not contact GitHub or any remote.',
      inputSchema: {
        repo: z.string(),
        remote: z.string().default('origin'),
        branch: z.string().optional(),
        setUpstream: z.boolean().default(true),
      },
      outputSchema: { repo: z.string(), branch: z.string(), remote: z.string(), command: z.string(), warning: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, remote = 'origin', branch, setUpstream = true }) => {
      const repo = getRepo(config, repos, repoName);
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new UserFacingError('Remote name contains unsupported characters.');
      const targetBranch = branch ? normalizeRelativePath(branch) : await currentBranch(repo);
      validateBranchName(targetBranch);
      const args = ['push'];
      if (setUpstream) args.push('-u');
      args.push(remote, targetBranch);
      const command = ['git', ...args.map(shellQuote)].join(' ');
      return result({
        repo: repo.name,
        branch: targetBranch,
        remote,
        command,
        warning: 'Review git status and git diff before running this command manually. This MCP server did not push anything.',
      });
    },
  );

  return server;
}
