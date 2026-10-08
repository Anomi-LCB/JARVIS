import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';
import { LocalWorkflowToolAdapter } from '../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

// Independent holdouts: intentionally no campaign case/fixture/oracle imports.
async function isolated(operation) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-natural-unseen-'));
  try { await operation(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
async function readJson(root, path) { return JSON.parse(await readFile(join(root, path), 'utf8')); }
async function execute(root, command) {
  const compiled = compileNaturalWorkflowObjective(command, { workspaceRoot: root });
  assert.equal(compiled.status, 'compiled', JSON.stringify(compiled));
  assert.equal(compiled.clauses.length, compiled.nodeCount);
  const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ spec: compiled.spec, workspaceRoot: root });
  assert.equal(result.status, 'success', JSON.stringify(result.error ?? result));
  assert.equal(result.evidence.workflow.specSha256, createHash('sha256').update(JSON.stringify(compiled.spec)).digest('hex'));
  assert.equal(result.evidence.workflow.receipts.length, compiled.nodeCount);
  assert.equal(result.evidence.workflow.specSource, 'inline');
  return { compiled, result };
}

test('holdout: numeric CSV equality and explicit numeric sorting keep string identifier zeros', async () => isolated(async (root) => {
  await put(root, 'new 2037/billing.csv', 'code,units,amount\n009,3,9\n010,3,100\n011,2,900\n012,3,20\n');
  await execute(root, "'new 2037/billing.csv' CSV를 '청구'로 읽고; '청구'에서 'units'가 3인 행만 '세개'로 걸러내고; '세개'를 'amount' 내림차순으로 숫자로 정렬해 '큰순'으로 만들고; '큰순'에서 필드 'code', 'amount'만 추출해 '결과'로 만들고; '결과'를 'unseen/amounts.json' JSON으로 저장하고; '결과'의 개수가 3인지 검증해");
  assert.deepEqual(await readJson(root, 'unseen/amounts.json'), [
    { code: '010', amount: '100' }, { code: '012', amount: '20' }, { code: '009', amount: '9' }
  ]);
}));

test('holdout: nested JSON logical selection feeds computed statistics and a real scalar assertion', async () => isolated(async (root) => {
  await put(root, 'measurements/deep sample.json', { payload: { observations: [{ watts: 1.5 }, { watts: 4.5 }, { watts: 9 }] } });
  await execute(root, "'measurements/deep sample.json' JSON을 '관측원본'으로 읽고; '관측원본'의 'payload.observations'를 '관측'으로 선택하고; '관측'의 'watts' 통계를 계산해 '전력분포'로 만들고; '전력분포'의 'mean' 값이 5인지 검증하고; '전력분포'를 'unseen/distribution.json' JSON으로 저장해");
  const observed = await readJson(root, 'unseen/distribution.json');
  assert.equal(observed.mean, 5);
  assert.equal(observed.sum, 15);
  assert.equal(observed.count, 3);
  assert.equal(observed.median, 4.5);
}));

test('holdout: dotted aggregate column names survive projection and arithmetic', async () => isolated(async (root) => {
  await put(root, 'unseen-dimensions.json', [
    { bucket: { kind: '오전' }, amount: 12 }, { bucket: { kind: '오후' }, amount: 7 }, { bucket: { kind: '오전' }, amount: 5 }
  ]);
  await execute(root, "'unseen-dimensions.json' JSON을 '차원'으로 읽고; '차원'을 'bucket.kind'별로 'amount' 합계 'metric.total'을 계산해 '합계'로 만들고; '합계'에서 필드 'bucket.kind', 'metric.total'만 추출해 '열'로 만들고; '열'에 'doubled' = 'metric.total' * 2를 계산해 '결과'로 만들고; '결과'를 'out/dotted.json' JSON으로 저장해");
  assert.deepEqual(await readJson(root, 'out/dotted.json'), [
    { 'bucket.kind': '오전', 'metric.total': 17, doubled: 34 }, { 'bucket.kind': '오후', 'metric.total': 7, doubled: 14 }
  ]);
}));

