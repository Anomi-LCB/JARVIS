import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMissionArguments } from '../packages/core/src/planning/mission-action-arguments.js';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';

test('Word mission arguments canonicalize table headers without losing source-derived rows', () => {
  const blocks = [
    { type: 'heading', level: 2, text: '지원 항목 요약표' },
    {
      type: 'table',
      headers: ['질문', '기본 답변', '상향 조건', '담당'],
      rows: [
        ['비밀번호를 잊었어요?', '로그인 화면의 비밀번호 재설정 사용', '재설정 메일 미수신 30분 후', '지원팀'],
        ['영수증은 어디서 받나요?', '결제 내역에서 PDF 영수증 수령', '결제 이중청구 즉시', '재무팀'],
        ['계정을 삭제하려면?', '설정의 개인정보 메뉴에서 삭제 요청 제출', '계정 삭제 오류', '개인정보 담당']
      ]
    }
  ];

  const sanitized = sanitizeMissionArguments('word.create', {
    path: 'C:\\workspace\\support-kb.docx',
    title: '고객지원 지식베이스',
    blocks,
    capabilityToken: 'must-not-cross-boundary'
  });

  assert.deepEqual(sanitized.blocks[1], {
    type: 'table',
    columns: ['질문', '기본 답변', '상향 조건', '담당'],
    rows: blocks[1].rows
  });
  assert.equal(sanitized.capabilityToken, undefined);
  const retained = JSON.stringify(sanitized.blocks);
  for (const fact of ['영수증은 어디서 받나요?', 'PDF 영수증', '30분', '즉시', '지원팀', '재무팀', '개인정보 담당']) {
    assert.match(retained, new RegExp(fact));
  }
});

test('Document table canonicalization is idempotent and never overrides canonical columns', () => {
  const value = {
    path: 'C:\\workspace\\guide.docx',
    blocks: [{
      type: 'table',
      columns: ['정식 열'],
      headers: ['모델 별칭'],
      rows: [['보존할 값']]
    }]
  };
  const once = sanitizeMissionArguments('word.create', value);
  const twice = sanitizeMissionArguments('word.create', once);

  assert.deepEqual(twice, once);
  assert.deepEqual(once.blocks[0].columns, ['정식 열']);
  assert.equal(once.blocks[0].headers, undefined);
  assert.deepEqual(once.blocks[0].rows, [['보존할 값']]);
});

test('HWP structured tables use the same canonical document contract', () => {
  const sanitized = sanitizeMissionArguments('hwp.create', {
    path: 'C:\\workspace\\guide.hwpx',
    blocks: [{ type: 'table', headers: ['항목', '담당'], rows: [['환불', '재무팀']] }]
  });
  assert.deepEqual(sanitized.blocks, [{
    type: 'table',
    columns: ['항목', '담당'],
    rows: [['환불', '재무팀']]
  }]);
});

test('A non-empty headers alias repairs an empty canonical table header list', () => {
  const sanitized = sanitizeMissionArguments('word.create', {
    path: 'C:\\workspace\\guide.docx',
    blocks: [{ type: 'table', columns: [], headers: ['질문'], rows: [['문의']] }]
  });
  assert.deepEqual(sanitized.blocks, [{ type: 'table', columns: ['질문'], rows: [['문의']] }]);
});

function docxCompletionFixture(contentVerification) {
  const action = {
    actionId: 'word-action',
    expectedToolName: 'word.create',
    actualToolName: 'word.create',
    status: 'succeeded',
    arguments: {
      path: 'C:\\workspace\\support-kb.docx',
      title: '지원 지식베이스',
      blocks: [{ type: 'table', columns: ['질문', '담당'], rows: [['영수증은 어디서 받나요?', '재무팀']] }]
    }
  };
  const observation = {
    actionId: action.actionId,
    toolName: 'word.create',
    outcome: 'success',
    artifacts: [{ name: 'support-kb.docx' }],
    data: contentVerification ? { documentContentVerification: contentVerification } : {},
    verification: { status: 'passed' }
  };
  const mission = { waves: [{ actions: [action] }], observations: [observation] };
  return MissionRuntime.prototype.verifyCriterionEvidence.call(
    {resultReadGuard:MissionRuntime.prototype.resultReadGuard},
    mission,
    { statement: 'support-kb.docx를 만들고 요청 내용과 docx 형식을 검증한다.' },
    [action.actionId]
  );
}

test('Word block-count evidence is preserved without certifying all requested semantic content', () => {
  const result = docxCompletionFixture({ status: 'verified', expectedItemCount: 5, expectedTableCount: 1 });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(
    result.checks.find((check) => check.checkId === 'word_content_contract_verified'),
    {
      checkId: 'word_content_contract_verified',
      passed: true,
      expected: ['support-kb.docx'],
      observed: [{
        fileName: 'support-kb.docx',
        actionId: 'word-action',
        expectedItemCount: 5,
        expectedTableCount: 1,
        status: 'verified',
        observedItemCount: 5,
        observedTableCount: 1,
        passed: true
      }]
    }
  );
});

test('Mission completion rejects a missing or count-mismatched Word content contract', () => {
  const missing = docxCompletionFixture(null);
  assert.equal(missing.passed, false);
  assert.ok(missing.reasons.includes('word_content_contract_verified'));

  const mismatched = docxCompletionFixture({ status: 'verified', expectedItemCount: 4, expectedTableCount: 0 });
  assert.equal(mismatched.passed, false);
  assert.ok(mismatched.reasons.includes('word_content_contract_verified'));
});

test('Word execution content verification is retained in a mission observation', () => {
  const observation = MissionRuntime.prototype.successObservation.call({
    artifactReference: (path) => ({ name: path.split(/[\\/]/u).at(-1) })
  }, {
    actionId: 'word-action',
    actualToolName: 'word.create'
  }, {
    taskId: 'word-task'
  }, {
    execution: {
      executionResult: {
        status: 'success',
        summary: '문서 생성 완료',
        outputPaths: ['C:\\workspace\\support-kb.docx'],
        contentVerification: { status: 'verified', expectedItemCount: 23, expectedTableCount: 1 }
      }
    },
    executionVerification: { verificationId: 'verify-word', status: 'passed', score: 100, checks: [] }
  });

  assert.deepEqual(observation.data.documentContentVerification, {
    status: 'verified',
    expectedItemCount: 23,
    expectedTableCount: 1
  });
});
