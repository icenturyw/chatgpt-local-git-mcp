import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inferAllowedTasks } from '../src/config.js';

function makeTempRepo(packageJson: unknown, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-local-git-mcp-config-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
  for (const [filePath, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filePath), content, 'utf8');
  }
  return dir;
}

test('inferAllowedTasks detects common package scripts', () => {
  const repoPath = makeTempRepo({
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'node --test',
      build: 'tsc -p tsconfig.json',
      lint: 'eslint .',
    },
  });

  assert.deepEqual(Object.keys(inferAllowedTasks(repoPath)).sort(), ['build', 'test', 'typecheck']);
});

test('inferAllowedTasks uses npm commands by default', () => {
  const repoPath = makeTempRepo({ scripts: { typecheck: 'tsc', test: 'node --test', build: 'tsc' } });
  const tasks = inferAllowedTasks(repoPath);

  assert.deepEqual(tasks.typecheck.command, ['npm', 'run', 'typecheck']);
  assert.deepEqual(tasks.test.command, ['npm', 'test']);
  assert.deepEqual(tasks.build.command, ['npm', 'run', 'build']);
});

test('inferAllowedTasks detects pnpm lockfile', () => {
  const repoPath = makeTempRepo({ scripts: { test: 'vitest' } }, { 'pnpm-lock.yaml': '' });
  const tasks = inferAllowedTasks(repoPath);

  assert.deepEqual(tasks.test.command, ['pnpm', 'run', 'test']);
});

test('inferAllowedTasks returns empty tasks without package scripts', () => {
  const repoPath = makeTempRepo({ name: 'empty' });

  assert.deepEqual(inferAllowedTasks(repoPath), {});
});
