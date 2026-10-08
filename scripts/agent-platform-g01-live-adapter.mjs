import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = Object.freeze([
  Object.freeze({ id: 'wcag-target-size-minimum', publisher: 'W3C WAI',
    title: 'Understanding Success Criterion 2.5.8: Target Size (Minimum)',
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum',
    quote: 'The size of the target for pointer inputs is at least 24 by 24 CSS pixels',
    claim: 'WCAG 2.2 SC 2.5.8 sets a 24 by 24 CSS pixel minimum target size, subject to its listed exceptions.' }),
  Object.freeze({ id: 'wcag-focus-not-obscured-minimum', publisher: 'W3C WAI',
    title: 'Understanding Success Criterion 2.4.11: Focus Not Obscured (Minimum)',
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum',
    quote: 'the component is not entirely hidden due to author-created content.',
    claim: 'WCAG 2.2 SC 2.4.11 requires a keyboard-focused component not to be fully hidden by author-created content.' })
]);

function decodeHtml(value) {
  return value.replace(/&nbsp;|&#160;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function htmlTextForG01(value) {
  return decodeHtml(String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, ' ').replace(/<[^>]*>/gu, ' '))
    .replace(/\s+/gu, ' ').trim();
}

async function fetchLiveSource(definition, onRequest) {
  const allowed = sources.some(item => item.id === definition.id && item.url === definition.url);
  if (!allowed) throw Object.assign(new Error('G01_SOURCE_NOT_ALLOWLISTED'), { code: 'G01_SOURCE_NOT_ALLOWLISTED' });
  onRequest();
  const response = await fetch(definition.url, {
    redirect: 'follow', signal: AbortSignal.timeout(15_000),
    headers: { accept: 'text/html', 'user-agent': 'JARVIS-local-public-research-evaluation/1.0' }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  if (response.url !== definition.url || response.status !== 200 || !/^text\/html(?:;|$)/iu.test(contentType)
      || bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw Object.assign(new Error('G01_SOURCE_RESPONSE_INVALID'), { code: 'G01_SOURCE_RESPONSE_INVALID' });
  }
  const text = htmlTextForG01(bytes.toString('utf8'));
  if (!text.toLowerCase().includes(definition.quote.toLowerCase())) {
    throw Object.assign(new Error('G01_SOURCE_EXPECTED_TEXT_MISSING'), { code: 'G01_SOURCE_EXPECTED_TEXT_MISSING' });
  }
  return {
    ...definition,
    liveFetch: {
      requestedUrl: definition.url, finalUrl: response.url, statusCode: response.status,
      contentType, observedAt: new Date().toISOString(), byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), rawPageBase64: bytes.toString('base64')
    }
  };
}

function safeChildEnv(fixturePath, evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    JARVIS_TEST_MODE: '1', JARVIS_MISSION_PLANNER: 'rule',
    JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0',
    JARVIS_G01_FIXTURE_PATH: fixturePath,
    JARVIS_G01_ORACLE_EVIDENCE_PATH: evidencePath
  });
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)/iu.test(key)) delete env[key];
  }
  return env;
}

function latencyPercentile(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? null;
}

