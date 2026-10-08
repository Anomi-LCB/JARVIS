import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNewsArtifactPilotOutcome } from '../scripts/lib/news-artifact-pilot-outcome.mjs';

test('headline cards with unavailable publisher bodies are reported as partial, not complete', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'unavailable' }, { status: 'read' }],
    reportVerified: true,
    cardsVerified: true,
    cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.contentStatus, 'headline-only-or-incomplete');
  assert.equal(result.artifactIntegrityPassed, true);
  assert.deepEqual(result.blockingReasons, ['publisher-article-content-unavailable']);
});

test('the pilot is complete only when every article and every artifact passes independent checks', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }, { status: 'read' }],
    reportVerified: true,
    cardsVerified: true,
    cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.contentStatus, 'all-articles-read');
  assert.deepEqual(result.blockingReasons, []);
});

test('artifact mismatch fails even when article bodies were read', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }],
    reportVerified: false,
    cardsVerified: true,
    cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['report-reread-mismatch']);
});

test('inconsistent typed projections fail even when the rendered report and PNGs reread', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }], reportVerified: true, cardsVerified: true, consistencyVerified: false,
    cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['source-projection-consistency-mismatch']);
});

test('spreadsheet parser mismatch blocks artifact integrity', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }], reportVerified: true, cardsVerified: true, consistencyVerified: true,
    tableVerified: false, cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['spreadsheet-reopen-mismatch']);
});

test('document parser mismatch blocks artifact integrity', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }], reportVerified: true, cardsVerified: true, consistencyVerified: true,
    tableVerified: true, documentVerified: false, cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['document-reopen-mismatch']);
});

test('CSV workflow roundtrip mismatch blocks artifact integrity', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }], reportVerified: true, cardsVerified: true, consistencyVerified: true,
    tableVerified: true, documentVerified: true, csvVerified: false, cardContentStatus: 'passed'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['csv-workflow-roundtrip-mismatch']);
});

test('card OCR must pass before artifact integrity is complete', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'read' }], reportVerified: true, cardsVerified: true,
    consistencyVerified: true, tableVerified: true, documentVerified: true, csvVerified: true,
    cardContentStatus: 'failed'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['card-content-ocr-mismatch']);
});

test('missing local OCR language is a blocked check rather than a passed visual artifact', () => {
  const result = classifyNewsArtifactPilotOutcome({
    articles: [{ status: 'unavailable' }], reportVerified: true, cardsVerified: true,
    consistencyVerified: true, tableVerified: true, documentVerified: true, csvVerified: true,
    cardContentStatus: 'blocked'
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.artifactIntegrityPassed, false);
  assert.deepEqual(result.blockingReasons, ['card-content-ocr-unavailable', 'publisher-article-content-unavailable']);
});
