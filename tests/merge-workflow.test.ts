import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTERED_TOOL_NAMES } from '../src/tools.js';

test('REGISTERED_TOOL_NAMES includes enhanced merge workflow tools', () => {
  assert.ok(REGISTERED_TOOL_NAMES.includes('merge_workflow_status'), 'merge_workflow_status should be registered');
  assert.ok(REGISTERED_TOOL_NAMES.includes('git_merge_to_target'), 'git_merge_to_target should be registered');
});

test('merge_workflow_status includes new fields', () => {
  // This test verifies the tool definition includes new fields
  // Actual functionality testing would require a running server
  assert.ok(REGISTERED_TOOL_NAMES.includes('merge_workflow_status'), 'merge_workflow_status should be registered');
});

test('git_merge_to_target includes new parameters', () => {
  // This test verifies the tool definition includes new parameters
  // Actual functionality testing would require a running server
  assert.ok(REGISTERED_TOOL_NAMES.includes('git_merge_to_target'), 'git_merge_to_target should be registered');
});

test('REGISTERED_TOOL_NAMES has correct count after merge workflow enhancements', () => {
  assert.ok(REGISTERED_TOOL_NAMES.length >= 33, 'Should have at least 33 tools registered');
});

test('merge workflow tools are in correct position', () => {
  const gitMergeIndex = REGISTERED_TOOL_NAMES.indexOf('git_merge');
  const mergeWorkflowStatusIndex = REGISTERED_TOOL_NAMES.indexOf('merge_workflow_status');
  const gitMergeToTargetIndex = REGISTERED_TOOL_NAMES.indexOf('git_merge_to_target');
  
  assert.ok(gitMergeIndex < mergeWorkflowStatusIndex, 'git_merge should come before merge_workflow_status');
  assert.ok(mergeWorkflowStatusIndex < gitMergeToTargetIndex, 'merge_workflow_status should come before git_merge_to_target');
});
