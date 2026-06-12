import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTERED_TOOL_NAMES } from '../src/tools.js';

test('REGISTERED_TOOL_NAMES includes introspection tools', () => {
  assert.ok(REGISTERED_TOOL_NAMES.includes('list_registered_tools'), 'list_registered_tools should be registered');
  assert.ok(REGISTERED_TOOL_NAMES.includes('config_status'), 'config_status should be registered');
});

test('REGISTERED_TOOL_NAMES has correct count', () => {
  assert.ok(REGISTERED_TOOL_NAMES.length >= 30, 'Should have at least 30 tools registered');
});

test('list_registered_tools is first in the list', () => {
  assert.equal(REGISTERED_TOOL_NAMES[0], 'list_registered_tools');
});

test('config_status is second in the list', () => {
  assert.equal(REGISTERED_TOOL_NAMES[1], 'config_status');
});

test('REGISTERED_TOOL_NAMES contains all expected tools', () => {
  const expectedTools = [
    'list_registered_tools',
    'config_status',
    'list_repos',
    'list_tasks',
    'repo_tree',
    'read_file',
    'search_code',
    'git_status',
    'git_diff',
    'create_branch',
    'git_switch',
    'merge_workflow_status',
    'git_merge_to_target',
    'write_file',
    'apply_patch',
    'run_task',
    'git_add',
    'git_commit',
    'prepare_push',
  ] as const;
  
  for (const tool of expectedTools) {
    assert.ok(REGISTERED_TOOL_NAMES.includes(tool), `Tool '${tool}' should be registered`);
  }
});
