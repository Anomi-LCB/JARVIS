import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgGapAudit } from '../scripts/ag-gap-audit.mjs';

test('A-G gap audit labels static coverage separately from executable and field evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-audit-honesty-'));
  try {
    const markdownPath = join(dir, 'audit.md');
    const report = await runAgGapAudit({
      jsonPath: join(dir, 'audit.json'),
      markdownPath,
      csvPath: join(dir, 'audit.csv')
    });

    assert.equal(report.evidenceMethodology.methodologyVersion, 'ag-gap-evidence-methodology-v2');
    assert.equal(report.evidenceMethodology.strictScoreIsFieldCompletion, false);
    assert.equal(report.evidenceMethodology.productReadinessIsReleaseApproval, false);
    assert.equal(report.evidenceMethodology.observedBehaviorExecutionCount, 0);
    assert.ok(report.evidenceMethodology.evidenceCount > 0);
    assert.ok(report.evidenceMethodology.countsByType['implementation-source-marker'] > 0);
    assert.match(await readFile(markdownPath, 'utf8'), /현재 실행에서의 동작 통과율이나 현장 제품 완성률이 아니다/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
