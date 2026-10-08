import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireOwnedProcessLock } from '../packages/shared/src/owned-process-lock.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MIME = /^(text\/html|text\/plain|application\/(atom\+xml|rss\+xml|xml|json)|text\/xml)(?:;|$)/i;
const RAW_COMPARISON = 'raw-sha256-v1';
const GITHUB_RELEASE_COMPARISON = 'github-release-atom-image-jwt-v1';
// GitHub rewrites release-note image links with short-lived JWTs. Only the
// observed image URL attribute value is volatile; keep paths, other query
// parameters, entry IDs, timestamps, ordering and release-note text intact.
const GITHUB_IMAGE_JWT = /(\b(?:href|src)=(?:&quot;|["'])https:\/\/private-user-images\.githubusercontent\.com\/[A-Za-z0-9/_.,~%-]+\?jwt=)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?=&(?:amp;|quot;|#39;)?|["'\s<>]|$)/g;

function comparisonMethod(url, contentType) {
  const parsed = new URL(url);
  return parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/releases\.atom$/.test(parsed.pathname) &&
    /^application\/atom\+xml(?:;|$)/i.test(contentType) ? GITHUB_RELEASE_COMPARISON : RAW_COMPARISON;
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

export function acquireResearchWatchLock(path, { now = () => new Date().toISOString() } = {}) {
  try {
    return acquireOwnedProcessLock({ lockPath: path, now });
  } catch (error) {
    if (error.code === 'OWNED_PROCESS_LOCK_BUSY') throw failure('state_locked');
    if (error.code === 'OWNED_PROCESS_LOCK_INVALID') throw failure('state_locked_invalid');
    throw error;
  }
}

function checkedUrl(value, allowedHosts, allowLocalHttpForTests) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid_url'); }
  const localTest = allowLocalHttpForTests && url.hostname === '127.0.0.1' && url.protocol === 'http:';
  if ((!localTest && url.protocol !== 'https:') || url.username || url.password || url.hash ||
      (!localTest && url.port && url.port !== '443') || !allowedHosts.has(url.hostname)) {
    throw failure('url_not_allowed');
  }
  return url.href;
}

export function validateResearchSources(config, { allowLocalHttpForTests = false } = {}) {
  if (config?.version !== 1 || !Array.isArray(config.allowedHosts) || !config.allowedHosts.length ||
      !Array.isArray(config.sources) || !config.sources.length || config.sources.length > 64) {
    throw failure('invalid_sources_config');
  }
  const hosts = new Set(config.allowedHosts);
  for (const host of hosts) {
    if (typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host) || host.includes('..') ||
        (!allowLocalHttpForTests && (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)))) {
      throw failure('invalid_allowed_host');
    }
  }
  const ids = new Set();
  const urls = new Set();
  const sources = config.sources.map(source => {
    if (!source || typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(source.id) || ids.has(source.id)) {
      throw failure('invalid_source_id');
    }
    const url = checkedUrl(source.url, hosts, allowLocalHttpForTests);
    if (urls.has(url)) throw failure('duplicate_source_url');
    ids.add(source.id);
    urls.add(url);
    return { id: source.id, url, area: typeof source.area === 'string' ? source.area.slice(0, 100) : null };
  });
  return { hosts, sources };
}

async function readState(path) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sources: {} };
    throw failure('state_read_failed');
  }
  if (parsed?.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object' || Array.isArray(parsed.sources)) {
    throw failure('invalid_state');
  }
  for (const entry of Object.values(parsed.sources)) {
    if (!entry || typeof entry !== 'object' || (entry.contentHash != null && !/^[a-f0-9]{64}$/.test(entry.contentHash)) ||
        (entry.comparisonHash != null && !/^[a-f0-9]{64}$/.test(entry.comparisonHash))) {
      throw failure('invalid_state_entry');
    }
  }
  return parsed;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function headerValue(response, key, fallback = null) {
  const value = response.headers.get(key);
  return value === null ? fallback : value.slice(0, 1024);
}