export async function runG01LiveAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/G01-live-${runId}`;
  const runDirectory = resolve(root, runRelative);
  mkdirSync(runDirectory, { recursive: true });
  const measurements = [];
  let networkRequests = 0;
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date().toISOString();
    const repetitionRelative = `${runRelative}/repetition-${repetition}`;
    const repetitionDirectory = resolve(root, repetitionRelative);
    mkdirSync(repetitionDirectory, { recursive: true });
    let evidencePath = null;
    let oraclePath = null;
    let oracle = null;
    let status = 'failed';
    let stopCode = null;
    let repetitionNetworkRequests = 0;
    try {
      const fetched = await Promise.all(sources.map(source => fetchLiveSource(source, () => {
        networkRequests += 1;
        repetitionNetworkRequests += 1;
      })));
      const fixture = {
        schemaVersion: 1, fixtureId: 'g01-w3c-wcag22-live-source-v1', captureMode: 'fresh-public-http-get',
        capturedAt: new Date().toISOString(),
        fixtureNotice: '두 고정 W3C WAI WCAG 2.2 설명 페이지를 이번 실행에서 GET으로 가져와 해시를 보존한 공개 출처다. 모델 API는 호출하지 않았다.',
        sources: fetched
      };
      const fixturePath = resolve(repetitionDirectory, 'fixture.json');
      evidencePath = resolve(repetitionDirectory, 'evidence.json');
      oraclePath = resolve(repetitionDirectory, 'oracle.json');
      writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-g01-role-source.test.js'], {
        cwd: root, env: safeChildEnv(fixturePath, evidencePath), encoding: 'utf8', timeout: 30_000,
        windowsHide: true, maxBuffer: 4 * 1024 * 1024
      });
      writeFileSync(resolve(repetitionDirectory, 'mission-test.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
      if (child.error || child.status !== 0 || !readFileSafe(evidencePath)) {
        stopCode = child.error?.code ?? `MISSION_TEST_EXIT_${child.status ?? 'UNKNOWN'}`;
        status = 'failed';
      } else {
        const oracleText = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
          cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
          env: safeChildEnv(fixturePath, evidencePath), maxBuffer: 1024 * 1024
        });
        oracle = JSON.parse(oracleText.trim().split(/\r?\n/u).at(-1));
        status = oracle.status === 'passed' ? 'completed' : 'failed';
        if (status !== 'completed') stopCode = 'G01_LIVE_ORACLE_FAILED';
      }
    } catch (error) {
      status = error?.name === 'TimeoutError' || error?.code === 'G01_SOURCE_RESPONSE_INVALID'
        || error?.name === 'TypeError'
        ? 'blocked' : 'failed';
      stopCode = error?.code ?? (error?.name === 'TimeoutError' ? 'SOURCE_TIMEOUT'
        : error?.name === 'TypeError' ? 'SOURCE_NETWORK_UNAVAILABLE' : 'G01_ADAPTER_ERROR');
      if (!readFileSafe(resolve(repetitionDirectory, 'mission-test.log'))) {
        writeFileSync(resolve(repetitionDirectory, 'mission-test.log'), `${stopCode}\n`, { encoding: 'utf8', flag: 'wx' });
      }
    }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const oraclePassed = oracle?.status === 'passed';
    measurements.push({
      scenarioId: 'G01', adapterId: 'g01-live-public-source-local-mission',
      executionMode: 'local-jarvis-mission-with-allowlisted-live-public-http-sources',
      repetition, startedAt, finishedAt, status,
      scenarioExecutionStatus: oraclePassed ? 'completed' : 'not-run',
      requirementResults: [
        { requirement: '두 allowlist W3C 페이지를 현재 실행에서 읽고 해시로 보존', status: oraclePassed ? 'passed' : status,
          oracleCheckIds: ['both_allowlisted_primary_sources_were_fetched_and_hash_bound', 'live_source_text_contains_the_cited_primary_requirements'] },
        { requirement: '연구자·편집자·검증자 역할 분리와 검증 완료', status: oraclePassed ? 'passed' : status,
          oracleCheckIds: ['researcher_editor_verifier_roles_and_g_evidence_are_bound'] },
        { requirement: '편집자의 조사자 비공개 자료 접근 차단', status: oraclePassed ? 'passed' : status,
          oracleCheckIds: ['editor_cannot_read_researcher_private_material'] },
        { requirement: '두 출처를 인용한 report.md 하나 생성 및 재검증', status: oraclePassed ? 'passed' : status,
          oracleCheckIds: ['one_report_preserves_both_claims_quotes_and_live_urls', 'report_byte_length_and_hash_are_recomputable'] }
      ],
      evidencePaths: [
        ...['fixture.json', 'mission-test.log'].filter(name => existsSync(resolve(repetitionDirectory, name)))
          .map(name => `${repetitionRelative}/${name}`),
        ...(evidencePath && readFileSafe(evidencePath) ? [`${repetitionRelative}/evidence.json`] : []),
        ...(oraclePath && readFileSafe(oraclePath) ? [`${repetitionRelative}/oracle.json`] : [])
      ],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence,
        resultPath: `${repetitionRelative}/oracle.json`, checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: repetitionNetworkRequests,
      retries: 0, questions: 0, approvals: 0, costUsd: null, costMeasurement: 'unmeasured', stopCode
    });
  }
  const successful = measurements.every(item => item.status === 'completed');
  const report = {
    schemaVersion: 1, runId, observedAt, scenarioId: 'G01', declaredFamily: 'grok',
    mode: 'public-scenario-live-source-local-mission-adapter',
    executionStatusChangedInCorpus: false,
    outcome: successful ? 'completed' : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked',
    repetitionsPerConfiguration: 3,
    measurementKind: 'local-jarvis-runtime-with-live-allowlisted-public-source-snapshots',
    measurements,
    counts: { total: measurements.length, completed: measurements.filter(item => item.status === 'completed').length,
      failed: measurements.filter(item => item.status === 'failed').length, blocked: measurements.filter(item => item.status === 'blocked').length,
      independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: latencyPercentile(measurements.map(item => item.latencyMs), 0.5),
      p95: latencyPercentile(measurements.map(item => item.latencyMs), 0.95), unit: 'ms', includes: 'live GET + local Mission + separate-process oracle' },
    networkRequests, providerCalls: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    sources: sources.map(({ id, publisher, title, url }) => ({ id, publisher, title, url })),
    limitations: [
      '실제 xAI/Grok 제공자·봇 API를 호출하지 않았다. local Mission planner는 규칙 기반 fixture다.',
      'W3C 공개 원문 2건과 고정 앵커 문구만 시험했으며 학계 전문가의 의미 평가와 출처 전반의 누락 검증은 하지 않았다.',
      '별도 프로세스 오라클은 별도 predicate 코드이나 같은 프로젝트에서 작성됐고 독립 인간 저자가 아니다.',
      '한 호스트의 임시 로컬 workspace이며 일반 계정·다른 기기·오프라인 회복·장기 반복을 검증하지 않았다.',
      '공개 코퍼스의 고정 선언 상태는 변경하지 않았다. 실계정·유료 provider·외부 쓰기 작업은 실행하지 않았다.'
    ],
    evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` }
  };
  writeFileSync(resolve(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} | ${item.networkRequests} |`).join('\n');
  const markdown = `# G01 공개 출처 역할 분담 실행\n\n관측 시각: ${observedAt}\n\n` +
    `- 결과: ${report.outcome} (${report.counts.completed}/3 반복)\n- 실행 형태: 로컬 JARVIS Mission + W3C 실시간 GET, provider 호출 0\n` +
    `- 네트워크 요청: ${networkRequests}; 외부 쓰기: 0; 총 비용: 미측정\n- 지연: p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n\n` +
    `| 반복 | 결과 | 전체 지연 | 별도 프로세스 오라클 | GET 요청 |\n|---:|---|---:|---|---:|\n${rows}\n\n` +
    `## 원문 출처\n\n${report.sources.map(item => `- [${item.title}](${item.url})`).join('\n')}\n\n` +
    `## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\n원시 입력·Mission 관측·검증 산출물은 반복별 증거 JSON에 보존했다.\n`;
  writeFileSync(resolve(runDirectory, 'report.md'), markdown, { encoding: 'utf8', flag: 'wx' });
  return report;
}

function readFileSafe(path) { try { return readFileSync(path); } catch { return null; } }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runG01LiveAdapter();
    console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts,
      latencyMs: report.latencyMs, networkRequests: report.networkRequests, evidence: report.evidence }, null, 2));
    if (report.outcome !== 'completed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ outcome: 'failed', error: error?.code ?? error?.name ?? 'G01_ADAPTER_ERROR' }));
    process.exitCode = 1;
  }
}
