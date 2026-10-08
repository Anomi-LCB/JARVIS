import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  PowerPointCreateToolAdapter,
  WordCreateToolAdapter,
  expectedDocContentItems,
  normalizeDocBlocks
} from '../apps/pc-agent/src/pc-agent-runtime.js';
import { buildMissionPlanningPrompt } from '../packages/core/src/mission/mission-planner.js';

test('Word normalization retains a planner table that uses the headers alias', async () => {
  const doc = normalizeDocBlocks({
    title: '고객 지원 지식 베이스',
    blocks: [{
      type: 'table',
      headers: ['질문', '기본 답변', '상향 조건', '담당'],
      rows: [
        ['비밀번호를 잊었어요.', '비밀번호 재설정 링크를 사용하세요.', '30분 후', '지원팀'],
        ['영수증은 어디서 받나요?', '결제 내역에서 PDF 영수증을 받으세요.', '즉시', '재무팀'],
        ['계정을 삭제하고 싶어요.', '개인정보 메뉴에서 삭제를 요청하세요.', '오류 발생', '개인정보 담당']
      ]
    }]
  });

  assert.equal(doc.tableCount, 1);
  assert.deepEqual(doc.blocks[0].columns, ['질문', '기본 답변', '상향 조건', '담당']);
  const content = expectedDocContentItems(doc);
  for (const token of ['비밀번호를 잊었어요.', '영수증은 어디서 받나요?', '계정을 삭제하고 싶어요.', '재무팀']) {
    assert.ok(content.includes(token), token);
  }

  const adapter = new WordCreateToolAdapter({ allowedRoots: [resolve('.')] });
  const shadow = await adapter.shadow({ path: resolve('support-kb.docx'), ...doc });
  assert.equal(shadow.blockCount, 1);
});

test('Word normalization rejects a malformed table instead of silently dropping its content', () => {
  assert.throws(
    () => normalizeDocBlocks({ blocks: [{ type: 'table', rows: [['영수증', '재무팀']] }] }),
    (error) => error?.code === 'B_DOCUMENT_TABLE_COLUMNS_REQUIRED'
  );
  assert.throws(
    () => normalizeDocBlocks({ blocks: [{ type: 'faq', question: '영수증은 어디서 받나요?', answer: '결제 내역' }] }),
    (error) => error?.code === 'B_DOCUMENT_BLOCK_TYPE_UNSUPPORTED' && error?.blockIndex === 0
  );
  assert.throws(
    () => normalizeDocBlocks({ blocks: [null] }),
    (error) => error?.code === 'B_DOCUMENT_BLOCK_INVALID' && error?.blockIndex === 0
  );
});

test('mission prompt states the complete document table contract and source-content obligation', () => {
  const prompt = buildMissionPlanningPrompt({
    mission: { objective: 'faq.txt를 읽고 support-kb.docx를 만들어.', successCriteria: [], constraints: [], remainingBudget: {} },
    capabilities: [{ toolName: 'word.create' }],
    observations: [],
    today: '2026-09-03'
  });
  assert.match(prompt, /type:"table",columns:\["열1","열2"\],rows:/);
  assert.match(prompt, /표 머리글 키는 headers가 아니라 columns/);
  assert.match(prompt, /각 원본 항목과 필드.*생략하지 마세요/);
});

test('native Office adapters gate success on semantic document content and exact slide order', async () => {
  const source = await readFile(resolve('apps/pc-agent/src/pc-agent-runtime.js'), 'utf8');
  const wordNative=await readFile(resolve('apps/pc-agent/src/adapters/word/native-create.ps1'),'utf8');
  assert.match(wordNative, /word-table-structure-mismatch/);
  assert.match(wordNative, /word-content-verification-failed/);
  assert.match(wordNative, /Documents\.Open\(\$path,\$false,\$true,\$false\)/);
  assert.match(source, /const contentVerification = \{\s*status: 'verified'/);
  assert.match(source, /evidence: \{ document: \{ blockCount: doc\.blocks\.length, tableCount: doc\.tableCount, contentVerification \} \}/);
  const pptNative=await readFile(resolve('apps/pc-agent/src/adapters/powerpoint/native-create.ps1'),'utf8');
  assert.match(pptNative, /powerpoint-slide-count-mismatch/);
  assert.match(pptNative, /powerpoint-slide-\$role-mismatch/);
  assert.match(pptNative, /powerpoint-notes-mismatch/);
  assert.match(pptNative, /Presentations\.Open\(\$pptx,-1,0,0\)/);

  const deck = new PowerPointCreateToolAdapter({ allowedRoots: [resolve('.')] });
  const shadow = await deck.shadow({
    path: resolve('support-training.pptx'),
    slides: ['개요', '비밀번호', '결제', '계정삭제', '상향체계'].map((title) => ({ title, bullets: ['내용'] }))
  });
  assert.equal(shadow.slideCount, 5);
});
