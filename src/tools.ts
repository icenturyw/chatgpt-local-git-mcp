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
  branchExists,
  currentBranch,
  currentHead,
  diffSummary,
  git,
  gitOutput,
  listBranches,
  mergeBase,
  runCommand,
  shellQuote,
  validateBranchName,
  validateCommitMessage,
  writeTempPatch,
} from './git.js';
import { writeAuditLog, type AuditEvent } from './audit.js';
import { reloadConfig as reloadConfigFn, getRepos } from './config.js';

export const REGISTERED_TOOL_NAMES = [
  'list_registered_tools',
  'config_status',
  'list_branches',
  'ensure_branch',
  'reload_config',
  'list_repos',
  'list_tasks',
  'repo_tree',
  'read_project_context',
  'read_file',
  'search_code',
  'read_file_around_match',
  'git_status',
  'git_diff',
  'create_branch',
  'git_switch',
  'prepare_merge',
  'git_merge',
  'merge_workflow_status',
  'git_merge_to_target',
  'write_file',
  'apply_patch',
  'edit_file_sections',
  'run_task',
  'git_add',
  'git_commit',
  'prepare_push',
  'replace_text',
  'replace_in_file',
  'validate_patch',
  'prepare_pr_text',
  'git_workflow_status',
  'git_diff_summary',
  'list_backups',
  'restore_backup',
] as const;

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

export function buildRepoTreeGitArgs(prefix: string): string[] {
  return ['ls-files', '--cached', '--others', '--exclude-standard', '--', prefix === '.' ? '.' : prefix];
}

type ProjectContextMode = 'smart' | 'full' | 'summary';

type ProjectContextFile = {
  path: string;
  bytes: number;
  sha256: string;
  content: string;
};

type SkippedProjectContextFile = {
  path: string;
  reason: string;
};

const PROJECT_CONTEXT_LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
]);

const PROJECT_CONTEXT_LOW_SIGNAL_DIRS = [
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'tmp',
  'temp',
  'logs',
];

const PROJECT_CONTEXT_LOW_SIGNAL_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.woff', '.woff2', '.ttf', '.otf',
  '.sqlite', '.sqlite3', '.db', '.log', '.map',
]);

function projectContextBasename(rel: string): string {
  return path.posix.basename(rel).toLowerCase();
}

function isProjectContextLockfile(rel: string): boolean {
  return PROJECT_CONTEXT_LOCKFILES.has(projectContextBasename(rel));
}

function isProjectContextTestPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower.startsWith('tests/')
    || lower.includes('/tests/')
    || lower.includes('/__tests__/')
    || /\.(test|spec)\.[^.]+$/.test(lower);
}

function isProjectContextDocsPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower === 'readme.md'
    || lower.startsWith('docs/')
    || ['.md', '.mdx', '.rst', '.txt'].includes(path.posix.extname(lower));
}

function smartProjectContextSkipReason(rel: string): string | null {
  const lower = rel.toLowerCase();
  const parts = lower.split('/');
  if (parts.some((part) => PROJECT_CONTEXT_LOW_SIGNAL_DIRS.includes(part))) return 'low-signal generated directory skipped by smart mode';
  if (PROJECT_CONTEXT_LOW_SIGNAL_EXTENSIONS.has(path.posix.extname(lower))) return 'binary or low-signal asset skipped by smart mode';
  return null;
}

function projectContextRank(rel: string): number {
  const lower = rel.toLowerCase();
  const base = projectContextBasename(lower);
  if (['package.json', 'tsconfig.json', 'tsconfig.test.json', 'config.example.yaml', 'docker-compose.yml', 'dockerfile'].includes(base)) return 0;
  if (base === 'readme.md') return 1;
  if (lower.startsWith('src/')) return 10;
  if (isProjectContextTestPath(lower)) return 20;
  if (isProjectContextDocsPath(lower)) return 30;
  return 40;
}

function orderProjectContextFiles(files: string[], mode: ProjectContextMode): string[] {
  if (mode !== 'smart') return files;
  return [...files].sort((a, b) => projectContextRank(a) - projectContextRank(b) || a.localeCompare(b));
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

export function isProtectedBranch(branch: string, protectedBranches: string[]): boolean {
  return protectedBranches.includes(branch);
}

async function ensureWritableBranch(
  config: AppConfig,
  repo: RepoRuntime,
  action: string,
): Promise<void> {
  const branch = await currentBranch(repo);
  if (isProtectedBranch(branch, config.security.protectedBranches)) {
    throw new UserFacingError(
      `${action} is blocked on protected branch '${branch}'. Create and switch to a feature branch first.`,
    );
  }
}

type WorkingTreeStatus = {
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  mcpGeneratedFiles: string[];
  cleanIgnoringMcpGenerated: boolean;
};

function isCleanWorkingTree(status: WorkingTreeStatus): boolean {
  return status.stagedFiles.length === 0
    && status.unstagedFiles.length === 0
    && status.untrackedFiles.length === 0;
}

function parseStatusOutput(statusOutput: string): WorkingTreeStatus {
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of statusOutput.split(/\r?\n/).filter(Boolean)) {
    const statusCode = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (statusCode.includes('?')) {
      untrackedFiles.push(filePath);
      continue;
    }
    if (statusCode[0] !== ' ' && statusCode[0] !== '?') stagedFiles.push(filePath);
    if (statusCode[1] !== ' ' && statusCode[1] !== '?') unstagedFiles.push(filePath);
  }

  return {
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    mcpGeneratedFiles: [],
    cleanIgnoringMcpGenerated: stagedFiles.length === 0 && unstagedFiles.length === 0 && untrackedFiles.length === 0,
  };
}

type MergeAnalysis = {
  mergeBase: string;
  ahead: number;
  behind: number;
  diffSummary: Array<{ path: string; added: number; deleted: number }>;
  conflicts: string[];
  canMerge: boolean;
};