test('holdout: quoted separators and sequence words survive literal replacement and rendered text', async () => isolated(async (root) => {
  await put(root, 'letters/data.workflow.json', [{ name: '은솔', note: 'alpha;그리고 omega' }, { name: '준', note: 'plain' }]);
  await execute(root, "먼저 'letters/data.workflow.json' JSON을 '사람'으로 읽으세요 그리고 '사람'의 필드 'note'에서 ';그리고'를 '|유지|'로 치환해 '교정'으로 만드세요 그다음 '교정'에 템플릿 '안내;그리고 {{name}}:{{note}}'를 적용해 '문서'로 만드세요 마지막으로 '문서'를 'letters/output.txt' 텍스트로 저장하세요");
  assert.equal(await readFile(join(root, 'letters/output.txt'), 'utf8'), '안내;그리고 은솔:alpha|유지| omega\n안내;그리고 준:plain');
}));

test('holdout: JSON then CSV staged rereads observe newly written bytes throughout one command', async () => isolated(async (root) => {
  await put(root, 'supply.json', [{ zone: 'Z9', quantity: 2, price: 5 }, { zone: 'Z9', quantity: 1, price: 9 }, { zone: 'Z4', quantity: 3, price: 7 }]);
  await execute(root, "'supply.json' JSON을 '원자료'로 읽고; '원자료'에 'subtotal' = 'quantity' * 'price'를 계산해 '계산'으로 만들고; '계산'을 'stage/intermediate.json' JSON으로 저장하고; 'stage/intermediate.json' JSON을 '재확인'으로 읽고; '재확인'을 'zone'별로 'subtotal' 합계 'total'을 계산해 '합산'으로 만들고; '합산'을 'stage/aggregate.csv' CSV로 저장하고; 'stage/aggregate.csv' CSV를 'CSV재조회'로 읽고; 'CSV재조회'에서 'total'가 20 초과인 행만 '상위'로 걸러내고; '상위'에서 필드 'zone', 'total'만 추출해 '결과'로 만들고; '결과'를 'final/result.json' JSON으로 저장하고; '결과'의 개수가 1인지 검증해");
  assert.deepEqual(await readJson(root, 'final/result.json'), [{ zone: 'Z4', total: '21' }]);
  assert.deepEqual((await readJson(root, 'stage/intermediate.json')).map((row) => row.subtotal), [10, 9, 21]);
}));

test('holdout: a warm compile cache rereads changed live data and never reuses a data result', async () => isolated(async (root) => {
  const command = "'live-values.json' JSON을 '데이터'로 읽고; '데이터'의 'reading' 통계를 계산해 '통계'로 만들고; '통계'를 'out/current.json' JSON으로 저장해";
  await put(root, 'live-values.json', [{ reading: 2 }, { reading: 8 }]);
  const first = await execute(root, command);
  assert.equal((await readJson(root, 'out/current.json')).mean, 5);
  await unlink(join(root, 'out/current.json'));
  await put(root, 'live-values.json', [{ reading: 20 }, { reading: 80 }]);
  const second = await execute(root, command);
  assert.equal(second.compiled.cacheHit, true);
  assert.equal((await readJson(root, 'out/current.json')).mean, 50);
  assert.equal(first.compiled.spec.workflowId, second.compiled.spec.workflowId);
  assert.notEqual(first.result.evidence.manifest[0].sha256, second.result.evidence.manifest[0].sha256);
}));

test('holdout: default email and phone redaction remains consistent in rows and document records', async () => isolated(async (root) => {
  await put(root, 'unseen-contact-note.json', [{ name: '수연', note: '문의 sy.park+new@example.org 또는 010-9876-4321' }]);
  await execute(root, "'unseen-contact-note.json' JSON을 '고객'으로 읽고; '고객'의 필드 'note'을 이메일 마스킹해 '메일보호'로 만들고; '메일보호'의 필드 'note'을 전화번호 마스킹해 '보호'로 만들고; '보호'에 템플릿 '{{name}}: {{note}}'를 적용해 '문서'로 만들고; '문서'를 'out/protected.json' JSON으로 저장해");
  const rows = await readJson(root, 'out/protected.json');
  assert.equal(rows[0].text, '수연: 문의 [REDACTED] 또는 [REDACTED]');
  assert.equal(rows[0].record.note, '문의 [REDACTED] 또는 [REDACTED]');
}));
