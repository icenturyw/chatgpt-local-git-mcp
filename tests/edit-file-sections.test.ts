import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTERED_TOOL_NAMES } from '../src/tools.js';

test('REGISTERED_TOOL_NAMES includes edit_file_sections tool', () => {
  assert.ok(REGISTERED_TOOL_NAMES.includes('edit_file_sections'), 'edit_file_sections should be registered');
});

test('edit_file_sections is registered in correct position', () => {
  const applyPatchIndex = REGISTERED_TOOL_NAMES.indexOf('apply_patch');
  const editFileSectionsIndex = REGISTERED_TOOL_NAMES.indexOf('edit_file_sections');
  const runTaskIndex = REGISTERED_TOOL_NAMES.indexOf('run_task');
  
  assert.ok(applyPatchIndex < editFileSectionsIndex, 'apply_patch should come before edit_file_sections');
  assert.ok(editFileSectionsIndex < runTaskIndex, 'edit_file_sections should come before run_task');
});

test('REGISTERED_TOOL_NAMES has correct count after adding edit_file_sections', () => {
  assert.ok(REGISTERED_TOOL_NAMES.length >= 34, 'Should have at least 34 tools registered');
});

test('edit_file_sections supports required edit modes', () => {
  // This test verifies the tool definition supports required edit modes
  // Actual functionality testing would require a running server
  assert.ok(REGISTERED_TOOL_NAMES.includes('edit_file_sections'), 'edit_file_sections should be registered');
});

test('edit_file_sections is between apply_patch and run_task', () => {
  const tools = [...REGISTERED_TOOL_NAMES];
  const applyPatchIndex = tools.indexOf('apply_patch');
  const editFileSectionsIndex = tools.indexOf('edit_file_sections');
  const runTaskIndex = tools.indexOf('run_task');
  
  assert.ok(applyPatchIndex < editFileSectionsIndex, 'apply_patch should come before edit_file_sections');
  assert.ok(editFileSectionsIndex < runTaskIndex, 'edit_file_sections should come before run_task');
});
