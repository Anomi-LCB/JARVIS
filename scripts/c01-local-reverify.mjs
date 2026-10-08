import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(repositoryRoot, 'artifacts/complex-workflow-50-audit/2026-09-03-retest-c01-final-v1/01');
const replayRoot = resolve(repositoryRoot, 'artifacts/complex-workflow-50-audit/2026-09-03-retest-c01-local-replay-v1');
const emailLedgerPath = resolve(repositoryRoot, 'artifacts/complex-workflow-50-audit/email-idempotency-v1.jsonl');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fileEvidence(path) {
  const bytes = await readFile(path);
  const details = await stat(path);
  return { path, size: bytes.length, sha256: sha256(bytes), lastModifiedAt: details.mtime.toISOString() };
}

async function treeManifest(root) {
  const entries = [];
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        await walk(path);
      } else if (child.isFile()) {
        const bytes = await readFile(path);
        entries.push({
          relativePath: relative(root, path).split(sep).join('/'),
          type: 'file',
          size: bytes.length,
          sha256: sha256(bytes)
        });
      }
    }
  };
  await walk(root);
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    manifestSha256: sha256(Buffer.from(`${JSON.stringify(entries)}\n`, 'utf8')),
    entries
  };
}

async function main() {
  const reverifiedAt = new Date().toISOString();
  const replay = JSON.parse(await readFile(join(replayRoot, 'result.json'), 'utf8'));
  const replayEvidence = JSON.parse(await readFile(join(replayRoot, 'evidence.json'), 'utf8'));
  const policy = JSON.parse(await readFile(join(replayRoot, 'policy.json'), 'utf8'));
  const storedMission = JSON.parse(await readFile(join(sourceRoot, 'audit', 'missions.json'), 'utf8')).missions.at(-1);
  const storedBefore = JSON.parse(await readFile(join(replayRoot, 'source-manifest-before.json'), 'utf8'));
  const storedAfter = JSON.parse(await readFile(join(replayRoot, 'source-manifest-after.json'), 'utf8'));

  const protectedBefore = {
    result: await fileEvidence(join(sourceRoot, 'result.json')),
    workspace: await treeManifest(join(sourceRoot, 'workspace')),
    emailLedger: await fileEvidence(emailLedgerPath)
  };
  assert.equal(replay.status, 'PASS');
  assert.equal(replay.networkCalls, 0);
  assert.equal(replay.emailCalls, 0);
  assert.equal(replay.emailOmitted, true);
  assert.equal(policy.emailAdapterConstructed, false);
  assert.equal(policy.emailAdapterExecuted, false);
  assert.equal(policy.missionRuntimeInvoked, false);
  assert.equal(policy.sourceMissionRerun, false);
  assert.deepEqual(replay.actionToolSequence, [
    'filesystem.createTextFile',
    'filesystem.searchFiles',
    'filesystem.readText',
    'visual.createCards',
    'archive.createZip'
  ]);

  const currentSource = await treeManifest(sourceRoot);
  assert.equal(storedBefore.manifestSha256, storedAfter.manifestSha256);
  assert.equal(storedAfter.manifestSha256, currentSource.manifestSha256);
  assert.equal(isDeepStrictEqual(storedBefore.entries, storedAfter.entries), true);
  assert.equal(isDeepStrictEqual(storedAfter.entries, currentSource.entries), true);

  const reportPath = join(replayRoot, 'workspace', 'hot-news-report.md');
  const report = await readFile(reportPath, 'utf8');
  const cardAction = replayEvidence.actions.find((action) => action.toolName === 'visual.createCards');
  assert.ok(cardAction);
  assert.equal(replay.articles.length, 3);
  assert.equal(cardAction.cards.length, 3);
  const articleCardBindings = replay.articles.map((article, index) => {
    const card = cardAction.cards[index];
    const artifact = replay.artifacts.find((item) => item.path === card.path);
    assert.ok(artifact);
    assert.equal(report.split(article.url).length - 1, 1);
    assert.equal(report.includes(article.storedPublisherHomepage), false);
    assert.equal(card.articleUrlSha256, sha256(article.url));
    assert.equal(artifact.sha256, card.sha256);
    return {
      index: index + 1,
      title: article.title,
      source: article.source,
      publishedAt: article.publishedAt,
      articleUrl: article.url,
      articleUrlSha256: sha256(article.url),
      reportCitationCount: 1,
      cardPath: card.path,
      cardSha256: card.sha256,
      binding: 'exact article URL -> URL SHA-256 -> exact PNG SHA-256'
    };
  });

  const primaryCriterion = storedMission.successCriteria.find((criterion) => criterion.criterionId === 'criterion_1');
  const successfulActionIds = storedMission.waves
    .flatMap((wave) => wave.actions)
    .filter((action) => action.status === 'succeeded')
    .map((action) => action.actionId);
  const storedGuard = MissionRuntime.prototype.verifyCriterionEvidence.call(
    { allowedRoots: [] }, storedMission, primaryCriterion, successfulActionIds
  );
  const replayCandidateMission = structuredClone(storedMission);
  const replayReportAction = replayCandidateMission.waves
    .flatMap((wave) => wave.actions)
    .find((action) => action.expectedToolName === 'filesystem.createTextFile');
  replayReportAction.arguments.content = report;
  const replayGuard = MissionRuntime.prototype.verifyCriterionEvidence.call(
    { allowedRoots: [] }, replayCandidateMission, primaryCriterion, successfulActionIds
  );
  const storedBinding = storedGuard.checks.find((check) => check.checkId === 'observed_news_article_citations_bound');
  const replayBinding = replayGuard.checks.find((check) => check.checkId === 'observed_news_article_citations_bound');
  assert.equal(storedGuard.passed, false);
  assert.deepEqual(storedGuard.reasons, ['observed_news_article_citations_bound']);
  assert.equal(storedBinding.observed[0].citedArticleCount, 0);
  assert.equal(replayGuard.passed, true);
  assert.equal(replayBinding.expected.minimum, 3);
  assert.equal(replayBinding.observed[0].citedArticleCount, 3);

  for (const artifact of replay.artifacts) {
    const actual = await fileEvidence(join(replayRoot, artifact.path));
    assert.equal(actual.sha256, artifact.sha256, `artifact-hash-mismatch:${artifact.path}`);
  }
  assert.equal(replay.verification.filenameSearchMatchCount, 1);
  assert.equal(replay.verification.reportReadHashMatched, true);
  assert.equal(replay.verification.pngCardCount, 3);
  assert.deepEqual(replay.verification.pngDimensions, ['1200x675']);
  assert.equal(replay.verification.zipEntryCount, 4);

  const protectedAfter = {
    result: await fileEvidence(join(sourceRoot, 'result.json')),
    workspace: await treeManifest(join(sourceRoot, 'workspace')),
    emailLedger: await fileEvidence(emailLedgerPath)
  };
  assert.equal(protectedBefore.result.sha256, protectedAfter.result.sha256);
  assert.equal(protectedBefore.workspace.manifestSha256, protectedAfter.workspace.manifestSha256);
  assert.equal(protectedBefore.emailLedger.sha256, protectedAfter.emailLedger.sha256);

  const replayStartedAt = replay.startedAt;
  const ledgerPredatesReplay = Date.parse(protectedAfter.emailLedger.lastModifiedAt) < Date.parse(replayStartedAt);
  assert.equal(ledgerPredatesReplay, true);
  const result = {
    reverifyVersion: 'c01-local-only-reverify-v1',
    status: 'SUCCESS',
    reverifiedAt,
    executionBoundary: {
      networkCalls: 0,
      webCalls: 0,
      emailCalls: 0,
      emailOmitted: true,
      emailAdapterConstructed: false,
      sourceMissionRerun: false
    },
    exactArticleUrlCount: articleCardBindings.length,
    articleCardBindings,
    productCompletionGuard: {
      storedHomepageReportAccepted: storedGuard.passed,
      storedReportReasons: storedGuard.reasons,
      storedReportCitedArticleCount: storedBinding.observed[0].citedArticleCount,
      replayExactArticleReportAccepted: replayGuard.passed,
      replayReportCitedArticleCount: replayBinding.observed[0].citedArticleCount,
      retainedProvenance: replayBinding.observed[0].citedArticles
    },
    artifactVerification: {
      reportHashMatched: true,
      filenameSearchMatchCount: 1,
      reportReadHashMatched: true,
      pngCount: 3,
      pngDimensions: ['1200x675'],
      zipEntryCount: 4,
      allArtifactHashesMatched: true
    },
    originalProtection: {
      replaySourceManifestSha256Before: storedBefore.manifestSha256,
      replaySourceManifestSha256After: storedAfter.manifestSha256,
      currentSourceManifestSha256: currentSource.manifestSha256,
      replaySourceTreeByteIdentical: true,
      reverifyBefore: protectedBefore,
      reverifyAfter: protectedAfter,
      resultByteIdentical: protectedBefore.result.sha256 === protectedAfter.result.sha256,
      workspaceByteIdentical: protectedBefore.workspace.manifestSha256 === protectedAfter.workspace.manifestSha256,
      emailLedgerByteIdentical: protectedBefore.emailLedger.sha256 === protectedAfter.emailLedger.sha256,
      emailLedgerLastModifiedBeforeReplay: ledgerPredatesReplay
    }
  };
  await writeFile(join(replayRoot, 'reverification.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
