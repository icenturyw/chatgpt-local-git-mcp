import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig, RepoRuntime } from './types.js';

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function wildcardToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern).replace(/^\.\//, '');
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else {
      out += escapeRegex(char);
    }
  }
  out += '$';
  return new RegExp(out);
}

function matchesPattern(relPath: string, pattern: string): boolean {
  const rel = toPosix(relPath).replace(/^\.\//, '');
  const raw = toPosix(pattern.trim()).replace(/^\.\//, '').replace(/\/$/, '');
  if (!raw || raw === '.') return true;
  if (raw.includes('*')) return wildcardToRegExp(raw).test(rel);
  return rel === raw || rel.startsWith(`${raw}/`);
}

export function resolveRepo(repos: RepoRuntime[], repoName: string): RepoRuntime {
  const repo = repos.find((item) => item.name === repoName);
  if (!repo) {
    throw new UserFacingError(`Unknown repo '${repoName}'. Call list_repos first.`);
  }
  if (!fs.existsSync(repo.absPath)) {
    throw new UserFacingError(`Repo '${repoName}' path does not exist: ${repo.absPath}`);
  }
  if (!fs.existsSync(path.join(repo.absPath, '.git'))) {
    throw new UserFacingError(`Repo '${repoName}' path is not a Git working copy: ${repo.absPath}`);
  }
  return repo;
}

export function normalizeRelativePath(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new UserFacingError('Path is required.');
  }
  if (input.includes('\0')) {
    throw new UserFacingError('Path contains a null byte.');
  }
  if (path.isAbsolute(input)) {
    throw new UserFacingError('Absolute paths are not allowed. Use a path relative to the repo root.');
  }
  const normalized = toPosix(path.posix.normalize(toPosix(input))).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new UserFacingError('Path traversal is not allowed.');
  }
  return normalized === '.' ? '.' : normalized;
}

export function ensurePathAllowed(
  config: AppConfig,
  repo: RepoRuntime,
  relInput: string,
  mode: 'read' | 'write',
): string {
  const rel = normalizeRelativePath(relInput);
  const denied = [...config.security.globalDeniedPaths, ...(repo.deniedPaths ?? [])];
  for (const pattern of denied) {
    if (matchesPattern(rel, pattern)) {
      throw new UserFacingError(`Access denied by deniedPaths rule '${pattern}' for '${rel}'.`);
    }
  }

  const allowed = mode === 'read' ? (repo.allowedReadPaths ?? ['.']) : (repo.allowedWritePaths ?? []);
  if (allowed.length === 0 || !allowed.some((pattern) => matchesPattern(rel, pattern))) {
    throw new UserFacingError(`Path '${rel}' is not allowed for ${mode}. Update config.yaml allowed${mode === 'read' ? 'Read' : 'Write'}Paths if needed.`);
  }

  const abs = path.resolve(repo.absPath, rel);
  const relativeFromRoot = path.relative(repo.absPath, abs);
  if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
    throw new UserFacingError('Resolved path escapes repo root.');
  }
  return rel;
}

export function ensureTextFileReadable(absPath: string, maxBytes: number): Buffer {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new UserFacingError('Path is not a regular file.');
  }
  if (stat.size > maxBytes) {
    throw new UserFacingError(`File is too large (${stat.size} bytes). Limit is ${maxBytes} bytes.`);
  }
  const buffer = fs.readFileSync(absPath);
  if (buffer.includes(0)) {
    throw new UserFacingError('Binary files are not readable through this MCP server.');
  }
  return buffer;
}

export function makeBackup(repo: RepoRuntime, relPaths: string[]): string | null {
  const existing = relPaths.filter((rel) => {
    const abs = path.join(repo.absPath, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  });
  if (existing.length === 0) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(repo.absPath, '.chatgpt-git-mcp', 'backups', stamp);
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const rel of existing) {
    const src = path.join(repo.absPath, rel);
    const dst = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return path.relative(repo.absPath, backupRoot).replace(/\\/g, '/');
}

export function parsePatchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('+++ b/')) paths.add(normalizeRelativePath(line.slice(6).trim()));
    if (line.startsWith('--- a/')) paths.add(normalizeRelativePath(line.slice(6).trim()));
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*?) b\/(.*?)$/.exec(line);
      if (match) {
        paths.add(normalizeRelativePath(match[1]));
        paths.add(normalizeRelativePath(match[2]));
      }
    }
  }
  return [...paths].filter((p) => p !== '/dev/null' && p !== 'dev/null');
}
