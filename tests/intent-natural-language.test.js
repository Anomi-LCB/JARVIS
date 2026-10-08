import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionType } from '../packages/shared/src/types.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { LocalSemanticIntentAdapter } from '../packages/core/src/intent/semantic-intent-adapter.js';

test('a modified-file listing request remains read-only instead of becoming an edit', () => {
  const command = '작업 폴더에서 최근 수정한 파일을 보여줘';
  const parser = new IntentParser();

  assert.equal(parser.parse(command).actionType, ActionType.LIST_FILES);
  assert.equal(new LocalSemanticIntentAdapter({ parser }).parse(command).actionType, ActionType.LIST_FILES);
});

test('an explicit request to change document content remains an edit', () => {
  const command = '프로젝트.xlsx 파일의 합계 셀 값을 수정해줘';
  const parser = new IntentParser();

  assert.equal(parser.parse(command).actionType, ActionType.EDIT_DOCUMENT);
  assert.equal(new LocalSemanticIntentAdapter({ parser }).parse(command).actionType, ActionType.EDIT_DOCUMENT);
});

test('a named text file creation stays a single local create intent', () => {
  const command = 'frontier-ui-proof-20260819.txt 파일을 만들어줘';
  const parser = new IntentParser();

  for (const parsed of [parser.parse(command), new LocalSemanticIntentAdapter({ parser }).parse(command)]) {
    assert.equal(parsed.actionType, ActionType.CREATE_FILE);
    assert.equal(parsed.slots.fileName, 'frontier-ui-proof-20260819.txt');
    assert.deepEqual(parsed.complexity.matchedActionTypes, [ActionType.CREATE_FILE]);
    assert.equal(parsed.complexity.needsPlanDecomposition, false);
  }
});

test('a file creation request that says to save its contents is not treated as macro storage', () => {
  const command = 'workspace/natural-command-note.txt 파일을 새로 만들어 내용은 "JARVIS 실행 확인"으로 저장해줘';
  const parser = new IntentParser();

  for (const parsed of [parser.parse(command), new LocalSemanticIntentAdapter({ parser }).parse(command)]) {
    assert.equal(parsed.actionType, ActionType.CREATE_FILE);
    assert.equal(parsed.slots.fileName, 'natural-command-note.txt');
    assert.equal(parsed.complexity.matchedActionTypes.includes(ActionType.MACRO_SAVE), false);
  }
});

test('a named file only becomes an open intent when an open verb is present', () => {
  const command = 'frontier-ui-proof-20260819.txt 파일을 열어줘';
  const parser = new IntentParser();
  const parsed = parser.parse(command);

  assert.equal(parsed.actionType, ActionType.SHELL_EXECUTE);
  assert.deepEqual(parsed.complexity.matchedActionTypes, [ActionType.SHELL_EXECUTE]);
  assert.equal(parsed.complexity.needsPlanDecomposition, false);
});

test('an API format query parameter never becomes a destructive disk-format intent', () => {
  const command = 'PowerShell로 wttr.in API(https://wttr.in/Seoul?format=j1)를 호출해 이번 주 날씨 데이터를 JSON으로 수집하라';
  const parser = new IntentParser();

  for (const parsed of [parser.parse(command), new LocalSemanticIntentAdapter({ parser }).parse(command)]) {
    assert.equal(parsed.actionType, ActionType.SHELL_EXECUTE);
    assert.equal(parsed.complexity.matchedActionTypes.includes(ActionType.DELETE_FILE), false);
  }
});

test('real disk format commands remain destructive', () => {
  const parser = new IntentParser();

  assert.equal(parser.parse('USB 드라이브를 포맷해줘').actionType, ActionType.DELETE_FILE);
  assert.equal(parser.parse('format E:').actionType, ActionType.DELETE_FILE);
});
