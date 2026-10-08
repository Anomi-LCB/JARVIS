import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResearchWatch, validateResearchSources } from '../scripts/research-watch.mjs';
import { acquireOwnedProcessLock } from '../packages/shared/src/owned-process-lock.js';

async function lockDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-research-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'owner.lock');
}

function lockChild(t, lockPath, { orphanRecovery = false } = {}) {
  const moduleUrl = new URL('../packages/shared/src/owned-process-lock.js', import.meta.url).href;
  const code = `
    import { acquireOwnedProcessLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lock = acquireOwnedProcessLock({ lockPath: ${JSON.stringify(lockPath)}, now: () => '2000-01-01T00:00:00.000Z' });
      if (${orphanRecovery}) acquireOwnedProcessLock({ lockPath: ${JSON.stringify(lockPath + '.recovery')} });
      process.send({ status: 'acquired', record: lock.record });
      setInterval(() => {}, 1000);
    } catch (error) { process.send({ status: 'error', code: error.code }, () => process.exit(0)); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const message = once(child, 'message').then(([value]) => value);
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  t.after(stop);
  return { child, message, stop };
}

async function fixture(t, handler, paths = ['/document']) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-research-watch-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { version: 1, allowedHosts: ['127.0.0.1'], sources: paths.map((path, index) => ({ id: `source-${index}`, url: origin + path })) };
  const options = { sourcesPath: join(directory, 'sources.json'), statePath: join(directory, 'state.json'), outputPath: join(directory, 'report.json'),
    allowLocalHttpForTests: true, timeoutMs: 2000 };
  await writeFile(options.sourcesPath, JSON.stringify(config));
  return { options, config, origin };
}

test('research watch establishes a quiet baseline, sends validators, detects changes and retains no body', async t => {
  let revision = 1;
  const requests = [];
  const { options, origin } = await fixture(t, (request, response) => {
    requests.push(request.headers);
    const etag = `"v${revision}"`;
    response.setHeader('etag', etag);
    response.setHeader('last-modified', 'Mon, 14 Sep 2026 00:00:00 GMT');
    if (request.headers['if-none-match'] === etag) return response.writeHead(304).end();
    response.setHeader('content-type', 'text/html');
    response.end(`<script>globalThis.executeMe = true</script>body-secret-${revision}`);
  });
  const baseline = await runResearchWatch(options);
  assert.equal(baseline.actionable, false);
  assert.equal(baseline.summary.newSources, 1);
  assert.equal(baseline.sources[0].changed, false);
  const unchanged = await runResearchWatch(options);
  assert.equal(unchanged.sources[0].httpStatus, 304);
  assert.equal(unchanged.actionable, false);
  assert.equal(requests[1]['if-none-match'], '"v1"');
  assert.equal(requests[1]['if-modified-since'], 'Mon, 14 Sep 2026 00:00:00 GMT');
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[0].cookie, undefined);
  revision = 2;
  const changed = await runResearchWatch(options);
  assert.equal(changed.actionable, true);
  assert.equal(changed.summary.changed, 1);
  assert.notEqual(changed.sources[0].contentHash, baseline.sources[0].contentHash);
  const stateText = await readFile(options.statePath, 'utf8');
  const reportText = await readFile(options.outputPath, 'utf8');
  assert.equal(stateText.includes('body-secret'), false);
  assert.equal(reportText.includes('<script>'), false);
  assert.equal(globalThis.executeMe, undefined);
  assert.equal(JSON.parse(stateText).sources[origin + '/document'].contentHash, changed.sources[0].contentHash);
});

test('research watch isolates HTTP, streaming-size, timeout and redirect failures', async t => {
  const { options } = await fixture(t, (request, response) => {
    response.setHeader('content-type', 'text/plain');
    if (request.url === '/error') return response.writeHead(503).end('private error body');
    if (request.url === '/large') { response.write('x'.repeat(200)); return response.end('x'.repeat(200)); }
    if (request.url === '/slow') return;
    if (request.url === '/redirect') return response.writeHead(302, { location: 'https://example.com/private' }).end();
    response.end('healthy');
  }, ['/error', '/large', '/slow', '/redirect', '/healthy']);
  const report = await runResearchWatch({ ...options, timeoutMs: 100, maxBytes: 256, concurrency: 2 });
  assert.equal(report.summary.errors, 4);
  assert.equal(report.summary.newSources, 1);
  assert.equal(report.actionable, true);
  assert.deepEqual(report.sources.map(entry => entry.error), ['http_503', 'response_too_large', 'request_timeout', 'url_not_allowed', null]);
  assert.equal((await readFile(options.outputPath, 'utf8')).includes('private error body'), false);
});

test('research watch preserves the last successful baseline across failures and compares recovery', async t => {
  let mode = 'first';
  const { options } = await fixture(t, (request, response) => {
    response.setHeader('content-type', 'text/plain');
    if (mode === 'error') return response.writeHead(500).end('error');
    response.end(mode);
  });
  const baseline = await runResearchWatch(options);
  mode = 'error';
  const failed = await runResearchWatch(options);
  assert.equal(failed.sources[0].contentHash, baseline.sources[0].contentHash);
  assert.equal(failed.sources[0].lastSuccessAt, baseline.sources[0].lastSuccessAt);
  mode = 'recovered';
  const recovered = await runResearchWatch(options);
  assert.equal(recovered.sources[0].status, 'changed');
});

test('research watch handles 304 without a baseline by retrying and refuses repeated unverifiable 304', async t => {
  let attempts = 0;
  let always304 = false;
  const { options } = await fixture(t, (request, response) => {
    attempts++;
    if (always304 || attempts === 1) return response.writeHead(304).end();
    response.writeHead(200, { 'content-type': 'application/atom+xml' }).end('<feed>baseline</feed>');
  });
  const report = await runResearchWatch(options);
  assert.equal(attempts, 2);
  assert.equal(report.summary.newSources, 1);
  await rm(options.statePath);
  always304 = true;
  const failed = await runResearchWatch(options);
  assert.equal(attempts, 4);
  assert.equal(failed.sources[0].error, 'not_modified_without_baseline');
});

test('research watch follows allowed redirects and uses validators only for their matching final URL', async t => {
  const seen = [];
  const { options, origin } = await fixture(t, (request, response) => {
    seen.push({ url: request.url, etag: request.headers['if-none-match'] });
    if (request.url === '/document') return response.writeHead(302, { location: '/final' }).end();
    if (request.headers['if-none-match'] === '"final"') return response.writeHead(304).end();
    response.writeHead(200, { 'content-type': 'text/plain', etag: '"final"' }).end('final content');
  });
  await runResearchWatch(options);
  const report = await runResearchWatch(options);
  assert.equal(report.sources[0].finalUrl, origin + '/final');
  assert.equal(report.sources[0].httpStatus, 304);
  assert.equal(seen[2].etag, undefined);
  assert.equal(seen[3].etag, '"final"');
});

test('research watch detects same-content 200 as unchanged, and newly configured sources as baselines', async t => {
  const { options, config, origin } = await fixture(t, (request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('same'));
  await runResearchWatch(options);
  config.sources.push({ id: 'added', url: origin + '/added' });
  await writeFile(options.sourcesPath, JSON.stringify(config));
  const report = await runResearchWatch(options);
  assert.equal(report.summary.unchanged, 1);
  assert.equal(report.summary.newSources, 1);
  assert.equal(report.actionable, false);
});

const RELEASE_URL = 'https://github.com/microsoft/agent-lightning/releases.atom';
function releaseFeed({ jwt = 'header.payload.signature', version = 'v1.0.1', updated = '2026-08-24T09:45:48Z',
  description = 'Release notes', image = 'image.png', width = '100', secondEntry = true } = {}) {
  return `<feed><entry><id>${version}</id><updated>${updated}</updated><content>${description}
    &lt;img src=&quot;https://private-user-images.githubusercontent.com/123/${image}?jwt=${jwt}&amp;width=${width}&quot; /&gt;
    &lt;a href=&quot;https://private-user-images.githubusercontent.com/123/${image}?jwt=${jwt}&quot;&gt;Image&lt;/a&gt;
  </content></entry>${secondEntry ? '<entry><id>v1.0.0</id></entry>' : ''}</feed>`;
}

async function githubFixture(t, url = RELEASE_URL) {
  const { options } = await fixture(t, (request, response) => response.end('unused'));
  await writeFile(options.sourcesPath, JSON.stringify({ version: 1, allowedHosts: ['github.com'], sources: [{ id: 'release', url }] }));
  return options;
}

test('GitHub release watch ignores rotating image JWTs but preserves release edits, deletions and image identity', async t => {
  const options = await githubFixture(t);
  let content = releaseFeed();
  let fail = false;
  options.fetchImpl = async () => {
    if (fail) return new Response('unavailable', { status: 503 });
    const bytes = Buffer.from(content);
    // Deliberately split an image token across network chunks.
    const at = content.indexOf('payload') + 3;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, at)); controller.enqueue(bytes.subarray(at)); controller.close();
    } }), { headers: { 'content-type': 'application/atom+xml; charset=utf-8' } });
  };
  const baseline = await runResearchWatch(options);
  content = releaseFeed({ jwt: 'header.rotatedPayload.rotatedSignature' });
  const rotated = await runResearchWatch(options);
  assert.equal(rotated.actionable, false);
  assert.equal(rotated.sources[0].status, 'unchanged');
  assert.notEqual(rotated.sources[0].contentHash, baseline.sources[0].contentHash);
  assert.equal(rotated.sources[0].comparisonHash, baseline.sources[0].comparisonHash);
  assert.equal(rotated.sources[0].comparisonMethod, 'github-release-atom-image-jwt-v1');
  assert.equal((await readFile(options.statePath, 'utf8')).includes('rotatedPayload'), false);
  fail = true;
  const unavailable = await runResearchWatch(options);
  assert.equal(unavailable.sources[0].comparisonHash, rotated.sources[0].comparisonHash);
  fail = false;
  const recovered = await runResearchWatch(options);
  assert.equal(recovered.sources[0].status, 'unchanged');
  for (const change of [{ version: 'v1.0.2' }, { updated: '2026-09-14T00:00:00Z' }, { description: 'Corrected release notes' },
    { image: 'replacement.png' }, { width: '200' }, { secondEntry: false }]) {
    content = releaseFeed();
    await runResearchWatch(options);
    content = releaseFeed(change);
    const edited = await runResearchWatch(options);
    assert.equal(edited.sources[0].status, 'changed', JSON.stringify(change));
    assert.equal(edited.actionable, true);
  }
});

test('image-token normalization is restricted to GitHub release Atom feeds and the observed image host', async t => {
  for (const { url, contentType, imageHost } of [
    { url: 'https://github.com/microsoft/agent-lightning/commits/main.atom', contentType: 'application/atom+xml' },
    { url: RELEASE_URL, contentType: 'text/html' },
    { url: RELEASE_URL, contentType: 'application/atom+xml', imageHost: 'other.example.com' }
  ]) {
    const options = await githubFixture(t, url);
    let body = releaseFeed().replaceAll('private-user-images.githubusercontent.com', imageHost ?? 'private-user-images.githubusercontent.com');
    options.fetchImpl = async () => new Response(body, { headers: { 'content-type': contentType } });
    await runResearchWatch(options);
    body = body.replaceAll('header.payload.signature', 'header.different.signature');
    const result = await runResearchWatch(options);
    assert.equal(result.sources[0].status, 'changed', `${url} ${contentType} ${imageHost ?? ''}`);
  }
});

test('historical raw release baseline is explicitly reset after an unconditional fetch and survives subsequent 304', async t => {
  const options = await githubFixture(t);
  const requests = [];
  let conditional304 = false;
  options.fetchImpl = async (url, request) => {
    requests.push(request.headers);
    return conditional304 && request.headers['if-none-match'] ? new Response(null, { status: 304 }) :
      new Response(releaseFeed(), { headers: { 'content-type': 'application/atom+xml', etag: '"release"' } });
  };
  const initial = await runResearchWatch(options);
  const state = JSON.parse(await readFile(options.statePath, 'utf8'));
  delete state.sources[RELEASE_URL].comparisonMethod;
  delete state.sources[RELEASE_URL].comparisonHash;
  await writeFile(options.statePath, JSON.stringify(state));
  conditional304 = true;
  const reset = await runResearchWatch(options);
  assert.equal(reset.sources[0].status, 'baseline_reset');
  assert.equal(reset.summary.baselinesReset, 1);
  assert.equal(reset.summary.changed, 0);
  assert.equal(reset.summary.unchanged, 0);
  assert.equal(reset.actionable, false);
  assert.equal(requests[1]['if-none-match'], '"release"');
  assert.equal(requests[2]['if-none-match'], undefined);
  assert.equal(reset.sources[0].comparisonHash, initial.sources[0].comparisonHash);
  const unchanged = await runResearchWatch(options);
  assert.equal(unchanged.sources[0].httpStatus, 304);
  assert.equal(unchanged.sources[0].status, 'unchanged');
  assert.equal(unchanged.sources[0].comparisonHash, initial.sources[0].comparisonHash);
});

test('research watch rejects unsafe URLs, invalid state and conflicting runs without overwriting files', async t => {
  const valid = { version: 1, allowedHosts: ['research.google'], sources: [{ id: 'google', url: 'https://research.google/blog/' }] };
  assert.equal(validateResearchSources(valid).sources.length, 1);
  for (const url of ['http://research.google/blog/', 'https://user:secret@research.google/blog/', 'https://research.google.evil.invalid/', 'https://research.google:8080/']) {
    assert.throws(() => validateResearchSources({ ...valid, sources: [{ id: 'bad', url }] }), /url_not_allowed/);
  }
  assert.throws(() => validateResearchSources({ version: 1, allowedHosts: ['127.0.0.1'], sources: [{ id: 'local', url: 'http://127.0.0.1/' }] }), /invalid_allowed_host/);
  const { options } = await fixture(t, (request, response) => response.end('unused'));
  await writeFile(options.statePath, '{malformed');
  await assert.rejects(runResearchWatch(options), /state_read_failed/);
  assert.equal(await readFile(options.statePath, 'utf8'), '{malformed');
  await writeFile(options.statePath + '.lock', 'other run');
  await assert.rejects(runResearchWatch(options), /state_locked/);
  assert.equal(await readFile(options.statePath + '.lock', 'utf8'), 'other run');
  await assert.rejects(runResearchWatch({ ...options, outputPath: options.statePath }), /paths_must_differ/);
});

test('owned research lock preserves a live owner regardless of age and recovers after actual process termination', async t => {
  const lockPath = await lockDirectory(t);
  const owner = lockChild(t, lockPath);
  const message = await owner.message;
  assert.equal(message.status, 'acquired');
  assert.equal(message.record.pid, owner.child.pid);
  assert.equal(message.record.createdAt, '2000-01-01T00:00:00.000Z');
  assert.throws(() => acquireOwnedProcessLock({ lockPath }), { code: 'OWNED_PROCESS_LOCK_BUSY' });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).nonce, message.record.nonce);
  await owner.stop();
  const recovered = acquireOwnedProcessLock({ lockPath });
  assert.equal(recovered.record.pid, process.pid);
  assert.notEqual(recovered.record.nonce, message.record.nonce);
  recovered.assertOwned();
  assert.equal(recovered.release(), true);
  assert.equal(recovered.release(), false);
});

test('owned research lock recovers a killed stale-lock reclaimer as well as its original lock', async t => {
  const lockPath = await lockDirectory(t);
  const owner = lockChild(t, lockPath, { orphanRecovery: true });
  assert.equal((await owner.message).status, 'acquired');
  await owner.stop();
  const recovered = acquireOwnedProcessLock({ lockPath });
  recovered.assertOwned();
  await assert.rejects(readFile(lockPath + '.recovery', 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(lockPath + '.recovery.recovery', 'utf8'), { code: 'ENOENT' });
  assert.equal(recovered.release(), true);
});

test('two process contenders for a dead owner cannot remove the winning live process lock', async t => {
  const lockPath = await lockDirectory(t);
  const oldOwner = lockChild(t, lockPath);
  assert.equal((await oldOwner.message).status, 'acquired');
  await oldOwner.stop();
  const first = lockChild(t, lockPath);
  const second = lockChild(t, lockPath);
  const results = await Promise.all([first.message, second.message]);
  assert.equal(results.filter(result => result.status === 'acquired').length, 1);
  assert.equal(results.filter(result => result.code === 'OWNED_PROCESS_LOCK_BUSY').length, 1);
  const winner = results.find(result => result.status === 'acquired');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).nonce, winner.record.nonce);
  assert.throws(() => acquireOwnedProcessLock({ lockPath }), { code: 'OWNED_PROCESS_LOCK_BUSY' });
});

test('old lock release cannot delete an absent or replacement owner record', async t => {
  const lockPath = await lockDirectory(t);
  const old = acquireOwnedProcessLock({ lockPath });
  await rm(lockPath);
  assert.equal(old.release(), false);
  const displaced = acquireOwnedProcessLock({ lockPath });
  await rm(lockPath);
  const replacement = acquireOwnedProcessLock({ lockPath });
  assert.throws(() => displaced.assertOwned(), { code: 'OWNED_PROCESS_LOCK_LOST' });
  assert.equal(displaced.release(), false);
  replacement.assertOwned();
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).nonce, replacement.record.nonce);
  assert.equal(replacement.release(), true);
});

test('research watch aborts persistence after losing ownership and leaves replacement lock intact', async t => {
  let replacement;
  const { options } = await fixture(t, (request, response) => response.end('unused'));
  await assert.rejects(runResearchWatch({ ...options, fetchImpl: async () => {
    await rm(options.statePath + '.lock');
    replacement = acquireOwnedProcessLock({ lockPath: options.statePath + '.lock' });
    return new Response('source', { headers: { 'content-type': 'text/plain' } });
  } }), { code: 'OWNED_PROCESS_LOCK_LOST' });
  await assert.rejects(readFile(options.statePath, 'utf8'), { code: 'ENOENT' });
  replacement.assertOwned();
  assert.equal(replacement.release(), true);
});
