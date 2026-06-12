import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTERED_TOOL_NAMES } from '../src/tools.js';

test('REGISTERED_TOOL_NAMES includes branch workflow tools', () => {
  assert.ok(REGISTERED_TOOL_NAMES.includes('list_branches'), 'list_branches should be registered');
  assert.ok(REGISTERED_TOOL_NAMES.includes('ensure_branch'), 'ensure_branch should be registered');
});

test('list_branches is registered before ensure_branch', () => {
  const listIndex = REGISTERED_TOOL_NAMES.indexOf('list_branches');
  const ensureIndex = REGISTERED_TOOL_NAMES.indexOf('ensure_branch');
  assert.ok(listIndex < ensureIndex, 'list_branches should come before ensure_branch');
});

test('REGISTERED_TOOL_NAMES has correct count after adding branch tools', () => {
  assert.ok(REGISTERED_TOOL_NAMES.length >= 32, 'Should have at least 32 tools registered');
});

test('branch workflow tools are in the correct position', () => {
  const configStatusIndex = REGISTERED_TOOL_NAMES.indexOf('config_status');
  const listBranchesIndex = REGISTERED_TOOL_NAMES.indexOf('list_branches');
  const ensureBranchIndex = REGISTERED_TOOL_NAMES.indexOf('ensure_branch');
  const listReposIndex = REGISTERED_TOOL_NAMES.indexOf('list_repos');
  
  assert.ok(configStatusIndex < listBranchesIndex, 'config_status should come before list_branches');
  assert.ok(listBranchesIndex < ensureBranchIndex, 'list_branches should come before ensure_branch');
  assert.ok(ensureBranchIndex < listReposIndex, 'ensure_branch should come before list_repos');
});