async function analyzeMerge(repo: RepoRuntime, targetBranch: string, sourceBranch: string): Promise<MergeAnalysis> {
  validateBranchName(targetBranch);
  validateBranchName(sourceBranch);

  const targetExists = await branchExists(repo, targetBranch);
  if (!targetExists) throw new UserFacingError(`Target branch '${targetBranch}' does not exist.`);

  const sourceExists = await branchExists(repo, sourceBranch);
  if (!sourceExists) throw new UserFacingError(`Source branch '${sourceBranch}' does not exist.`);

  if (targetBranch === sourceBranch) {
    throw new UserFacingError('targetBranch and sourceBranch must be different.');
  }

  const base = await mergeBase(repo, targetBranch, sourceBranch);
  const [targetHead, sourceHead] = await Promise.all([
    gitOutput(repo, ['rev-parse', targetBranch], 'Get target HEAD'),
    gitOutput(repo, ['rev-parse', sourceBranch], 'Get source HEAD'),
  ]);

  const aheadResult = await git(repo, ['rev-list', '--count', `${base}..${sourceHead.trim()}`]);
  const behindResult = await git(repo, ['rev-list', '--count', `${base}..${targetHead.trim()}`]);

  const ahead = parseInt(aheadResult.stdout.trim(), 10) || 0;
  const behind = parseInt(behindResult.stdout.trim(), 10) || 0;
  const diff = await diffSummary(repo, targetBranch, sourceBranch);

  const checkResult = await git(repo, ['merge-tree', base, targetBranch, sourceBranch]);
  const conflicts = `${checkResult.stdout}\n${checkResult.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.includes('CONFLICT'))
    .slice(0, 20);

  return {
    mergeBase: base,
    ahead,
    behind,
    diffSummary: diff.files,
    conflicts,
    canMerge: checkResult.code === 0 && conflicts.length === 0,
  };
}

function audit(repo: RepoRuntime, tool: string, success: boolean, paths?: string[], error?: string, branch?: string): void {
  const event: AuditEvent = {
    time: new Date().toISOString(),
    tool,
    repo: repo.name,
    branch,
    paths,
    success,
    error,
  };
  writeAuditLog(repo.absPath, event);
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
    'list_registered_tools',
    {
      title: 'List registered MCP tools',
      description: 'Use this to discover which tools are currently registered in this MCP server. Useful for debugging tool visibility issues with ChatGPT.',
      inputSchema: {},
      outputSchema: {
        name: z.string(),
        version: z.string(),
        toolCount: z.number(),
        tools: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async () => result({
      name: 'chatgpt-local-git-mcp',
      version: '0.1.0',
      toolCount: REGISTERED_TOOL_NAMES.length,
      tools: [...REGISTERED_TOOL_NAMES],
    }),
  );

  server.registerTool(
    'config_status',
    {
      title: 'Show current configuration status',
      description: 'Use this to see which config file is being used, what repos are configured, and what tasks are available. Helps debug configuration issues.',
      inputSchema: {},
      outputSchema: {
        configPath: z.string(),
        usingExampleConfig: z.boolean(),
        reposDir: z.string().optional(),
        repoCount: z.number(),
        repos: z.array(z.object({
          name: z.string(),
          path: z.string(),
          allowedReadPaths: z.array(z.string()),
          allowedWritePaths: z.array(z.string()),
          deniedPaths: z.array(z.string()),
          tasks: z.array(z.string()),
        })),
      },
      annotations: { readOnlyHint: true },
    },
    async () => {
      const configPath = process.env.CONFIG_PATH || 'config.yaml';
      const usingExampleConfig = configPath.includes('config.example.yaml');
      return result({
        configPath,
        usingExampleConfig,
        reposDir: config.reposDir,
        repoCount: repos.length,
        repos: repos.map((repo) => ({
          name: repo.name,
          path: repo.absPath,
          allowedReadPaths: repo.allowedReadPaths,
          allowedWritePaths: repo.allowedWritePaths,
          deniedPaths: repo.deniedPaths,
          tasks: Object.keys(repo.allowedTasks ?? {}),
        })),
      });
    },
  );

  server.registerTool(
    'list_branches',
    {
      title: 'List local branches in a repo',
      description: 'Use this to see all local branches in a repository, including the current branch and protected branches.',
      inputSchema: {
        repo: z.string(),
      },
      outputSchema: {
        repo: z.string(),
        current: z.string(),
        local: z.array(z.string()),
        protected: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName }) => {
      const repo = getRepo(config, repos, repoName);
      const current = await currentBranch(repo);
      const branches = await listBranches(repo);
      const protectedBranches = config.security.protectedBranches.filter((b) => branches.includes(b));
      return result({
        repo: repo.name,
        current,
        local: branches,
        protected: protectedBranches,
      });
    },
  );

  server.registerTool(
    'ensure_branch',
    {
      title: 'Ensure a branch exists and switch to it',
      description: 'Use this to create a branch if it does not exist, or switch to it if it already does. This replaces the create_branch + git_switch combination.',
      inputSchema: {
        repo: z.string(),
        branch: z.string().describe('Branch name to create or switch to.'),
        baseRef: z.string().optional().describe('Optional base ref for new branch creation. Defaults to current HEAD.'),
      },
      outputSchema: {
        repo: z.string(),
        branch: z.string(),
        previousBranch: z.string(),
        head: z.string(),
        created: z.boolean(),
        switched: z.boolean(),
        alreadyOnBranch: z.boolean(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, branch, baseRef }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(branch);
      if (baseRef && !/^[A-Za-z0-9._/@-]+$/.test(baseRef)) {
        throw new UserFacingError('baseRef contains unsupported characters.');
      }

      const previousBranch = await currentBranch(repo);
      const exists = await branchExists(repo, branch);

      if (previousBranch === branch) {
        return result({
          repo: repo.name,
          branch,
          previousBranch,
          head: await currentHead(repo),
          created: false,
          switched: false,
          alreadyOnBranch: true,
        });
      }

      if (exists) {
        const switched = await git(repo, ['switch', branch]);
        assertSuccess(switched, 'Switch to existing branch');
        return result({
          repo: repo.name,
          branch: await currentBranch(repo),
          previousBranch,
          head: await currentHead(repo),
          created: false,
          switched: true,
          alreadyOnBranch: false,
        });
      }

      const args = baseRef ? ['switch', '-c', branch, baseRef] : ['switch', '-c', branch];
      const created = await git(repo, args);
      assertSuccess(created, 'Create and switch to new branch');
      return result({
        repo: repo.name,
        branch: await currentBranch(repo),
        previousBranch,
        head: await currentHead(repo),
        created: true,
        switched: true,
        alreadyOnBranch: false,
      });
    },
  );

  server.registerTool(
    'reload_config',
    {
      title: 'Reload configuration from disk',
      description: 'Use this to reload the configuration file without restarting the server. Changes to repos, tasks, and security settings will take effect immediately.',
      inputSchema: {
        dryRun: z.boolean().default(false).describe('If true, only validate the config without applying changes.'),
      },
      outputSchema: {
        ok: z.boolean(),
        configPath: z.string(),
        repoCountBefore: z.number(),
        repoCountAfter: z.number(),
        repos: z.array(z.object({
          name: z.string(),
          tasks: z.array(z.string()),
        })),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ dryRun = false }) => {
      const configPath = process.env.CONFIG_PATH || 'config.yaml';
      const repoCountBefore = repos.length;

      try {
        const newConfig = reloadConfigFn();
        const newRepos = getRepos(newConfig);

        if (dryRun) {
          return result({
            ok: true,
            configPath,
            repoCountBefore,
            repoCountAfter: newRepos.length,
            repos: newRepos.map((repo) => ({
              name: repo.name,
              tasks: Object.keys(repo.allowedTasks ?? {}),
            })),
          });
        }

        config.repos = newConfig.repos;
        config.reposDir = newConfig.reposDir;
        config.security = newConfig.security;
        config.server = newConfig.server;
        config.auth = newConfig.auth;

        repos.length = 0;
        repos.push(...newRepos);

        return result({
          ok: true,
          configPath,
          repoCountBefore,
          repoCountAfter: repos.length,
          repos: repos.map((repo) => ({
            name: repo.name,
            tasks: Object.keys(repo.allowedTasks ?? {}),
          })),
        });
      } catch (err) {
        return result({
          ok: false,
          configPath,
          repoCountBefore,
          repoCountAfter: repoCountBefore,
          repos: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    'list_tasks',
    {
      title: 'List whitelisted repo tasks',
      description: 'Use this to discover safe task keys configured for a repo before calling run_task.',
      inputSchema: { repo: z.string() },
      outputSchema: {
        repo: z.string(),
        tasks: z.array(z.object({
          name: z.string(),
          description: z.string().optional(),
          command: z.array(z.string()),
          source: z.enum(['explicit', 'auto-detected']),
          timeoutMs: z.number().optional(),
        })),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName }) => {
      const repo = getRepo(config, repos, repoName);
      const tasks = Object.entries(repo.allowedTasks ?? {}).map(([name, task]) => ({
        name,
        ...task,
        source: task.description?.startsWith('Auto-detected') ? 'auto-detected' as const : 'explicit' as const,
      }));
      return result({ repo: repo.name, tasks });
    },
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
      const raw = await gitOutput(repo, buildRepoTreeGitArgs(prefix), 'List repo files');
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
    'read_project_context',
    {
      title: 'Read project context safely',
      description: 'Use this to return a safe, structured snapshot of repo files for ChatGPT to understand a project. Denied paths, binary files, large files, and total output limits are enforced.',
      inputSchema: {
        repo: z.string().describe('Configured repo name from list_repos.'),
        pathPrefix: z.string().default('.').describe('Optional repo-relative folder or prefix to read.'),
        maxFiles: z.number().int().min(1).max(500).default(80).describe('Maximum number of files to include.'),
        maxTotalBytes: z.number().int().min(1000).max(5_000_000).default(512 * 1024).describe('Maximum content bytes returned across all files.'),
        includeTests: z.boolean().default(true).describe('Whether to include test files.'),
        includeDocs: z.boolean().default(true).describe('Whether to include docs and markdown-like files.'),
        includeLockfiles: z.boolean().default(false).describe('Whether to include lockfiles such as package-lock.json.'),
        mode: z.enum(['smart', 'full', 'summary']).default('smart').describe('smart prioritizes high-signal files, full reads allowed files in git order, summary omits file content.'),
      },
      outputSchema: {
        repo: z.string(),
        pathPrefix: z.string(),
        mode: z.enum(['smart', 'full', 'summary']),
        filesRead: z.array(z.object({
          path: z.string(),
          bytes: z.number(),
          sha256: z.string(),
          content: z.string(),
        })),
        skippedFiles: z.array(z.object({
          path: z.string(),
          reason: z.string(),
        })),
        totalBytes: z.number(),
        fileCount: z.number(),
        truncated: z.boolean(),
        warnings: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      repo: repoName,
      pathPrefix = '.',
      maxFiles = 80,
      maxTotalBytes = 512 * 1024,
      includeTests = true,
      includeDocs = true,
      includeLockfiles = false,
      mode = 'smart',
    }) => {
      const repo = getRepo(config, repos, repoName);
      const prefix = ensurePathAllowed(config, repo, pathPrefix, 'read');
      const raw = await gitOutput(repo, buildRepoTreeGitArgs(prefix), 'List project context files');
      const allFiles = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const filesRead: ProjectContextFile[] = [];
      const skippedFiles: SkippedProjectContextFile[] = [];
      const warnings: string[] = [];
      let totalBytes = 0;
      let truncated = false;

      if (mode === 'smart') warnings.push('Smart mode prioritizes high-signal files and skips common generated/assets by default.');
      if (mode === 'summary') warnings.push('Summary mode omits file content but still reports bytes and sha256.');

      const candidates = orderProjectContextFiles(allFiles, mode);

      for (const rel of candidates) {
        if (filesRead.length >= maxFiles) {
          truncated = true;
          warnings.push('Max file count reached.');
          break;
        }

        if (!isAllowedReadPath(config, repo, rel)) {
          skippedFiles.push({ path: rel, reason: 'denied path' });
          continue;
        }

        if (!includeTests && isProjectContextTestPath(rel)) {
          skippedFiles.push({ path: rel, reason: 'tests skipped by request' });
          continue;
        }

        if (!includeDocs && isProjectContextDocsPath(rel)) {
          skippedFiles.push({ path: rel, reason: 'docs skipped by request' });
          continue;
        }

        if (!includeLockfiles && isProjectContextLockfile(rel)) {
          skippedFiles.push({ path: rel, reason: 'lockfile skipped by default' });
          continue;
        }

        const smartSkipReason = mode === 'smart' ? smartProjectContextSkipReason(rel) : null;
        if (smartSkipReason) {
          skippedFiles.push({ path: rel, reason: smartSkipReason });
          continue;
        }

        const abs = path.join(repo.absPath, rel);
        let buffer: Buffer;
        try {
          buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
        } catch (err) {
          skippedFiles.push({ path: rel, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }

        const content = mode === 'summary' ? '' : buffer.toString('utf8');
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (totalBytes + contentBytes > maxTotalBytes) {
          truncated = true;
          skippedFiles.push({ path: rel, reason: 'maxTotalBytes limit would be exceeded' });
          warnings.push('Max total bytes reached.');
          break;
        }

        totalBytes += contentBytes;
        filesRead.push({
          path: rel,
          bytes: buffer.length,
          sha256: sha256Buffer(buffer),
          content,
        });
      }

      return result({
        repo: repo.name,
        pathPrefix: prefix,
        mode,
        filesRead,
        skippedFiles,
        totalBytes,
        fileCount: filesRead.length,
        truncated,
        warnings: [...new Set(warnings)],
      });
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
    'read_file_around_match',
    {
      title: 'Read file context around a text match',
      description: 'Use this to read a file around a specific text match, providing context lines before and after.',
      inputSchema: {
        repo: z.string(),
        path: z.string().describe('Repo-relative file path.'),
        query: z.string().describe('Text to search for in the file.'),
        contextLines: z.number().int().min(1).max(50).default(10).describe('Number of lines of context before and after the match.'),
        maxMatches: z.number().int().min(1).max(10).default(3).describe('Maximum number of matches to return context for.'),
      },
      outputSchema: {
        repo: z.string(),
        path: z.string(),
        query: z.string(),
        matches: z.array(z.object({
          line: z.number(),
          preview: z.string(),
          context: z.string(),
        })),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, path: relInput, query, contextLines = 10, maxMatches = 3 }) => {
      const repo = getRepo(config, repos, repoName);
      const rel = ensurePathAllowed(config, repo, relInput, 'read');
      const abs = path.join(repo.absPath, rel);

      const buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);

      const matches: Array<{ line: number; preview: string; context: string }> = [];
      const needle = query.toLowerCase();

      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          const startLine = Math.max(0, i - contextLines);
          const endLine = Math.min(lines.length - 1, i + contextLines);
          const context = lines.slice(startLine, endLine + 1).join('\n');
          matches.push({
            line: i + 1,
            preview: lines[i].trim(),
            context,
          });
        }
      }

      return result({
        repo: repo.name,
        path: rel,
        query,
        matches,
        truncated: matches.length >= maxMatches && lines.some((line, idx) => idx > matches[matches.length - 1]?.line && line.toLowerCase().includes(needle)),
      });
    },
  );

  server.registerTool(
    'git_status',
    {
      title: 'Show Git status',
      description: 'Use this when you need the current branch, HEAD and short Git status for a configured repo. Filters out .chatgpt-git-mcp backup directory changes.',
      inputSchema: { repo: z.string() },
      outputSchema: {
        repo: z.string(),
        branch: z.string(),
        head: z.string(),
        status: z.string(),
        mcpGenerated: z.array(z.string()),
        cleanIgnoringMcpGenerated: z.boolean(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName }) => {
      const repo = getRepo(config, repos, repoName);
      const [branch, head, rawStatus] = await Promise.all([
        currentBranch(repo),
        currentHead(repo),
        gitOutput(repo, ['status', '--short'], 'Get git status'),
      ]);

      const statusLines = rawStatus.split(/\r?\n/).filter(Boolean);
      const mcpGenerated: string[] = [];
      const filteredLines: string[] = [];

      for (const line of statusLines) {
        const filePath = line.slice(3).trim();
        if (filePath.startsWith('.chatgpt-git-mcp/') || filePath.startsWith('.chatgpt-git-mcp\\')) {
          mcpGenerated.push(filePath);
        } else {
          filteredLines.push(line);
        }
      }

      const status = filteredLines.join('\n');
      const cleanIgnoringMcpGenerated = filteredLines.length === 0;

      return result({
        repo: repo.name,
        branch,
        head,
        status,
        mcpGenerated,
        cleanIgnoringMcpGenerated,
      });
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
        switchIfExists: z.boolean().default(false).describe('Switch to the branch when it already exists instead of failing.'),
      },
      outputSchema: { repo: z.string(), branch: z.string(), previousBranch: z.string(), head: z.string(), created: z.boolean() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, branch, baseRef, switchIfExists = false }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(branch);
      if (baseRef && !/^[A-Za-z0-9._/@-]+$/.test(baseRef)) throw new UserFacingError('baseRef contains unsupported characters.');
      const previousBranch = await currentBranch(repo);
      const check = await git(repo, ['check-ref-format', '--branch', branch]);
      assertSuccess(check, 'Validate branch name');
      const args = baseRef ? ['switch', '-c', branch, baseRef] : ['switch', '-c', branch];
      const exists = await branchExists(repo, branch);

      if (exists) {
        if (!switchIfExists) {
          throw new UserFacingError(`Branch '${branch}' already exists. Call create_branch with switchIfExists enabled or use git_switch.`);
        }
        if (previousBranch !== branch) {
          const switchedExisting = await git(repo, ['switch', branch]);
          assertSuccess(switchedExisting, 'Switch to existing branch');
        }
        return result({ repo: repo.name, branch: await currentBranch(repo), previousBranch, head: await currentHead(repo), created: false });
      }

      const switched = await git(repo, args);
      assertSuccess(switched, 'Create local branch');
      return result({ repo: repo.name, branch: await currentBranch(repo), previousBranch, head: await currentHead(repo), created: true });
    },
  );

  server.registerTool(
    'git_switch',
    {
      title: 'Switch to an existing local branch',
      description: 'Use this to switch to an existing local branch. This does not create or push to any remote.',
      inputSchema: {
        repo: z.string(),
        branch: z.string().describe('Existing local branch name to switch to.'),
      },
      outputSchema: { repo: z.string(), branch: z.string(), previousBranch: z.string(), head: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ repo: repoName, branch }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(branch);
      const previousBranch = await currentBranch(repo);
      if (previousBranch === branch) {
        throw new UserFacingError(`Already on branch '${branch}'.`);
      }
      const exists = await branchExists(repo, branch);
      if (!exists) {
        throw new UserFacingError(`Branch '${branch}' does not exist. Use create_branch to create it first.`);
      }
      const switched = await git(repo, ['switch', branch]);
      assertSuccess(switched, 'Switch branch');
      return result({ repo: repo.name, branch: await currentBranch(repo), previousBranch, head: await currentHead(repo) });
    },
  );

  server.registerTool(
    'prepare_merge',
    {
      title: 'Prepare merge analysis',
      description: 'Use this to analyze if a source branch can be merged into a target branch without conflicts.',
      inputSchema: {
        repo: z.string(),
        targetBranch: z.string().describe('Branch to merge into (e.g., main).'),
        sourceBranch: z.string().describe('Branch to merge from (e.g., feature branch).'),
      },
      outputSchema: {
        repo: z.string(),
        targetBranch: z.string(),
        sourceBranch: z.string(),
        canMerge: z.boolean(),
        mergeBase: z.string(),
        ahead: z.number(),
        behind: z.number(),
        diffSummary: z.array(z.object({ path: z.string(), added: z.number(), deleted: z.number() })),
        conflicts: z.array(z.string()),
        suggestion: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, targetBranch, sourceBranch }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(targetBranch);
      validateBranchName(sourceBranch);

      const targetExists = await branchExists(repo, targetBranch);
      if (!targetExists) {
        throw new UserFacingError(`Target branch '${targetBranch}' does not exist.`);
      }

      const sourceExists = await branchExists(repo, sourceBranch);
      if (!sourceExists) {
        throw new UserFacingError(`Source branch '${sourceBranch}' does not exist.`);
      }

      const base = await mergeBase(repo, targetBranch, sourceBranch);
      const [targetHead, sourceHead] = await Promise.all([
        gitOutput(repo, ['rev-parse', targetBranch], 'Get target HEAD'),
        gitOutput(repo, ['rev-parse', sourceBranch], 'Get source HEAD'),
      ]);

      const aheadResult = await git(repo, ['rev-list', '--count', `${base}..${sourceHead.trim()}`]);
      const behindResult = await git(repo, ['rev-list', '--count', `${base}..${targetHead.trim()}`]);

      const ahead = parseInt(aheadResult.stdout.trim(), 10) || 0;
      const behind = parseInt(behindResult.stdout.trim(), 10) || 0;

      const diff = await diffSummary(repo, targetBranch, sourceBranch);

      const checkResult = await git(repo, ['merge-tree', base, targetBranch, sourceBranch]);
      const hasConflicts = checkResult.code !== 0 || checkResult.stderr.includes('CONFLICT');

      const conflicts: string[] = [];
      if (hasConflicts) {
        const conflictLines = checkResult.stdout.split(/\r?\n/).filter((line) => line.includes('CONFLICT'));
        conflicts.push(...conflictLines.slice(0, 10));
      }

      const canMerge = !hasConflicts;
      let suggestion = '';
      if (canMerge) {
        suggestion = `Branch '${sourceBranch}' can be merged into '${targetBranch}'. Use git_merge to perform the merge.`;
      } else {
        suggestion = `Merge conflict detected. Resolve conflicts manually before merging.`;
      }

      return result({
        repo: repo.name,
        targetBranch,
        sourceBranch,
        canMerge,
        mergeBase: base,
        ahead,
        behind,
        diffSummary: diff.files,
        conflicts,
        suggestion,
      });
    },
  );

  server.registerTool(
    'git_merge',
    {
      title: 'Merge a branch into current branch',
      description: 'Use this to merge a source branch into the current branch. Use prepare_merge first to check for conflicts.',
      inputSchema: {
        repo: z.string(),
        sourceBranch: z.string().describe('Branch to merge from.'),
        message: z.string().optional().describe('Optional merge commit message.'),
      },
      outputSchema: {
        repo: z.string(),
        sourceBranch: z.string(),
        targetBranch: z.string(),
        commit: z.string().nullable(),
        status: z.string(),
        conflicts: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, sourceBranch, message }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(sourceBranch);
      await ensureWritableBranch(config, repo, 'git_merge');

      const sourceExists = await branchExists(repo, sourceBranch);
      if (!sourceExists) {
        throw new UserFacingError(`Source branch '${sourceBranch}' does not exist.`);
      }

      const targetBranch = await currentBranch(repo);
      if (targetBranch === sourceBranch) {
        throw new UserFacingError(`Cannot merge branch '${sourceBranch}' into itself.`);
      }

      const args = ['merge', sourceBranch];
      if (message) {
        args.push('-m', validateCommitMessage(message));
      }

      const mergeResult = await git(repo, args, config.security.commandTimeoutMs);

      if (mergeResult.code !== 0) {
        const conflictOutput = mergeResult.stdout + mergeResult.stderr;
        const conflictLines = conflictOutput.split(/\r?\n/).filter((line) => line.includes('CONFLICT'));
        const conflicts = conflictLines.slice(0, 10);

        audit(repo, 'git_merge', false, undefined, `Merge failed: ${mergeResult.stderr}`, targetBranch);

        return result({
          repo: repo.name,
          sourceBranch,
          targetBranch,
          commit: null,
          status: `merge failed: ${mergeResult.stderr}`,
          conflicts,
        });
      }

      const commit = await currentHead(repo);
      audit(repo, 'git_merge', true, undefined, undefined, targetBranch);

      return result({
        repo: repo.name,
        sourceBranch,
        targetBranch,
        commit,
        status: 'merged',
        conflicts: [],
      });
    },
  );

  server.registerTool(
    'merge_workflow_status',
    {
      title: 'Show safe merge workflow status',
      description: 'Use this before merging to check branches, conflicts, working tree cleanliness, and protected target risk.',
      inputSchema: {
        repo: z.string(),
        targetBranch: z.string().describe('Branch to merge into.'),
        sourceBranch: z.string().describe('Branch to merge from.'),
      },
      outputSchema: {
        repo: z.string(),
        currentBranch: z.string(),
        targetBranch: z.string(),
        sourceBranch: z.string(),
        targetIsProtected: z.boolean(),
        workingTreeClean: z.boolean(),
        stagedFiles: z.array(z.string()),
        unstagedFiles: z.array(z.string()),
        untrackedFiles: z.array(z.string()),
        canMerge: z.boolean(),
        fastForward: z.boolean(),
        wouldCreateMergeCommit: z.boolean(),
        mergeBase: z.string(),
        targetHead: z.string(),
        sourceHead: z.string(),
        ahead: z.number(),
        behind: z.number(),
        diffSummary: z.array(z.object({ path: z.string(), added: z.number(), deleted: z.number() })),
        conflicts: z.array(z.string()),
        suggestions: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, targetBranch, sourceBranch }) => {
      const repo = getRepo(config, repos, repoName);
      const [current, status, analysis, targetHead, sourceHead] = await Promise.all([
        currentBranch(repo),
        gitOutput(repo, ['status', '--porcelain'], 'Get status').then(parseStatusOutput),
        analyzeMerge(repo, targetBranch, sourceBranch),
        gitOutput(repo, ['rev-parse', targetBranch], 'Get target HEAD'),
        gitOutput(repo, ['rev-parse', sourceBranch], 'Get source HEAD'),
      ]);

      const targetIsProtected = isProtectedBranch(targetBranch, config.security.protectedBranches);
      const workingTreeClean = isCleanWorkingTree(status);
      const fastForward = analysis.behind === 0;
      const wouldCreateMergeCommit = !fastForward && analysis.ahead > 0;
      const suggestions: string[] = [];

      if (!workingTreeClean) suggestions.push('Working tree is not clean. Commit or stash changes before merging.');
      if (targetIsProtected) suggestions.push('Target branch is protected. git_merge_to_target requires allowProtectedTarget=true.');
      if (!analysis.canMerge) suggestions.push('Merge conflicts detected. Resolve conflicts before running git_merge_to_target.');
      if (fastForward && analysis.canMerge && workingTreeClean) {
        suggestions.push('Fast-forward merge is possible. No merge commit will be created.');
      } else if (wouldCreateMergeCommit && analysis.canMerge && workingTreeClean) {
        suggestions.push('Merge commit will be created. Review the diff before proceeding.');
      }
      if (analysis.canMerge && workingTreeClean) suggestions.push('Merge preflight passed. Review diffSummary, then run git_merge_to_target if appropriate.');

      return result({
        repo: repo.name,
        currentBranch: current,
        targetBranch,
        sourceBranch,
        targetIsProtected,
        workingTreeClean,
        stagedFiles: status.stagedFiles,
        unstagedFiles: status.unstagedFiles,
        untrackedFiles: status.untrackedFiles,
        canMerge: analysis.canMerge,
        fastForward,
        wouldCreateMergeCommit,
        mergeBase: analysis.mergeBase,
        targetHead: targetHead.trim(),
        sourceHead: sourceHead.trim(),
        ahead: analysis.ahead,
        behind: analysis.behind,
        diffSummary: analysis.diffSummary,
        conflicts: analysis.conflicts,
        suggestions,
      });
    },
  );

  server.registerTool(
    'git_merge_to_target',
    {
      title: 'Merge source branch into target branch safely',
      description: 'Use this to switch to a target branch and merge a source branch after merge_workflow_status passes. It never pushes.',
      inputSchema: {
        repo: z.string(),
        targetBranch: z.string().describe('Branch to merge into.'),
        sourceBranch: z.string().describe('Branch to merge from.'),
        message: z.string().optional().describe('Optional merge commit message.'),
        allowProtectedTarget: z.boolean().default(false).describe('Required when targetBranch is protected, such as main or master.'),
        remote: z.string().default('origin').describe('Remote name used only to prepare a manual push command.'),
        setUpstream: z.boolean().default(true).describe('Whether the prepared push command should include -u.'),
        noFastForward: z.boolean().default(false).describe('Force a merge commit even if fast-forward is possible.'),
        restorePreviousBranch: z.boolean().default(true).describe('Switch back to the previous branch after merging.'),
      },
      outputSchema: {
        repo: z.string(),
        previousBranch: z.string(),
        currentBranch: z.string(),
        targetBranch: z.string(),
        sourceBranch: z.string(),
        commit: z.string().nullable(),
        status: z.enum(['merged', 'already_up_to_date', 'failed']),
        conflicts: z.array(z.string()),
        pushCommand: z.string(),
        warning: z.string(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, targetBranch, sourceBranch, message, allowProtectedTarget = false, remote = 'origin', setUpstream = true, noFastForward = false, restorePreviousBranch = true }) => {
      const repo = getRepo(config, repos, repoName);
      validateBranchName(targetBranch);
      validateBranchName(sourceBranch);
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new UserFacingError('Remote name contains unsupported characters.');

      const previousBranch = await currentBranch(repo);
      const targetIsProtected = isProtectedBranch(targetBranch, config.security.protectedBranches);
      if (targetIsProtected && !allowProtectedTarget) {
        throw new UserFacingError(`Target branch '${targetBranch}' is protected. Re-run with allowProtectedTarget=true after review.`);
      }

      const status = parseStatusOutput(await gitOutput(repo, ['status', '--porcelain'], 'Get status'));
      if (!isCleanWorkingTree(status)) {
        throw new UserFacingError('Working tree is not clean. Commit or stash changes before merging.');
      }

      const analysis = await analyzeMerge(repo, targetBranch, sourceBranch);
      if (!analysis.canMerge) {
        throw new UserFacingError(`Merge conflict detected: ${analysis.conflicts.join('; ') || 'unknown conflict'}`);
      }

      if (previousBranch !== targetBranch) {
        const switched = await git(repo, ['switch', targetBranch]);
        assertSuccess(switched, 'Switch to target branch');
      }

      const args = ['merge'];
      if (noFastForward) args.push('--no-ff');
      if (message) args.push('-m', validateCommitMessage(message));
      args.push(sourceBranch);
      const mergeResult = await git(repo, args, config.security.commandTimeoutMs);

      if (mergeResult.code !== 0) {
        const conflicts = `${mergeResult.stdout}\n${mergeResult.stderr}`
          .split(/\r?\n/)
          .filter((line) => line.includes('CONFLICT'))
          .slice(0, 20);
        
        if (previousBranch !== targetBranch && restorePreviousBranch) {
          await git(repo, ['switch', previousBranch]).catch(() => {});
        }
        
        audit(repo, 'git_merge_to_target', false, undefined, mergeResult.stderr, targetBranch);
        return result({
          repo: repo.name,
          previousBranch,
          currentBranch: await currentBranch(repo),
          targetBranch,
          sourceBranch,
          commit: null,
          status: 'failed',
          conflicts,
          pushCommand: '',
          warning: 'Merge failed locally. Resolve conflicts manually before pushing.',
        });
      }

      const pushArgs = ['push'];
      if (setUpstream) pushArgs.push('-u');
      pushArgs.push(remote, targetBranch);
      const pushCommand = ['git', ...pushArgs.map(shellQuote)].join(' ');
      const commit = await currentHead(repo);
      const current = await currentBranch(repo);
      
      if (previousBranch !== targetBranch && restorePreviousBranch) {
        await git(repo, ['switch', previousBranch]).catch(() => {});
      }
      
      audit(repo, 'git_merge_to_target', true, undefined, undefined, current);

      return result({
        repo: repo.name,
        previousBranch,
        currentBranch: await currentBranch(repo),
        targetBranch,
        sourceBranch,
        commit,
        status: mergeResult.stdout.includes('Already up to date') ? 'already_up_to_date' : 'merged',
        conflicts: [],
        pushCommand,
        warning: 'Local merge completed. No remote push was performed. Review status and run pushCommand manually if appropriate.',
      });
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
      await ensureWritableBranch(config, repo, 'write_file');
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
      const branch = await currentBranch(repo);
      audit(repo, 'write_file', true, [rel], undefined, branch);
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
      await ensureWritableBranch(config, repo, 'apply_patch');
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
      const branch = await currentBranch(repo);
      audit(repo, 'apply_patch', true, touchedPaths, undefined, branch);
      return result({ repo: repo.name, touchedPaths, backupPath, status: 'applied' });
    },
  );

  server.registerTool(
    'edit_file_sections',
    {
      title: 'Edit file sections using markers',
      description: 'Use this to make targeted edits to files by specifying markers and replacement content. More reliable than apply_patch for complex edits.',
      inputSchema: {
        repo: z.string(),
        path: z.string().describe('Repo-relative file path.'),
        expected_sha256: z.string().describe('sha256 returned by read_file to ensure file has not changed.'),
        edits: z.array(z.object({
          mode: z.enum(['insert_before', 'insert_after', 'replace_block']),
          marker: z.string().describe('Unique text marker to locate the edit target.'),
          content: z.string().describe('Content to insert or replace with.'),
        })).min(1).max(10),
      },
      outputSchema: {
        repo: z.string(),
        path: z.string(),
        sha256: z.string(),
        bytes: z.number(),
        backupPath: z.string().nullable(),
        replacements: z.number(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, path: relInput, expected_sha256, edits }) => {
      const repo = getRepo(config, repos, repoName);
      await ensureWritableBranch(config, repo, 'edit_file_sections');
      const rel = ensurePathAllowed(config, repo, relInput, 'write');
      const abs = path.join(repo.absPath, rel);

      if (!fs.existsSync(abs)) {
        throw new UserFacingError(`File '${rel}' does not exist. Use write_file to create it.`);
      }

      const buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
      const currentSha = sha256Buffer(buffer);

      if (expected_sha256 !== currentSha) {
        throw new UserFacingError(`sha256 mismatch for '${rel}'. Current=${currentSha}, expected=${expected_sha256}. Re-read the file before editing.`);
      }

      let content = buffer.toString('utf8');
      let totalReplacements = 0;

      for (const edit of edits) {
        const markerCount = content.split(edit.marker).length - 1;
        if (markerCount === 0) {
          throw new UserFacingError(`Marker '${edit.marker.slice(0, 50)}...' not found in '${rel}'.`);
        }
        if (markerCount > 1) {
          throw new UserFacingError(`Marker '${edit.marker.slice(0, 50)}...' appears ${markerCount} times in '${rel}'. Markers must be unique.`);
        }

        switch (edit.mode) {
          case 'insert_before': {
            content = content.replace(edit.marker, `${edit.content}${edit.marker}`);
            totalReplacements++;
            break;
          }
          case 'insert_after': {
            content = content.replace(edit.marker, `${edit.marker}${edit.content}`);
            totalReplacements++;
            break;
          }
          case 'replace_block': {
            content = content.replace(edit.marker, edit.content);
            totalReplacements++;
            break;
          }
        }
      }

      const backupPath = makeBackup(repo, [rel]);
      fs.writeFileSync(abs, content, 'utf8');
      const branch = await currentBranch(repo);
      audit(repo, 'edit_file_sections', true, [rel], undefined, branch);

      return result({
        repo: repo.name,
        path: rel,
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        backupPath,
        replacements: totalReplacements,
      });
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
      const branch = await currentBranch(repo);
      audit(repo, 'run_task', run.code === 0 && !run.timedOut, undefined, run.code !== 0 ? `Exit code: ${run.code}` : undefined, branch);
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
      await ensureWritableBranch(config, repo, 'git_add');
      const rels = paths.map((p) => ensurePathAllowed(config, repo, p, 'write'));
      const add = await git(repo, ['add', '--', ...rels]);
      assertSuccess(add, 'Stage files');
      const status = await gitOutput(repo, ['status', '--short'], 'Get git status');
      const branch = await currentBranch(repo);
      audit(repo, 'git_add', true, rels, undefined, branch);
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
      await ensureWritableBranch(config, repo, 'git_commit');
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
      const branch = await currentBranch(repo);
      audit(repo, 'git_commit', true, stagedFiles, undefined, branch);
      return result({ repo: repo.name, commit: hash, branch, message: msg, note: 'Local commit created. No remote push was performed.' });
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
      const currentBranchName = await currentBranch(repo);
      audit(repo, 'prepare_push', true, undefined, undefined, currentBranchName);
      return result({
        repo: repo.name,
        branch: targetBranch,
        remote,
        command,
        warning: 'Review git status and git diff before running this command manually. This MCP server did not push anything.',
      });
    },
  );

  server.registerTool(
    'replace_text',
    {
      title: 'Replace text in a file',
      description: 'Use this to safely replace text in a file. Only allows unique matches by default. Use replaceAll for multiple occurrences.',
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        oldText: z.string().min(1),
        newText: z.string(),
        expected_sha256: z.string().optional(),
        replaceAll: z.boolean().default(false),
      },
      outputSchema: {
        repo: z.string(),
        path: z.string(),
        sha256: z.string(),
        bytes: z.number(),
        backupPath: z.string().nullable(),
        replacements: z.number(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, path: relInput, oldText, newText, expected_sha256, replaceAll = false }) => {
      const repo = getRepo(config, repos, repoName);
      await ensureWritableBranch(config, repo, 'replace_text');
      const rel = ensurePathAllowed(config, repo, relInput, 'write');
      const abs = path.join(repo.absPath, rel);

      if (!fs.existsSync(abs)) {
        throw new UserFacingError(`File '${rel}' does not exist. Use write_file to create it.`);
      }

      const buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
      const content = buffer.toString('utf8');

      if (config.security.requireExpectedShaForOverwrite && !expected_sha256) {
        const currentSha = sha256Buffer(buffer);
        throw new UserFacingError(`expected_sha256 is required to overwrite '${rel}'. Call read_file first. Current sha256: ${currentSha}`);
      }

      if (expected_sha256) {
        const currentSha = sha256Buffer(buffer);
        if (expected_sha256 !== currentSha) {
          throw new UserFacingError(`sha256 mismatch for '${rel}'. Current=${currentSha}, expected=${expected_sha256}. Re-read the file before writing.`);
        }
      }

      const count = content.split(oldText).length - 1;
      if (count === 0) {
        throw new UserFacingError(`oldText not found in '${rel}'.`);
      }
      if (count > 1 && !replaceAll) {
        throw new UserFacingError(`oldText appears ${count} times in '${rel}'. Use replaceAll=true to replace all occurrences, or provide more specific text.`);
      }

      const newContent = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      const backupPath = makeBackup(repo, [rel]);
      fs.writeFileSync(abs, newContent, 'utf8');
      const branch = await currentBranch(repo);
      audit(repo, 'replace_text', true, [rel], undefined, branch);

      return result({
        repo: repo.name,
        path: rel,
        sha256: sha256Text(newContent),
        bytes: Buffer.byteLength(newContent, 'utf8'),
        backupPath,
        replacements: count,
      });
    },
  );

  server.registerTool(
    'replace_in_file',
    {
      title: 'Replace text in a file with multiple patterns',
      description: 'Use this to replace multiple text patterns in a file in a single operation. More efficient than multiple replace_text calls.',
      inputSchema: {
        repo: z.string(),
        path: z.string(),
        replacements: z.array(z.object({
          oldText: z.string().min(1),
          newText: z.string(),
        })).min(1).max(10),
        expected_sha256: z.string().optional(),
      },
      outputSchema: {
        repo: z.string(),
        path: z.string(),
        sha256: z.string(),
        bytes: z.number(),
        backupPath: z.string().nullable(),
        totalReplacements: z.number(),
        replacementDetails: z.array(z.object({
          oldText: z.string(),
          newText: z.string(),
          count: z.number(),
        })),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, path: relInput, replacements, expected_sha256 }) => {
      const repo = getRepo(config, repos, repoName);
      await ensureWritableBranch(config, repo, 'replace_in_file');
      const rel = ensurePathAllowed(config, repo, relInput, 'write');
      const abs = path.join(repo.absPath, rel);

      if (!fs.existsSync(abs)) {
        throw new UserFacingError(`File '${rel}' does not exist. Use write_file to create it.`);
      }

      const buffer = ensureTextFileReadable(abs, config.security.maxReadBytes);
      let content = buffer.toString('utf8');

      if (config.security.requireExpectedShaForOverwrite && !expected_sha256) {
        const currentSha = sha256Buffer(buffer);
        throw new UserFacingError(`expected_sha256 is required to overwrite '${rel}'. Call read_file first. Current sha256: ${currentSha}`);
      }

      if (expected_sha256) {
        const currentSha = sha256Buffer(buffer);
        if (expected_sha256 !== currentSha) {
          throw new UserFacingError(`sha256 mismatch for '${rel}'. Current=${currentSha}, expected=${expected_sha256}. Re-read the file before writing.`);
        }
      }

      const replacementDetails: Array<{ oldText: string; newText: string; count: number }> = [];
      let totalReplacements = 0;

      for (const replacement of replacements) {
        const count = content.split(replacement.oldText).length - 1;
        if (count === 0) {
          throw new UserFacingError(`oldText '${replacement.oldText.slice(0, 50)}...' not found in '${rel}'.`);
        }
        content = content.split(replacement.oldText).join(replacement.newText);
        replacementDetails.push({
          oldText: replacement.oldText,
          newText: replacement.newText,
          count,
        });
        totalReplacements += count;
      }

      const backupPath = makeBackup(repo, [rel]);
      fs.writeFileSync(abs, content, 'utf8');
      const branch = await currentBranch(repo);
      audit(repo, 'replace_in_file', true, [rel], undefined, branch);

      return result({
        repo: repo.name,
        path: rel,
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        backupPath,
        totalReplacements,
        replacementDetails,
      });
    },
  );

  server.registerTool(
    'validate_patch',
    {
      title: 'Validate a unified diff patch',
      description: 'Use this to check if a patch can be applied before calling apply_patch. Shows touched paths and validation errors.',
      inputSchema: { repo: z.string(), patch: z.string().min(1) },
      outputSchema: {
        repo: z.string(),
        touchedPaths: z.array(z.string()),
        allowed: z.boolean(),
        valid: z.boolean(),
        stdout: z.string(),
        stderr: z.string(),
        suggestion: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, patch }) => {
      const repo = getRepo(config, repos, repoName);
      const touchedPaths = parsePatchTouchedPaths(patch);

      if (touchedPaths.length === 0) {
        return result({
          repo: repo.name,
          touchedPaths: [],
          allowed: false,
          valid: false,
          stdout: '',
          stderr: 'Patch does not contain recognizable file paths.',
          suggestion: 'Ensure the patch contains diff --git or +++ b/ lines.',
        });
      }

      let allowed = true;
      const deniedPaths: string[] = [];
      for (const rel of touchedPaths) {
        try {
          ensurePathAllowed(config, repo, rel, 'write');
        } catch {
          allowed = false;
          deniedPaths.push(rel);
        }
      }

      let valid = false;
      let stdout = '';
      let stderr = '';
      let suggestion = '';

      try {
        const patchPath = await writeTempPatch(patch);
        const check = await git(repo, ['apply', '--check', patchPath]);
        if (check.code === 0) {
          valid = true;
          stdout = 'Patch is valid and can be applied.';
          suggestion = 'You can now call apply_patch to apply this patch.';
        } else {
          stderr = check.stderr || 'Patch validation failed.';
          suggestion = 'Check the patch format and ensure it matches the current file contents.';
        }
      } catch (err) {
        stderr = err instanceof Error ? err.message : String(err);
        suggestion = 'The patch may be corrupted or based on outdated file contents.';
      }

      if (!allowed) {
        suggestion = `Some paths are not allowed for write: ${deniedPaths.join(', ')}. Update config.yaml allowedWritePaths if needed.`;
      }

      return result({
        repo: repo.name,
        touchedPaths,
        allowed,
        valid,
        stdout,
        stderr,
        suggestion,
      });
    },
  );

  server.registerTool(
    'prepare_pr_text',
    {
      title: 'Generate PR title and body',
      description: 'Use this to generate a PR title and body based on current changes. Does not create a PR or access remote.',
      inputSchema: {
        repo: z.string(),
        title: z.string().optional(),
      },
      outputSchema: {
        title: z.string(),
        body: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, title: customTitle }) => {
      const repo = getRepo(config, repos, repoName);

      const diffSummary = await (async () => {
        const staged = (await listChangedFiles(repo, true));
        const unstaged = (await listChangedFiles(repo, false));
        const allFiles = [...new Set([...staged, ...unstaged])].filter((rel) => isAllowedReadPath(config, repo, rel));

        const args = ['diff', '--numstat', '--', ...allFiles];
        const out = await gitOutput(repo, args, 'Get diff numstat');
        const lines = out.split(/\r?\n/).filter(Boolean);

        const files: Array<{ path: string; added: number; deleted: number }> = [];
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
            const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
            files.push({ path: parts[2], added, deleted });
          }
        }
        return files;
      })();

      const branch = await currentBranch(repo);
      const defaultTitle = customTitle || `feat: update ${branch.replace('feat/', '').replace(/-/g, ' ')}`;

      const fileSummary = diffSummary
        .map((f) => `- \`${f.path}\`: +${f.added} -${f.deleted}`)
        .join('\n');

      const totalAdded = diffSummary.reduce((sum, f) => sum + f.added, 0);
      const totalDeleted = diffSummary.reduce((sum, f) => sum + f.deleted, 0);

      const body = `## Summary

${fileSummary || '- No file changes detected.'}

Total: +${totalAdded} -${totalDeleted} lines

## Test Plan

- npm run typecheck
- npm test
- npm run build

## Safety

- No git push was performed by MCP.
- Human review required before pushing.`;

      return result({ title: defaultTitle, body });
    },
  );

  server.registerTool(
    'git_workflow_status',
    {
      title: 'Show comprehensive workflow status',
      description: 'Use this to get a complete overview of the current workflow state, including branch info, pending changes, staged files, and recent commits.',
      inputSchema: { repo: z.string() },
      outputSchema: {
        repo: z.string(),
        branch: z.string(),
        head: z.string(),
        isProtected: z.boolean(),
        hasPendingChanges: z.boolean(),
        hasStagedChanges: z.boolean(),
        stagedFiles: z.array(z.string()),
        unstagedFiles: z.array(z.string()),
        untrackedFiles: z.array(z.string()),
        mcpGeneratedFiles: z.array(z.string()),
        recentCommits: z.array(z.object({
          hash: z.string(),
          message: z.string(),
          date: z.string(),
        })),
        suggestions: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName }) => {
      const repo = getRepo(config, repos, repoName);
      const branch = await currentBranch(repo);
      const head = await currentHead(repo);
      const isProtected = isProtectedBranch(branch, config.security.protectedBranches);

      const [statusOutput, logOutput] = await Promise.all([
        gitOutput(repo, ['status', '--porcelain'], 'Get status'),
        gitOutput(repo, ['log', '--oneline', '-5', '--format=%h %s %cr'], 'Get recent commits'),
      ]);

      const statusLines = statusOutput.split(/\r?\n/).filter(Boolean);
      const stagedFiles: string[] = [];
      const unstagedFiles: string[] = [];
      const untrackedFiles: string[] = [];
      const mcpGeneratedFiles: string[] = [];

      for (const line of statusLines) {
        const statusCode = line.slice(0, 2).trim();
        const filePath = line.slice(3).trim();

        if (filePath.startsWith('.chatgpt-git-mcp/') || filePath.startsWith('.chatgpt-git-mcp\\')) {
          mcpGeneratedFiles.push(filePath);
          continue;
        }

        if (statusCode.includes('?')) {
          untrackedFiles.push(filePath);
        } else {
          if (statusCode[0] !== ' ' && statusCode[0] !== '?') {
            stagedFiles.push(filePath);
          }
          if (statusCode[1] !== ' ' && statusCode[1] !== '?') {
            unstagedFiles.push(filePath);
          }
        }
      }

      const recentCommits = logOutput.split(/\r?\n/).filter(Boolean).map((line) => {
        const parts = line.split(' ');
        return {
          hash: parts[0] || '',
          message: parts.slice(1, -1).join(' ') || '',
          date: parts[parts.length - 1] || '',
        };
      });

      const hasPendingChanges = unstagedFiles.length > 0 || untrackedFiles.length > 0;
      const hasStagedChanges = stagedFiles.length > 0;

      const suggestions: string[] = [];
      if (isProtected) {
        suggestions.push('Current branch is protected. Create a feature branch for changes.');
      }
      if (hasPendingChanges && !hasStagedChanges) {
        suggestions.push('You have pending changes. Use git_add to stage files before committing.');
      }
      if (hasStagedChanges) {
        suggestions.push('You have staged changes. Use git_commit to create a commit.');
      }
      if (!hasPendingChanges && !hasStagedChanges) {
        suggestions.push('Working directory is clean. Ready for new changes.');
      }

      return result({
        repo: repo.name,
        branch,
        head,
        isProtected,
        hasPendingChanges,
        hasStagedChanges,
        stagedFiles,
        unstagedFiles,
        untrackedFiles,
        mcpGeneratedFiles,
        recentCommits,
        suggestions,
      });
    },
  );

  server.registerTool(
    'git_diff_summary',
    {
      title: 'Show structured diff summary',
      description: 'Use this to get a structured summary of changes (lines added/deleted) before committing.',
      inputSchema: {
        repo: z.string(),
        staged: z.boolean().default(false),
        paths: z.array(z.string()).default([]),
      },
      outputSchema: {
        repo: z.string(),
        files: z.array(z.object({
          path: z.string(),
          added: z.number(),
          deleted: z.number(),
        })),
        riskHints: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName, staged = false, paths = [] }) => {
      const repo = getRepo(config, repos, repoName);
      const selectedFiles = paths.length
        ? paths.map((p) => ensurePathAllowed(config, repo, p, 'read'))
        : (await listChangedFiles(repo, staged)).filter((rel) => isAllowedReadPath(config, repo, rel));

      if (selectedFiles.length === 0) {
        return result({ repo: repo.name, files: [], riskHints: ['No changes detected.'] });
      }

      const args = staged ? ['diff', '--cached', '--numstat', '--', ...selectedFiles] : ['diff', '--numstat', '--', ...selectedFiles];
      const out = await gitOutput(repo, args, 'Get diff numstat');
      const lines = out.split(/\r?\n/).filter(Boolean);

      const files: Array<{ path: string; added: number; deleted: number }> = [];
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
          const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
          files.push({ path: parts[2], added, deleted });
        }
      }

      const riskHints: string[] = [];
      riskHints.push('No remote operation detected.');
      riskHints.push('No denied path modified.');

      const hasLargeChange = files.some((f) => f.added + f.deleted > 500);
      if (hasLargeChange) {
        riskHints.push('Large changes detected. Review carefully before committing.');
      }

      riskHints.push('Review changes before git_add/git_commit.');

      return result({ repo: repo.name, files, riskHints });
    },
  );

  server.registerTool(
    'list_backups',
    {
      title: 'List backups for a repo',
      description: 'Use this to see available backups before calling restore_backup.',
      inputSchema: { repo: z.string() },
      outputSchema: {
        repo: z.string(),
        backups: z.array(z.object({
          id: z.string(),
          path: z.string(),
          files: z.array(z.string()),
        })),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo: repoName }) => {
      const repo = getRepo(config, repos, repoName);
      const backupRoot = path.join(repo.absPath, '.chatgpt-git-mcp', 'backups');
      const backups: Array<{ id: string; path: string; files: string[] }> = [];

      if (!fs.existsSync(backupRoot)) {
        return result({ repo: repo.name, backups });
      }

      const entries = fs.readdirSync(backupRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const backupPath = path.join(backupRoot, entry.name);
        const files = walkFiles(config, repo, path.join('.chatgpt-git-mcp', 'backups', entry.name), 1000);
        backups.push({
          id: entry.name,
          path: path.join('.chatgpt-git-mcp', 'backups', entry.name),
          files,
        });
      }

      backups.sort((a, b) => b.id.localeCompare(a.id));
      return result({ repo: repo.name, backups });
    },
  );

  server.registerTool(
    'restore_backup',
    {
      title: 'Restore files from a backup',
      description: 'Use this to restore files from a previous backup. Current files will be backed up first.',
      inputSchema: {
        repo: z.string(),
        backupId: z.string(),
        paths: z.array(z.string()).optional(),
      },
      outputSchema: {
        repo: z.string(),
        restoredPaths: z.array(z.string()),
        backupPath: z.string().nullable(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async ({ repo: repoName, backupId, paths }) => {
      const repo = getRepo(config, repos, repoName);

      if (backupId.includes('..') || backupId.includes('/') || backupId.includes('\\')) {
        throw new UserFacingError('Invalid backupId: path traversal is not allowed.');
      }

      const backupDir = path.join(repo.absPath, '.chatgpt-git-mcp', 'backups', backupId);
      if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) {
        throw new UserFacingError(`Backup '${backupId}' not found.`);
      }

      const filesToRestore = paths ?? walkFiles(config, repo, path.join('.chatgpt-git-mcp', 'backups', backupId), 1000);

      for (const rel of filesToRestore) {
        const normalized = rel.replace(/^\.chatgpt-git-mcp\/backups\/[^/]+\//, '');
        try {
          ensurePathAllowed(config, repo, normalized, 'write');
        } catch {
          throw new UserFacingError(`Cannot restore '${normalized}': path not allowed for write.`);
        }
      }

      const currentFiles = filesToRestore.map((rel) => rel.replace(/^\.chatgpt-git-mcp\/backups\/[^/]+\//, ''));
      const backupPath = makeBackup(repo, currentFiles);

      for (const rel of filesToRestore) {
        const normalized = rel.replace(/^\.chatgpt-git-mcp\/backups\/[^/]+\//, '');
        const src = path.join(repo.absPath, rel);
        const dst = path.join(repo.absPath, normalized);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      }

      const branch = await currentBranch(repo);
      audit(repo, 'restore_backup', true, currentFiles, undefined, branch);

      return result({
        repo: repo.name,
        restoredPaths: currentFiles,
        backupPath,
      });
    },
  );

  return server;
}
