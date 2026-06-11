import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoRuntime } from './types.js';
import { UserFacingError } from './security.js';

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function git(repo: RepoRuntime, args: string[], timeoutMs?: number): Promise<CommandResult> {
  return runCommand(repo.absPath, 'git', args, timeoutMs);
}

export function assertSuccess(result: CommandResult, action: string): void {
  if (result.timedOut) throw new UserFacingError(`${action} timed out. stderr: ${result.stderr}`);
  if (result.code !== 0) {
    const message = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new UserFacingError(`${action} failed. ${message}`.trim());
  }
}

export async function gitOutput(repo: RepoRuntime, args: string[], action: string, timeoutMs?: number): Promise<string> {
  const result = await git(repo, args, timeoutMs);
  assertSuccess(result, action);
  return result.stdout;
}

export async function currentBranch(repo: RepoRuntime): Promise<string> {
  const out = await gitOutput(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 'Get current branch');
  return out.trim();
}

export async function currentHead(repo: RepoRuntime): Promise<string> {
  const out = await gitOutput(repo, ['rev-parse', '--short', 'HEAD'], 'Get current HEAD');
  return out.trim();
}

export function validateBranchName(branch: string): void {
  if (!branch || branch.length > 200) throw new UserFacingError('Invalid branch name length.');
  if (/\s/.test(branch)) throw new UserFacingError('Branch name cannot contain whitespace.');
  if (branch.startsWith('-')) throw new UserFacingError('Branch name cannot start with dash.');
  if (branch.includes('..') || branch.includes('~') || branch.includes('^') || branch.includes(':')) {
    throw new UserFacingError('Branch name contains unsafe Git ref characters.');
  }
}

export function validateCommitMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length < 3) throw new UserFacingError('Commit message is too short.');
  if (trimmed.length > 500) throw new UserFacingError('Commit message is too long.');
  return trimmed;
}

export async function writeTempPatch(patch: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-git-mcp-'));
  const patchPath = path.join(dir, 'change.patch');
  fs.writeFileSync(patchPath, patch, 'utf8');
  return patchPath;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function listBranches(repo: RepoRuntime, pattern?: string): Promise<string[]> {
  const args = ['branch', '--list'];
  if (pattern) args.push(pattern);
  const out = await gitOutput(repo, args, 'List branches');
  return out.split(/\r?\n/).map((line) => line.replace(/^\*\s+/, '').trim()).filter(Boolean);
}

export async function branchExists(repo: RepoRuntime, branch: string): Promise<boolean> {
  const result = await git(repo, ['rev-parse', '--verify', branch]);
  return result.code === 0;
}

export async function mergeBase(repo: RepoRuntime, commit1: string, commit2: string): Promise<string> {
  const out = await gitOutput(repo, ['merge-base', commit1, commit2], 'Find merge base');
  return out.trim();
}

export async function diffSummary(repo: RepoRuntime, from: string, to: string): Promise<{ files: Array<{ path: string; added: number; deleted: number }> }> {
  const out = await gitOutput(repo, ['diff', '--numstat', `${from}...${to}`], 'Get diff summary');
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

  return { files };
}
