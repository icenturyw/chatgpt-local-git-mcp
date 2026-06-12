import test from 'node:test';
import assert from 'node:assert/strict';

import { ensurePathAllowed, normalizeRelativePath, parsePatchTouchedPaths } from '../src/security.js';
import { buildRepoTreeGitArgs } from '../src/tools.js';
import type { AppConfig, RepoRuntime } from '../src/types.js';

test('normalizeRelativePath normalizes safe relative paths', () => {
  assert.equal(normalizeRelativePath('./src/../src/tools.ts'), 'src/tools.ts');
});

test('normalizeRelativePath rejects path traversal', () => {
  assert.throws(() => normalizeRelativePath('../secrets.env'), /Path traversal is not allowed/);
});

test('parsePatchTouchedPaths returns modified file paths', () => {
  const patch = [
    'diff --git a/src/tools.ts b/src/tools.ts',
    '--- a/src/tools.ts',
    '+++ b/src/tools.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');

  assert.deepEqual(parsePatchTouchedPaths(patch), ['src/tools.ts']);
});

test('parsePatchTouchedPaths ignores /dev/null for created files', () => {
  const patch = ['--- /dev/null', '+++ b/tests/new.test.ts'].join('\n');

  assert.deepEqual(parsePatchTouchedPaths(patch), ['tests/new.test.ts']);
});

test('buildRepoTreeGitArgs uses dot pathspec for repo root', () => {
  assert.deepEqual(buildRepoTreeGitArgs('.'), ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.']);
});

const appConfig: AppConfig = {
  server: {
    host: '127.0.0.1',
    port: 3000,
    mcpPath: '/mcp',
    maxRequestBodyBytes: 1024,
  },
  security: {
    requireExpectedShaForOverwrite: true,
    maxReadBytes: 1024,
    maxWriteBytes: 1024,
    commandTimeoutMs: 1000,
    globalDeniedPaths: [
      '.env',
      '.env.*',
      '**/.env',
      '**/.env.*',
      '*.pem',
      '**/*.pem',
      'secrets',
      'secrets/**',
      '**/secrets/**',
    ],
    protectedBranches: ['main'],
  },
  repos: {},
};

const repo: RepoRuntime = {
  name: 'demo',
  path: '/tmp/demo',
  absPath: '/tmp/demo',
  allowedReadPaths: ['.'],
  allowedWritePaths: ['.'],
  deniedPaths: [],
  allowedTasks: {},
};

test('ensurePathAllowed denies sensitive files in nested directories', () => {
  assert.throws(() => ensurePathAllowed(appConfig, repo, 'apps/api/.env', 'read'), /Access denied/);
  assert.throws(() => ensurePathAllowed(appConfig, repo, 'apps/api/.env.production', 'write'), /Access denied/);
  assert.throws(() => ensurePathAllowed(appConfig, repo, 'certs/prod/server.pem', 'read'), /Access denied/);
  assert.throws(() => ensurePathAllowed(appConfig, repo, 'apps/api/secrets/token.txt', 'write'), /Access denied/);
});

test('ensurePathAllowed allows ordinary nested source files', () => {
  assert.equal(ensurePathAllowed(appConfig, repo, 'apps/api/src/index.ts', 'read'), 'apps/api/src/index.ts');
});
