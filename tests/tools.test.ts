import test from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedBranch } from '../src/tools.js';

test('isProtectedBranch identifies protected branches', () => {
  const protectedBranches = ['main', 'master'];
  assert.equal(isProtectedBranch('main', protectedBranches), true);
  assert.equal(isProtectedBranch('master', protectedBranches), true);
  assert.equal(isProtectedBranch('feature/test', protectedBranches), false);
  assert.equal(isProtectedBranch('feat/my-feature', protectedBranches), false);
});

test('isProtectedBranch handles empty array', () => {
  assert.equal(isProtectedBranch('main', []), false);
});

test('isProtectedBranch handles multiple protected branches', () => {
  const protectedBranches = ['main', 'master', 'production', 'release'];
  assert.equal(isProtectedBranch('main', protectedBranches), true);
  assert.equal(isProtectedBranch('production', protectedBranches), true);
  assert.equal(isProtectedBranch('develop', protectedBranches), false);
});