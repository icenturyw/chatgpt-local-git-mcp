import test from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedBranch, REGISTERED_TOOL_NAMES } from '../src/tools.js';

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

test('REGISTERED_TOOL_NAMES includes high-level merge tools', () => {
  assert.equal(REGISTERED_TOOL_NAMES.includes('merge_workflow_status'), true);
  assert.equal(REGISTERED_TOOL_NAMES.includes('git_merge_to_target'), true);
});

test('REGISTERED_TOOL_NAMES includes read_project_context after repo_tree', () => {
  assert.equal(REGISTERED_TOOL_NAMES.includes('read_project_context'), true);
  assert.equal(REGISTERED_TOOL_NAMES.indexOf('read_project_context'), REGISTERED_TOOL_NAMES.indexOf('repo_tree') + 1);
  assert.equal(REGISTERED_TOOL_NAMES.indexOf('read_file'), REGISTERED_TOOL_NAMES.indexOf('read_project_context') + 1);
});
