import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const sourceRoot = resolve(
  repositoryRoot,
  'artifacts/complex-workflow-50-audit/2026-09-03-retest-c01-final-v1/01'
);
const outputRoot = resolve(
  repositoryRoot,
  'artifacts/complex-workflow-50-audit/2026-09-03-retest-c01-local-replay-v1'
);
const workspaceRoot = join(outputRoot, 'workspace');
const sourceTaskPath = join(sourceRoot, 'result.json');
const sourceEvidencePath = join(sourceRoot, 'audit', 'evidence.jsonl');
const sharedEmailLedgerPath = resolve(repositoryRoot, 'artifacts/complex-workflow-50-audit/email-idempotency-v1.jsonl');
const allowedToolSequence = [
  'filesystem.createTextFile',
  'filesystem.searchFiles',
  'filesystem.readText',
  'visual.createCards',
  'archive.createZip'
];
const forbiddenTools = [
  'news.fetchHeadlines',
  'browser.search',
  'browser.open',
  'email.send',
  'shell.execute'
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const toPortablePath = (value) => value.split(sep).join('/');
const relativeOutputPath = (value) => toPortablePath(relative(outputRoot, value));

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fileIntegrity(path) {
  const bytes = await readFile(path);
  const details = await stat(path);
  return { path, size: bytes.length, sha256: sha256(bytes), lastModifiedAt: details.mtime.toISOString() };
}

async function createTreeManifest(root) {
  const entries = [];
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = toPortablePath(relative(root, path));
      if (child.isDirectory()) {
        await walk(path);
        continue;
      }
      if (child.isSymbolicLink()) {
        const target = await readlink(path);
        const bytes = Buffer.from(target, 'utf8');
        entries.push({ relativePath, type: 'symlink', size: bytes.length, sha256: sha256(bytes), target });
        continue;
      }
      if (!child.isFile()) continue;
      const bytes = await readFile(path);
      entries.push({ relativePath, type: 'file', size: bytes.length, sha256: sha256(bytes) });
    }
  };
  await walk(root);
  const manifestBytes = Buffer.from(`${JSON.stringify(entries)}\n`, 'utf8');
  return {
    manifestVersion: 'c01-source-tree-sha256-v1',
    root,
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    symlinkCount: entries.filter((entry) => entry.type === 'symlink').length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    manifestSha256: sha256(manifestBytes),
    entries
  };
}

function getSingleStoredTask(storedResult, toolName) {
  const matches = (storedResult.tasks ?? []).filter((task) => task?.plan?.action?.toolName === toolName);
  assert.equal(matches.length, 1, `expected-one-stored-task:${toolName}:${matches.length}`);
  return matches[0];
}

function replaceExactlyOnce(text, search, replacement, label) {
  const occurrences = text.split(search).length - 1;
  assert.equal(occurrences, 1, `expected-one-report-fragment:${label}:${occurrences}`);
  return text.replace(search, replacement);
}

