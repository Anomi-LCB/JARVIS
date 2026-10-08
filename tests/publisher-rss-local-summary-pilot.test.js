import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_SCHEMA, selectExactlyQuotedNewsClaims, validateGroundedNewsSummary } from '../scripts/publisher-rss-local-summary-pilot.mjs';

test('local publisher summary requires a useful summary and exact quotation evidence', () => {
  const source = '정부는 오늘 새로운 교통 대책을 발표했다. 관계자는 다음 달부터 시범 운영한다고 설명했다.';
  assert.equal(validateGroundedNewsSummary({ claims: [{ claim: '정부가 새로운 교통 대책을 발표했다.',
    evidenceQuote: '정부는 오늘 새로운 교통 대책을 발표했다.' }] }, source), true);
  assert.equal(validateGroundedNewsSummary({ claims: [{ claim: '정부가 다음 달부터 시범 운영한다고 설명했다.',
    evidenceQuote: '다음 달부터 시범 운영한다고 설명했다.' }] }, source), true);
  assert.equal(validateGroundedNewsSummary({ claims: [{ claim: '정부가 전국 무료 교통을 약속했다고 말했다.',
    evidenceQuote: '정부가 전국 무료 교통을 약속했다고 말했다.' }] }, source), false);
  assert.equal(validateGroundedNewsSummary({ claims: [{ claim: '짧음', evidenceQuote: '정부는 오늘 새로운 교통 대책을 발표했다.' }] }, source), false);
  assert.equal(SUMMARY_SCHEMA.additionalProperties, false);
});

test('an exact quote is reported only as substring grounding, not semantic entailment', () => {
  const source = '원문에 포함된 문장으로서 사실 관계는 별도의 검토가 필요하다.';
  const result = validateGroundedNewsSummary({ claims: [{ claim: '원문에 문장이 포함되어 있고 사실 검토가 더 필요하다고 기록했다.',
    evidenceQuote: '원문에 포함된 문장으로서 사실 관계는 별도의 검토가 필요하다.' }] }, source);
  assert.equal(result, true);
});

test('unsupported model quotations are dropped and only verbatim source evidence is retained', () => {
  const source = '정부가 오늘 정책을 발표했으며 다음 달부터 현장 시범 운영에 들어간다고 밝혔다.';
  const generated = { claims: [
    { claim: '정부가 오늘 정책을 발표했다고 밝혔다.', evidenceQuote: '정부가 오늘 정책을 발표했으며 다음 달부터 현장 시범 운영에 들어간다고 밝혔다.' },
    { claim: '전국의 모든 시민에게 무료라고 밝혔다.', evidenceQuote: '전국의 모든 시민에게 무료로 제공한다고 밝혔다.' }
  ] };
  assert.equal(validateGroundedNewsSummary(generated, source), false);
  assert.deepEqual(selectExactlyQuotedNewsClaims(generated, source), [generated.claims[0]]);
});

test('a numerically specific claim is dropped unless its exact quote includes every number', () => {
  const source = '대표팀은 38초43으로 한국 신기록을 세웠다. 종전 기록은 38초49였다.';
  const generated = { claims: [
    { claim: '대표팀은 38초43으로 한국 신기록을 세웠다.', evidenceQuote: '대표팀은 한국 신기록을 세웠다.' },
    { claim: '종전 기록은 38초49였다.', evidenceQuote: '종전 기록은 38초49였다.' }
  ] };
  assert.deepEqual(selectExactlyQuotedNewsClaims(generated, source), [generated.claims[1]]);
});
