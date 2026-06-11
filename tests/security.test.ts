import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRelativePath, parsePatchTouchedPaths } from '../src/security.js';
import { buildRepoTreeGitArgs } from '../src/tools.js';

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
