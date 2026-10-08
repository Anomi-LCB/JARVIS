import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { verifyArtifactConsistency } from '../packages/core/src/mission/artifact-consistency.js';
import { evaluateM09ArtifactConsistencyEvidence } from '../scripts/agent-platform-independent-oracle.mjs';

function fixture() {
  const sourceFacts = { articleCount: 3, totalViews: 1200, averageScore: 4.5 };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(sourceFacts).sort(([left], [right]) => left.localeCompare(right))));
  const digest = createHash('sha256').update(canonical).digest('hex');
  const source = { sourceId: 'm09-public-research-v1', revision: 7, digest, facts: sourceFacts };
  const artifacts = ['report', 'table', 'card'].map(kind => ({ artifactId: `m09-${kind}-v7`, kind,
    sourceRef: { sourceId: source.sourceId, revision: source.revision, digest }, facts: structuredClone(sourceFacts) }));
  return { source, artifacts };
}

test('M09 typed artifact contract detects stale numeric projections and source revisions', () => {
  const valid = fixture();
  const passed = verifyArtifactConsistency(valid);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.checks.length, 8);
  assert.equal(passed.source.artifactCount, 3);

  const staleNumber = structuredClone(valid);
  staleNumber.artifacts.find(item => item.kind === 'table').facts.totalViews = 1199;
  assert.equal(verifyArtifactConsistency(staleNumber).checks
    .find(item => item.id === 'report_table_card_facts_match_source')?.status, 'failed');

  const staleRevision = structuredClone(valid);
  staleRevision.artifacts.find(item => item.kind === 'card').sourceRef.revision = 6;
  assert.equal(verifyArtifactConsistency(staleRevision).checks
    .find(item => item.id === 'every_artifact_binds_current_source_revision')?.status, 'failed');

  const invalidDigest = structuredClone(valid);
  invalidDigest.source.digest = 'a'.repeat(64);
  assert.equal(verifyArtifactConsistency(invalidDigest).checks
    .find(item => item.id === 'source_digest_matches_canonical_facts')?.status, 'failed');
});

test('M09 canonical fact envelope refuses getters, sparse arrays, unsafe keys and oversized values', () => {
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.equal(verifyArtifactConsistency({ source: { sourceId: 's', revision: 1, digest: 'a'.repeat(64), facts: getter }, artifacts: [] }).status, 'failed');
  const sparse = []; sparse[1] = 'gap';
  assert.equal(verifyArtifactConsistency({ source: { sourceId: 's', revision: 1, digest: 'a'.repeat(64), facts: { sparse } }, artifacts: [] }).status, 'failed');
  assert.equal(verifyArtifactConsistency({ source: { sourceId: 's', revision: 1, digest: 'a'.repeat(64), facts: { ['__proto__']: 'blocked' } }, artifacts: [] }).status, 'failed');
  assert.equal(verifyArtifactConsistency({ source: { sourceId: 's', revision: 1, digest: 'a'.repeat(64), facts: { text: 'x'.repeat(20_001) } }, artifacts: [] }).status, 'failed');
});

test('M09 fixture exports bounded evidence for an independent process oracle', () => {
  const evidence = { schemaVersion: 1, scenarioId: 'M09', fixtureId: 'm09-shared-source-typed-facts-v1', ...fixture(),
    providerCalls: 0, networkRequests: 0, externalWrites: 0 };
  assert.equal(verifyArtifactConsistency(evidence).status, 'passed');
  assert.equal(evaluateM09ArtifactConsistencyEvidence(evidence).status, 'passed');
  const stale = structuredClone(evidence);
  stale.artifacts.find(item => item.kind === 'table').facts.totalViews = 1199;
  assert.equal(evaluateM09ArtifactConsistencyEvidence(stale).checks
    .find(item => item.id === 'all_typed_numeric_facts_match_the_source')?.status, 'failed');
  if (process.env.JARVIS_M09_EVIDENCE_PATH) {
    writeFileSync(resolve(process.env.JARVIS_M09_EVIDENCE_PATH), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});