async function inspectSource(source, previous, { hosts, timeoutMs, maxBytes, allowLocalHttpForTests, fetchImpl, now }) {
  let status = null;
  const observedAt = now();
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = source.url;
    let redirects = 0;
    let retryWithoutValidators = false;
    while (true) {
      url = checkedUrl(url, hosts, allowLocalHttpForTests);
      const headers = { accept: 'text/html, application/atom+xml, application/rss+xml, application/json, text/plain', 'user-agent': 'JARVIS-ResearchWatch/1.0' };
      if (!retryWithoutValidators && previous?.contentHash && url === (previous.finalUrl ?? source.url)) {
        if (previous.etag) headers['if-none-match'] = previous.etag;
        if (previous.lastModified) headers['if-modified-since'] = previous.lastModified;
      }
      const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal, credentials: 'omit' });
      status = response.status;
      if (REDIRECTS.has(status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || ++redirects > 5) throw failure('invalid_redirect');
        url = checkedUrl(new URL(location, url).href, hosts, allowLocalHttpForTests);
        continue;
      }
      if (status === 304) {
        await response.body?.cancel();
        // A raw-only historical baseline cannot establish a normalized one
        // from a 304. Fetch the body once without validators for that migration.
        if (!previous?.contentHash || url !== (previous.finalUrl ?? source.url) ||
            comparisonMethod(url, previous.contentType ?? '') !== (previous.comparisonMethod ?? RAW_COMPARISON)) {
          if (retryWithoutValidators) throw failure('not_modified_without_baseline');
          retryWithoutValidators = true;
          continue;
        }
        return { ...source, finalUrl: url, status: 'unchanged', httpStatus: status, observedAt, lastSuccessAt: observedAt,
          contentHash: previous.contentHash, byteLength: previous.byteLength, contentType: previous.contentType,
          comparisonMethod: previous.comparisonMethod ?? RAW_COMPARISON, comparisonHash: previous.comparisonHash ?? previous.contentHash,
          etag: headerValue(response, 'etag', previous.etag), lastModified: headerValue(response, 'last-modified', previous.lastModified),
          changed: false, error: null };
      }
      if (!response.ok || status !== 200) {
        await response.body?.cancel();
        throw failure(`http_${status}`);
      }
      const contentType = headerValue(response, 'content-type', '');
      if (!MIME.test(contentType)) {
        await response.body?.cancel();
        throw failure('unsupported_content_type');
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw failure('response_too_large');
      }
      const hash = createHash('sha256');
      const method = comparisonMethod(url, contentType);
      const chunks = method === GITHUB_RELEASE_COMPARISON ? [] : null;
      let byteLength = 0;
      // Only the bounded GitHub release feed is buffered for comparison. No
      // body, temporary image token, HTML, XML or instruction is persisted or executed.
      if (response.body) {
        for await (const chunk of response.body) {
          byteLength += chunk.byteLength;
          if (byteLength > maxBytes) throw failure('response_too_large');
          hash.update(chunk);
          chunks?.push(chunk);
        }
      }
      if (!byteLength) throw failure('empty_response');
      const contentHash = hash.digest('hex');
      const comparisonHash = chunks ? createHash('sha256').update(Buffer.concat(chunks).toString('utf8')
        .replace(GITHUB_IMAGE_JWT, '$1[volatile-github-image-jwt]')).digest('hex') : contentHash;
      const baselineReset = Boolean(previous?.contentHash && method !== (previous.comparisonMethod ?? RAW_COMPARISON));
      const changed = Boolean(previous?.contentHash && !baselineReset && (previous.comparisonHash ?? previous.contentHash) !== comparisonHash);
      return { ...source, finalUrl: url, status: !previous?.contentHash ? 'new_source' : baselineReset ? 'baseline_reset' : changed ? 'changed' : 'unchanged',
        httpStatus: status, observedAt, lastSuccessAt: observedAt, contentHash, byteLength, contentType,
        comparisonMethod: method, comparisonHash,
        etag: headerValue(response, 'etag'), lastModified: headerValue(response, 'last-modified'), changed, error: null };
    }
  } catch (error) {
    return { ...source, finalUrl: previous?.finalUrl ?? null, status: 'error', httpStatus: status, observedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null, contentHash: previous?.contentHash ?? null,
      byteLength: previous?.byteLength ?? null, contentType: previous?.contentType ?? null,
      comparisonMethod: previous?.comparisonMethod ?? RAW_COMPARISON, comparisonHash: previous?.comparisonHash ?? previous?.contentHash ?? null,
      etag: previous?.etag ?? null, lastModified: previous?.lastModified ?? null, changed: false,
      error: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'request_timeout' :
        (typeof error.code === 'string' && /^[a-z_0-9]+$/.test(error.code) ? error.code : 'request_failed') };
  }
}

export async function runResearchWatch({
  sourcesPath = resolve(ROOT, 'config/research-sources.json'),
  statePath = resolve(ROOT, '.runtime/research-watch/state.json'),
  outputPath = resolve(ROOT, '.runtime/research-watch/latest.json'),
  timeoutMs = 20000, maxBytes = 4 * 1024 * 1024, concurrency = 3,
  allowLocalHttpForTests = false, fetchImpl = globalThis.fetch, now = () => new Date().toISOString()
} = {}) {
  const paths = [sourcesPath, statePath, outputPath, `${statePath}.lock`]
    .map(path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  if (new Set(paths).size !== paths.length) throw failure('paths_must_differ');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw failure('invalid_limits');
  const config = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const { hosts, sources } = validateResearchSources(config, { allowLocalHttpForTests });
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const lock = acquireResearchWatchLock(lockPath, { now });
  try {
    const previous = await readState(statePath);
    const results = new Array(sources.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
      while (index < sources.length) {
        const current = index++;
        const source = sources[current];
        results[current] = await inspectSource(source, previous.sources[source.url], { hosts, timeoutMs, maxBytes, allowLocalHttpForTests, fetchImpl, now });
      }
    }));
    const observedAt = now();
    const summary = { total: results.length, newSources: 0, baselinesReset: 0, changed: 0, unchanged: 0, errors: 0 };
    for (const entry of results) summary[({ new_source: 'newSources', baseline_reset: 'baselinesReset', changed: 'changed', unchanged: 'unchanged', error: 'errors' })[entry.status]]++;
    const report = { version: 1, observedAt, actionable: summary.changed > 0 || summary.errors > 0,
      meaning: 'Content changes require source review; they do not establish a new release, technical merit, or an installed upgrade. Initial and reset comparison baselines are not verified changes or unchanged content.',
      rawContentStored: false, summary, sources: results };
    lock.assertOwned();
    await atomicJson(statePath, { version: 1, observedAt, sources: { ...previous.sources, ...Object.fromEntries(results.map(entry => [entry.url, entry])) } });
    await atomicJson(outputPath, report);
    return report;
  } finally {
    lock.release();
  }
}

function cliOptions(argv) {
  const options = {};
  const flags = { '--sources': 'sourcesPath', '--state': 'statePath', '--output': 'outputPath' };
  for (let index = 0; index < argv.length; index++) {
    if (!(argv[index] in flags) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw failure('invalid_cli_argument');
    options[flags[argv[index]]] = resolve(argv[++index]);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runResearchWatch(cliOptions(process.argv.slice(2)));
    console.log(JSON.stringify({ observedAt: report.observedAt, actionable: report.actionable, ...report.summary }));
    if (report.summary.errors) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? 'research_watch_failed' }));
    process.exitCode = 1;
  }
}
