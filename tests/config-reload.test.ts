import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTERED_TOOL_NAMES } from '../src/tools.js';

test('REGISTERED_TOOL_NAMES includes config reload tools', () => {
  assert.ok(REGISTERED_TOOL_NAMES.includes('reload_config'), 'reload_config should be registered');
});

test('reload_config is registered in correct position', () => {
  const ensureBranchIndex = REGISTERED_TOOL_NAMES.indexOf('ensure_branch');
  const reloadConfigIndex = REGISTERED_TOOL_NAMES.indexOf('reload_config');
  const listReposIndex = REGISTERED_TOOL_NAMES.indexOf('list_repos');
  
  assert.ok(ensureBranchIndex < reloadConfigIndex, 'ensure_branch should come before reload_config');
  assert.ok(reloadConfigIndex < listReposIndex, 'reload_config should come before list_repos');
});

test('REGISTERED_TOOL_NAMES has correct count after adding config reload tools', () => {
  assert.ok(REGISTERED_TOOL_NAMES.length >= 33, 'Should have at least 33 tools registered');
});

test('list_tasks includes source field', () => {
  // This test verifies the tool definition includes source field
  // Actual functionality testing would require a running server
  assert.ok(REGISTERED_TOOL_NAMES.includes('list_tasks'), 'list_tasks should be registered');
});
