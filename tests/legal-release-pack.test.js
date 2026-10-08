import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectLegalReleaseIntake,
  createLegalReleasePack,
  writeLegalReleasePack
} from '../scripts/legal-release-pack.mjs';

const completeEnv = Object.freeze({
  JARVIS_LEGAL_OPERATOR_NAME: 'JARVIS Test Operator',
  JARVIS_LEGAL_OPERATOR_TYPE: '법인',
  JARVIS_LEGAL_BUSINESS_ADDRESS: '서울특별시 테스트로 1',
  JARVIS_LEGAL_SUPPORT_EMAIL: 'support@example.invalid',
  JARVIS_LEGAL_PRIVACY_OFFICER: '개인정보보호팀',
  JARVIS_LEGAL_PRIVACY_EMAIL: 'privacy@example.invalid',
  JARVIS_LEGAL_PRIVACY_PHONE: '02-0000-0000',
  JARVIS_LEGAL_SALES_REGION: '대한민국',
  JARVIS_LEGAL_THIRD_PARTY_PROVIDERS: '테스트 공급자(대한민국)',
  JARVIS_LEGAL_GOVERNING_LAW: '대한민국 법률',
  JARVIS_LEGAL_VENUE: '서울중앙지방법원',
  JARVIS_LEGAL_EFFECTIVE_DATE: '2026-09-01',
  JARVIS_LEGAL_REVIEWER_NAME: '테스트 승인자'
});

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('legal release pack creates blocked drafts without inventing owner details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-legal-draft-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"jarvis-test","license":"UNLICENSED"}\n', 'utf8');
    const intake = collectLegalReleaseIntake({ env: {} });
    const pack = createLegalReleasePack({ env: {}, clock: () => new Date('2026-08-21T00:00:00.000Z') });
    assert.equal(intake.readyToFinalize, false);
    assert.equal(pack.status, 'owner-input-required');
    assert.match(pack.documents.privacy, /확정 필요/);

    const report = await writeLegalReleasePack(pack, { workspaceRoot: dir });
    assert.equal(report.finalized, false);
    assert.equal(await exists(join(dir, 'dist/legal-release-pack/PRIVACY.draft.md')), true);
    assert.equal(await exists(join(dir, 'PRIVACY.md')), false);
    assert.equal(await exists(join(dir, 'LICENSE')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legal release finalization fails closed without explicit review approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-legal-blocked-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"jarvis-test","license":"UNLICENSED"}\n', 'utf8');
    const pack = createLegalReleasePack({ env: completeEnv });
    assert.equal(pack.status, 'legal-approval-required');
    await assert.rejects(
      writeLegalReleasePack(pack, { workspaceRoot: dir, finalize: true }),
      /legal-release-approval-required/
    );
    assert.equal(await exists(join(dir, 'EULA.md')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legal release rejects approval that is not bound to the exact review bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-legal-stale-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"jarvis-test","license":"UNLICENSED"}\n', 'utf8');
    const pack = createLegalReleasePack({
      env: {
        ...completeEnv,
        JARVIS_LEGAL_REVIEW_APPROVED: 'APPROVED_FOR_COMMERCIAL_RELEASE',
        JARVIS_LEGAL_REVIEW_BUNDLE_SHA256: '0'.repeat(64)
      }
    });
    assert.equal(pack.readyToFinalize, false);
    assert.equal(pack.approval.bundleSha256Matches, false);
    await assert.rejects(writeLegalReleasePack(pack, { workspaceRoot: dir, finalize: true }), /bundle-hash-mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legal release finalization writes approved documents only after complete intake', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-legal-final-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"jarvis-test","license":"UNLICENSED"}\n', 'utf8');
    const reviewPack = createLegalReleasePack({ env: completeEnv });
    const pack = createLegalReleasePack({ env: {
      ...completeEnv,
      JARVIS_LEGAL_REVIEW_APPROVED: 'APPROVED_FOR_COMMERCIAL_RELEASE',
      JARVIS_LEGAL_REVIEW_BUNDLE_SHA256: reviewPack.reviewBundle.sha256
    } });
    const report = await writeLegalReleasePack(pack, { workspaceRoot: dir, finalize: true });
    assert.equal(report.status, 'finalized');
    assert.match(await readFile(join(dir, 'LICENSE'), 'utf8'), /Legal-Review-Status: approved/);
    assert.match(await readFile(join(dir, 'PRIVACY.md'), 'utf8'), /JARVIS Test Operator/);
    assert.match(await readFile(join(dir, 'EULA.md'), 'utf8'), /서울중앙지방법원/);
    assert.equal(report.approvalReceipt.reviewBundleSha256, reviewPack.reviewBundle.sha256);
    assert.equal(report.approvalReceipt.rawApprovalPhraseStored, false);
    assert.equal(await exists(join(dir, 'dist/legal-release-pack/legal-release-approval.json')), true);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(manifest.license, 'SEE LICENSE IN LICENSE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
