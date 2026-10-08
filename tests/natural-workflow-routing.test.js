import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommandLane } from '../packages/shared/src/command-lane.js';

test('explicit data-processing clauses enter the mission lane before task planning', () => {
  for (const command of [
    "'입력.json' JSON을 '자료'로 읽고; '자료'를 '결과.json' JSON으로 저장해",
    "1250 'm'를 'km'로 변환해 '거리'로 만들고; '거리'를 '거리.json' JSON으로 저장해",
    "'자료'에서 필드 '이름'만 추출해 '목록'으로 만들고； '목록'의 행 수가 5인지 검증해",
    '파일을 읽고\n값을 계산하고\n결과를 저장해'
  ]) assert.equal(classifyCommandLane(command).lane, 'mission', command);
});

test('separators inside a quoted note do not invent workflow steps', () => {
  for (const command of [
    '메모 파일 하나 만들어줘',
    "메모 파일에 '읽고; 계산하고; 저장해'라고 적어줘",
    '메모 파일에 “읽고； 계산하고”라고 적어줘'
  ]) assert.equal(classifyCommandLane(command).lane, 'task', command);
});
