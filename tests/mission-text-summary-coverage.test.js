import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalContract } from '../packages/core/src/mission/goal-contract.js';
import { assessTextSummarySequence } from '../packages/core/src/mission/mission-text-summary-coverage.js';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-summary-coverage-'));
  try {
    const source = '회의 시간 10시, 인쇄물 12부, 장소 본당.';
    const output = '본당 10시 회의에 인쇄물 12부 준비.';
    writeFileSync(join(root, 'source.txt'), source);
    writeFileSync(join(root, 'summary.txt'), output);
    const objective = "'source.txt'를 읽고 핵심을 요약해 'summary.txt'로 저장해줘";
    const actions = ['read', 'write'].map((kind, i) => {
      const tool = i ? 'filesystem.createTextFile' : 'filesystem.readText';
      return { actionId: kind, taskId: `task-${kind}`, observationId: `observation-${kind}`, status: 'succeeded', actualToolName: tool,
        operation: { dispatch: { taskId: `task-${kind}`, toolName: tool,
          arguments: { path: join(root, i ? 'summary.txt' : 'source.txt') }, dispatchedAt: `2026-09-27T10:00:0${i * 2}.000Z` } } };
    });
    const mission = { goalContract: createGoalContract({ objective }), waves: [{ actions }],
      successCriteria: [{ criterionId: 'summary', verificationSpec: { version: 1, kind: 'text.equals', path: 'summary.txt', equals: output } }],
      observations: [{ observationId: 'observation-read', createdAt: '2026-09-27T10:00:01.000Z',
        data: { readExtent: { offset: 0, returnedChars: source.length, bytes: Buffer.byteLength(source), truncated: false, encoding: 'utf8' } } }] };
    const files = new Map([['read', [{ path: join(root, 'source.txt'), sha256: sha(source) }]],
      ['write', [{ path: join(root, 'summary.txt'), sha256: sha(output) }]]]);
    const input = { mission, roots: [root], verifiedAction: (_mission, action) => action.status === 'succeeded',
      observedFiles: (_mission, action) => files.get(action.actionId) ?? [] };
    fn({ mission, root, actions, files, input });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('explicit summary with independent exact content and observed read-before-write covers its bounded source clause', () => fixture(({ input }) => {
  const result = assessTextSummarySequence(input);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.evidenceActionIds, ['read', 'write']);
  assert.equal(result.resultCriteriaVerificationRequired, true);
}));

test('a generic existence criterion or incorrect summary cannot prove the requested content', () => fixture(({ input, mission, root }) => {
  mission.successCriteria[0].verificationSpec.kind = 'file.exists';
  assert.equal(assessTextSummarySequence(input).allowed, false);
  mission.successCriteria[0].verificationSpec.kind = 'text.equals';
  writeFileSync(join(root, 'summary.txt'), '잘못된 회의 정보');
  assert.equal(assessTextSummarySequence(input).allowed, false);
}));

test('invalid UTF8 in either current source or result cannot pass an exact replacement-character oracle',()=>{
 for(const name of ['source.txt','summary.txt'])fixture(({input,mission,root,files})=>{
  const bytes=Buffer.from([0x61,0xc3,0x28]);writeFileSync(join(root,name),bytes);
  if(name==='source.txt'){
   files.get('read')[0].sha256=sha(bytes);
   mission.observations[0].data.readExtent={offset:0,returnedChars:3,bytes:3,truncated:false,encoding:'utf8'};
  }else{
   files.get('write')[0].sha256=sha(bytes);
   mission.successCriteria[0].verificationSpec.equals=bytes.toString('utf8');
  }
  assert.equal(assessTextSummarySequence(input).allowed,false);
 });
});

test('missing reading, mismatched targets, stale files and writing before reading do not discharge a summary request', () => {
  for (const mutate of [
    f => { f.actions[0].status = 'failed'; },
    f => { f.actions[0].operation.dispatch.arguments.path = join(f.root, 'other.txt'); },
    f => { f.actions[1].operation.dispatch.taskId = 'unrelated'; },
    f => { f.files.get('read')[0].sha256 = 'a'.repeat(64); },
    f => { f.actions[1].operation.dispatch.dispatchedAt = '2026-09-27T09:00:00.000Z'; },
    f => { writeFileSync(join(f.root, 'source.txt'), '읽은 뒤 변경한 원문'); },
    f => { f.actions.push({ status: 'succeeded', actualToolName: 'email.send' }); }
  ]) fixture(f => { mutate(f); assert.equal(assessTextSummarySequence(f.input).allowed, false); });
});

test('additional demands, prohibited actions and malformed or unquoted targets are outside the bounded recipe', () => {
  for (const objective of [
    "'source.txt'를 읽고 핵심을 요약해 'summary.txt'로 저장해줘 그리고 메일도 보내",
    "'source.txt'를 읽고 중요한 사실은 빼고 요약해 'summary.txt'로 저장해줘",
    "'source.txt'를 읽지 말고 요약해 'summary.txt'로 저장해줘",
    "source.txt를 읽고 핵심을 요약해 summary.txt로 저장해줘"
  ]) fixture(f => { f.mission.goalContract = createGoalContract({ objective }); assert.equal(assessTextSummarySequence(f.input), null); });
});
