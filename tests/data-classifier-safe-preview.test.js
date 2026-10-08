import test from 'node:test';
import assert from 'node:assert/strict';
import { DataClassifier } from '../apps/policy-security/src/policy-runtime.js';
import { createPolicySecurityServer } from '../apps/policy-security/src/main.mjs';

// Synthetic values only. Check the serialized API report, not only its action label.
for (const [name, text, forbidden] of [
  ['email NER', '연락 sample@example.invalid 확인', 'sample@example.invalid'],
  ['phone fallback', '연락 010-1234-5678 확인', '010-1234-5678'],
  ['national identifier', '예시 900101-1234567', '900101-1234567'],
  ['secret value', 'api_key=synthetic-secret-value', 'synthetic-secret-value'],
  ['pastoral context', '상담 내용: 비공개 합성 이야기', '비공개 합성 이야기'],
  ['nested input', { credentials: 'password=synthetic-nested-secret' }, 'synthetic-nested-secret']
]) {
  test(`classification report does not expose ${name} in safePreview`, () => {
    const report = new DataClassifier().classifyFields({ input: text });
    assert.equal(report.redactionRequired, true);
    assert.equal(JSON.stringify(report).includes(forbidden), false);
  });
}

test('public text remains useful and previews stay bounded', () => {
  const report = new DataClassifier().classifyFields({ public: '공개 자료 설명 '.repeat(40) });
  assert.equal(report.fields[0].action, 'retain');
  assert.equal(report.fields[0].safePreview, '공개 자료 설명 '.repeat(40).slice(0, 240));
});

test('multiple NER spans preserve public context without offset shifts', () => {
  const preview = new DataClassifier().classifyFields({ contact: '앞 sample@example.invalid 중간 010-1234-5678 뒤' }).fields[0].safePreview;
  assert.match(preview, /^앞 .* 중간 .* 뒤$/);
  assert.equal(preview.includes('sample@example.invalid'), false);
  assert.equal(preview.includes('010-1234-5678'), false);
});

test('keyword-only secret detection withholds the value, including compiled rules', () => {
  for (const compiledPolicy of [null, { dataRules: [{ id: 'secret', pattern: 'api_key', regex: /api_key/i, dataClass: 'D4', ministryDataClass: 'M4', flags: ['secret'] }] }]) {
    const report = new DataClassifier({ compiledPolicy }).classifyFields({ key: 'api_key=ABC123xyz' });
    assert.equal(JSON.stringify(report).includes('ABC123xyz'), false);
    assert.match(report.fields[0].safePreview, /\[secret\]/);
  }
});

test('malformed NER offsets withhold a sensitive field', () => {
  const nerAdapter = { adapterId: 'synthetic-invalid-offset', extract: () => [{ entityId: 'invalid', start: 900, end: 950, dataClass: 'D2', ministryDataClass: 'M2' }] };
  const report = new DataClassifier({ nerAdapter }).classifyFields({ value: 'privateABC' });
  assert.equal(JSON.stringify(report).includes('privateABC'), false);
});

test('actual local data/classify HTTP response contains no detected sensitive values', async () => {
  const server = createPolicySecurityServer({ dataClassifier: new DataClassifier() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/data/classify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ record: { email: 'sample@example.invalid', care: '상담 비공개 합성 이야기', key: 'api_key=ABC123xyz', public: '공개 보고서' } })
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    for (const forbidden of ['sample@example.invalid', '비공개 합성 이야기', 'ABC123xyz']) assert.equal(serialized.includes(forbidden), false);
    assert.equal(JSON.parse(serialized).fields.find(field => field.field === 'public').safePreview, '공개 보고서');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