function stripSourceSuffix(title, source) {
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

function selectArticles(storedEvidence, storedCards) {
  const newsRows = storedEvidence.filter((row) => row.toolName === 'news.fetchHeadlines');
  assert.ok(newsRows.length > 0, 'stored-news-evidence-required');
  const identities = new Map();
  for (const row of newsRows) {
    const news = row.adapterEvidence?.news;
    assert.ok(Array.isArray(news?.items), `stored-news-items-required:${row.evidenceId ?? 'unknown'}`);
    for (const item of news.items) {
      const identity = [item.title, item.url, item.source, item.publishedAt].join('\u0000');
      const existing = identities.get(identity) ?? {
        title: item.title,
        url: item.url,
        source: item.source,
        sourceUrl: item.sourceUrl,
        publishedAt: item.publishedAt,
        origins: []
      };
      existing.origins.push({
        evidenceId: row.evidenceId,
        taskId: row.taskId,
        category: news.category,
        rank: item.rank,
        retrievedAt: news.retrievedAt
      });
      identities.set(identity, existing);
    }
  }

  assert.equal(storedCards.length, 3, `expected-three-stored-cards:${storedCards.length}`);
  const articles = storedCards.map((card, index) => {
    const source = String(card.subtitle ?? '').replace(/^출처:\s*/u, '').trim();
    const candidates = [...identities.values()].filter((item) =>
      item.source === source && stripSourceSuffix(item.title, item.source) === card.title
    );
    assert.equal(candidates.length, 1, `article-identity-mismatch:${index + 1}:${candidates.length}`);
    const article = candidates[0];
    assert.match(article.url, /^https:\/\/news\.google\.com\/rss\/articles\//u);
    assert.match(article.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    return {
      index: index + 1,
      title: article.title,
      displayTitle: card.title,
      source: article.source,
      publishedAt: article.publishedAt,
      url: article.url,
      urlSha256: sha256(article.url),
      storedPublisherHomepage: article.sourceUrl,
      origins: article.origins
    };
  });
  assert.equal(new Set(articles.map((article) => article.url)).size, 3, 'article-urls-must-be-unique');
  return articles;
}

function createCorrectedReport(originalContent, articles) {
  let content = replaceExactlyOnce(
    originalContent,
    '> 출처: Google News RSS (live=true, replay=false)',
    '> 원본 출처: Google News RSS (저장 evidence)  \n> 재생 정책: local-only / networkCalls=0 / emailCalls=0 / emailOmitted=true',
    'live-header'
  );
  for (const article of articles) {
    const originalPublishedAt = article.publishedAt.replace('.000Z', 'Z');
    content = replaceExactlyOnce(
      content,
      `- 출처 URL: ${article.storedPublisherHomepage}  \n- 게재 일시: ${originalPublishedAt}`,
      `- 기사 URL: ${article.url}  \n- 게재 일시: ${article.publishedAt}`,
      `article-${article.index}-citation`
    );
  }
  const footer = /실시간 조회 live=true \/ replay=false \/ retrievedAt: ([^*\r\n]+)\*/u;
  const footerMatches = [...content.matchAll(new RegExp(footer.source, 'gu'))];
  assert.equal(footerMatches.length, 1, `expected-one-live-footer:${footerMatches.length}`);
  content = content.replace(
    footer,
    '저장 evidence replay=true / networkCalls=0 / emailCalls=0 / emailOmitted=true / originalRetrievedAt: $1*'
  );
  for (const article of articles) {
    assert.equal(content.split(article.url).length - 1, 1, `article-url-must-appear-once:${article.index}`);
    assert.equal(content.includes(article.storedPublisherHomepage), false, `publisher-homepage-drift:${article.index}`);
  }
  assert.equal(content.includes('live=true'), false, 'local-replay-report-must-not-claim-live-fetch');
  return content;
}

function resultTaskId(task) {
  return task.taskId ?? task.id ?? null;
}

async function main() {
  assert.equal(await pathExists(sourceTaskPath), true, `missing-stored-task:${sourceTaskPath}`);
  assert.equal(await pathExists(sourceEvidencePath), true, `missing-stored-evidence:${sourceEvidencePath}`);
  assert.equal(await pathExists(outputRoot), false, `refusing-existing-output-root:${outputRoot}`);

  const startedAt = new Date().toISOString();
  const sourceManifestBefore = await createTreeManifest(sourceRoot);
  const emailLedgerBefore = await fileIntegrity(sharedEmailLedgerPath);
  await mkdir(workspaceRoot, { recursive: true });

  const policy = {
    policyVersion: 'c01-local-only-replay-policy-v1',
    mode: 'local-only-stored-evidence-replay',
    sourceRoot,
    outputRoot,
    semanticInputPaths: [sourceTaskPath, sourceEvidencePath],
    protectedExternalPaths: [sharedEmailLedgerPath],
    allowedToolSequence,
    forbiddenTools,
    networkCalls: 0,
    networkCallAttempts: 0,
    emailCalls: 0,
    emailOmitted: true,
    emailAdapterConstructed: false,
    emailAdapterExecuted: false,
    missionRuntimeInvoked: false,
    sourceMissionRerun: false
  };
  await writeJson(join(outputRoot, 'policy.json'), policy);
  await writeJson(join(outputRoot, 'source-manifest-before.json'), sourceManifestBefore);

  const storedResult = JSON.parse(await readFile(sourceTaskPath, 'utf8'));
  const storedEvidence = (await readFile(sourceEvidencePath, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const reportTask = getSingleStoredTask(storedResult, 'filesystem.createTextFile');
  const searchTask = getSingleStoredTask(storedResult, 'filesystem.searchFiles');
  const readTask = getSingleStoredTask(storedResult, 'filesystem.readText');
  const cardsTask = getSingleStoredTask(storedResult, 'visual.createCards');
  const archiveTask = getSingleStoredTask(storedResult, 'archive.createZip');
  const storedCards = cardsTask.plan.action.arguments?.cards ?? [];
  const articles = selectArticles(storedEvidence, storedCards);
  const reportContent = createCorrectedReport(reportTask.plan.action.arguments.content, articles);

  const networkGuard = { attempts: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkGuard.attempts += 1;
    throw new Error('c01-local-replay-network-blocked');
  };

  const actionEvidence = [];
  let sourceManifestAfter;
  try {
    const {
      ArchiveCreateZipToolAdapter,
      FileReadTextToolAdapter,
      FileSearchToolAdapter,
      FileSystemToolAdapter,
      UndoJournal,
      VisualCreateCardsToolAdapter
    } = await import('../apps/pc-agent/src/pc-agent-runtime.js');

    const undoJournal = new UndoJournal();
    const createAdapter = new FileSystemToolAdapter({ allowedRoots: [workspaceRoot], undoJournal });
    const searchAdapter = new FileSearchToolAdapter({
      allowedRoots: [workspaceRoot],
      maxResults: Number(searchTask.plan.action.arguments?.maxResults ?? 5)
    });
    const readAdapter = new FileReadTextToolAdapter({ allowedRoots: [workspaceRoot] });
    const cardsAdapter = new VisualCreateCardsToolAdapter({ allowedRoots: [workspaceRoot], undoJournal });
    const archiveAdapter = new ArchiveCreateZipToolAdapter({ allowedRoots: [workspaceRoot], undoJournal });

    const reportPath = join(workspaceRoot, 'hot-news-report.md');
    const createStartedAt = new Date().toISOString();
    const createResult = await createAdapter.execute(
      { path: reportPath, content: reportContent, allowOverwrite: false },
      { taskId: 'c01-local-replay-create-report' }
    );
    assert.equal(createResult.status, 'success', JSON.stringify(createResult));
    const reportBytes = await readFile(reportPath);
    const reportSha256 = sha256(reportBytes);
    actionEvidence.push({
      order: 1,
      toolName: 'filesystem.createTextFile',
      sourceTaskId: resultTaskId(reportTask),
      startedAt: createStartedAt,
      finishedAt: new Date().toISOString(),
      status: createResult.status,
      outputPath: relativeOutputPath(reportPath),
      bytes: reportBytes.length,
      sha256: reportSha256,
      rollbackAvailable: createResult.rollbackAvailable
    });

    const searchStartedAt = new Date().toISOString();
    const searchResult = await searchAdapter.execute({
      query: searchTask.plan.action.arguments.query,
      scope: 'workspace',
      extensions: ['md']
    });
    assert.equal(searchResult.status, 'success', JSON.stringify(searchResult));
    assert.equal(searchResult.matchCount, 1, `expected-one-report-search-match:${searchResult.matchCount}`);
    assert.equal(resolve(searchResult.matches[0].path), resolve(reportPath), 'filename-search-returned-wrong-path');
    actionEvidence.push({
      order: 2,
      toolName: 'filesystem.searchFiles',
      sourceTaskId: resultTaskId(searchTask),
      startedAt: searchStartedAt,
      finishedAt: new Date().toISOString(),
      status: searchResult.status,
      query: searchResult.query,
      scope: searchResult.scope,
      matchCount: searchResult.matchCount,
      matches: searchResult.matches.map((match) => ({
        path: relativeOutputPath(match.path),
        size: match.size
      }))
    });

    const readStartedAt = new Date().toISOString();
    const readResult = await readAdapter.execute({
      path: reportPath,
      maxChars: Number(readTask.plan.action.arguments?.maxChars ?? 12000)
    });
    assert.equal(readResult.status, 'success', JSON.stringify(readResult));
    assert.equal(readResult.truncated, false, 'report-read-must-not-be-truncated');
    assert.equal(readResult.stdoutPreview, reportContent, 'report-read-content-mismatch');
    assert.equal(readResult.contentSha256, reportSha256, 'report-read-hash-mismatch');
    actionEvidence.push({
      order: 3,
      toolName: 'filesystem.readText',
      sourceTaskId: resultTaskId(readTask),
      startedAt: readStartedAt,
      finishedAt: new Date().toISOString(),
      status: readResult.status,
      path: relativeOutputPath(reportPath),
      bytes: readResult.bytes,
      returnedChars: readResult.returnedChars,
      truncated: readResult.truncated,
      contentSha256: readResult.contentSha256
    });

    const cardsDirectory = join(workspaceRoot, 'cards');
    const replayCards = storedCards.map((card, index) => ({
      ...card,
      footer: `${articles[index].source} | URL SHA-256 ${articles[index].urlSha256} | ${articles[index].publishedAt}`
    }));
    const cardsStartedAt = new Date().toISOString();
    const cardsResult = await cardsAdapter.execute({
      outputDirectory: cardsDirectory,
      width: Number(cardsTask.plan.action.arguments.width),
      height: Number(cardsTask.plan.action.arguments.height),
      cards: replayCards
    }, { taskId: 'c01-local-replay-create-cards' });
    assert.equal(cardsResult.status, 'success', JSON.stringify(cardsResult));
    assert.equal(cardsResult.cardCount, 3, `expected-three-cards:${cardsResult.cardCount}`);
    for (const card of cardsResult.cards) {
      assert.equal(card.width, 1200, `unexpected-card-width:${card.name}`);
      assert.equal(card.height, 675, `unexpected-card-height:${card.name}`);
      assert.match(card.sha256, /^[a-f0-9]{64}$/u);
    }
    actionEvidence.push({
      order: 4,
      toolName: 'visual.createCards',
      sourceTaskId: resultTaskId(cardsTask),
      startedAt: cardsStartedAt,
      finishedAt: new Date().toISOString(),
      status: cardsResult.status,
      cardCount: cardsResult.cardCount,
      width: 1200,
      height: 675,
      cards: cardsResult.cards.map((card, index) => ({
        name: card.name,
        path: relativeOutputPath(card.path),
        width: card.width,
        height: card.height,
        size: card.size,
        sha256: card.sha256,
        articleUrl: articles[index].url,
        articleUrlSha256: articles[index].urlSha256
      }))
    });

    const zipPath = join(workspaceRoot, 'hot-news-package.zip');
    const archiveInputs = [
      { path: reportPath, archiveName: 'hot-news-report.md', sha256: reportSha256 },
      ...cardsResult.cards.map((card) => ({ path: card.path, archiveName: card.name, sha256: card.sha256 }))
    ];
    const archiveStartedAt = new Date().toISOString();
    const archiveResult = await archiveAdapter.execute({
      path: zipPath,
      inputs: archiveInputs
    }, { taskId: 'c01-local-replay-create-zip' });
    assert.equal(archiveResult.status, 'success', JSON.stringify(archiveResult));
    assert.equal(archiveResult.entryCount, 4, `expected-four-zip-entries:${archiveResult.entryCount}`);
    assert.deepEqual(
      archiveResult.entries.map((entry) => entry.name),
      archiveInputs.map((input) => input.archiveName),
      'zip-entry-order-or-name-mismatch'
    );
    actionEvidence.push({
      order: 5,
      toolName: 'archive.createZip',
      sourceTaskId: resultTaskId(archiveTask),
      startedAt: archiveStartedAt,
      finishedAt: new Date().toISOString(),
      status: archiveResult.status,
      outputPath: relativeOutputPath(zipPath),
      sha256: archiveResult.sha256,
      entryCount: archiveResult.entryCount,
      entries: archiveResult.entries
    });

    assert.deepEqual(actionEvidence.map((action) => action.toolName), allowedToolSequence);
    assert.equal(networkGuard.attempts, 0, `unexpected-network-attempts:${networkGuard.attempts}`);

    sourceManifestAfter = await createTreeManifest(sourceRoot);
    const emailLedgerAfter = await fileIntegrity(sharedEmailLedgerPath);
    const sourceTreeByteIdentical =
      sourceManifestBefore.manifestSha256 === sourceManifestAfter.manifestSha256 &&
      isDeepStrictEqual(sourceManifestBefore.entries, sourceManifestAfter.entries);
    assert.equal(sourceTreeByteIdentical, true, 'source-case-tree-changed-during-local-replay');
    assert.equal(emailLedgerBefore.sha256, emailLedgerAfter.sha256, 'email-ledger-changed-during-local-replay');
    await writeJson(join(outputRoot, 'source-manifest-after.json'), sourceManifestAfter);

    const finishedAt = new Date().toISOString();
    const evidence = {
      evidenceVersion: 'c01-local-only-replay-evidence-v1',
      status: 'PASS',
      startedAt,
      finishedAt,
      networkCalls: 0,
      networkCallAttempts: networkGuard.attempts,
      emailCalls: 0,
      emailOmitted: true,
      forbiddenToolCalls: [],
      sourceSemanticReads: [
        { kind: 'stored-task-result', path: sourceTaskPath, sha256: sha256(await readFile(sourceTaskPath)) },
        { kind: 'stored-execution-evidence', path: sourceEvidencePath, sha256: sha256(await readFile(sourceEvidencePath)) }
      ],
      sourceTree: {
        beforeManifestSha256: sourceManifestBefore.manifestSha256,
        afterManifestSha256: sourceManifestAfter.manifestSha256,
        fileCountBefore: sourceManifestBefore.fileCount,
        fileCountAfter: sourceManifestAfter.fileCount,
        totalBytesBefore: sourceManifestBefore.totalBytes,
        totalBytesAfter: sourceManifestAfter.totalBytes,
        byteIdentical: sourceTreeByteIdentical
      },
      emailLedger: {
        before: emailLedgerBefore,
        after: emailLedgerAfter,
        byteIdentical: emailLedgerBefore.sha256 === emailLedgerAfter.sha256
      },
      articles,
      actions: actionEvidence
    };
    await writeJson(join(outputRoot, 'evidence.json'), evidence);

    const artifacts = [
      { type: 'report', path: relativeOutputPath(reportPath), size: reportBytes.length, sha256: reportSha256 },
      ...cardsResult.cards.map((card) => ({
        type: 'png-card',
        path: relativeOutputPath(card.path),
        size: card.size,
        sha256: card.sha256,
        width: card.width,
        height: card.height
      })),
      {
        type: 'zip',
        path: relativeOutputPath(zipPath),
        size: (await stat(zipPath)).size,
        sha256: archiveResult.sha256,
        entryCount: archiveResult.entryCount
      }
    ];
    const result = {
      resultVersion: 'c01-local-only-replay-result-v1',
      status: 'PASS',
      sourceCase: '2026-09-03-retest-c01-final-v1/01',
      sourceRoot,
      outputRoot,
      startedAt,
      finishedAt,
      networkCalls: 0,
      emailCalls: 0,
      emailOmitted: true,
      actionCount: actionEvidence.length,
      actionToolSequence: actionEvidence.map((action) => action.toolName),
      articleCount: articles.length,
      articles,
      artifacts,
      verification: {
        reportArticleUrlCount: articles.filter((article) => reportContent.includes(article.url)).length,
        publisherHomepageDriftCount: articles.filter((article) => reportContent.includes(article.storedPublisherHomepage)).length,
        filenameSearchMatchCount: searchResult.matchCount,
        reportReadHashMatched: readResult.contentSha256 === reportSha256,
        pngCardCount: cardsResult.cardCount,
        pngDimensions: [...new Set(cardsResult.cards.map((card) => `${card.width}x${card.height}`))],
        zipEntryCount: archiveResult.entryCount,
        sourceTreeBeforeManifestSha256: sourceManifestBefore.manifestSha256,
        sourceTreeAfterManifestSha256: sourceManifestAfter.manifestSha256,
        sourceTreeByteIdentical,
        emailLedgerSha256Before: emailLedgerBefore.sha256,
        emailLedgerSha256After: emailLedgerAfter.sha256,
        emailLedgerByteIdentical: emailLedgerBefore.sha256 === emailLedgerAfter.sha256
      }
    };
    await writeJson(join(outputRoot, 'result.json'), result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(async (error) => {
  const failure = {
    resultVersion: 'c01-local-only-replay-result-v1',
    status: 'FAIL',
    sourceRoot,
    outputRoot,
    networkCalls: 0,
    emailCalls: 0,
    emailOmitted: true,
    error: String(error?.stack ?? error)
  };
  // Refusing a rerun must never overwrite a previously successful replay result.
  const resultPath = join(outputRoot, 'result.json');
  if (await pathExists(outputRoot) && !(await pathExists(resultPath))) {
    await writeJson(resultPath, failure).catch(() => {});
  }
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
});
