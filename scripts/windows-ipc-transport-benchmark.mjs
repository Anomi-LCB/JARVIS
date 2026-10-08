import { spawn, spawnSync } from 'node:child_process';
import { createServer, request, Agent } from 'node:http';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const workspaceRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const iterations = 100;
const warmupIterations = 10;
const maximumPayloadBytes = 65_536;
const payload = Buffer.from('JARVIS-NAMED-PIPE-PROBE-v1', 'utf8');

if (process.platform !== 'win32') throw new Error('A_WINDOWS_HOST_REQUIRED');

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(4));
}

if (process.argv.includes('--http-server')) {
  let served = 0;
  const expectedRequests = Number(process.argv[process.argv.indexOf('--requests') + 1] ?? iterations);
  const server = createServer((incoming, response) => {
    if (incoming.method !== 'POST' || incoming.url !== '/') return response.writeHead(404).end();
    const chunks = [];
    let total = 0;
    incoming.on('data', chunk => {
      total += chunk.length;
      if (total > maximumPayloadBytes) incoming.destroy();
      else chunks.push(chunk);
    });
    incoming.on('end', () => {
      const body = Buffer.concat(chunks, total);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      response.end(body, () => {
        if (++served >= expectedRequests) server.close();
      });
    });
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port, pid: process.pid })}\n`));
  await new Promise((resolveClose, rejectClose) => {
    server.once('close', resolveClose);
    server.once('error', rejectClose);
  });
  process.exit(0);
}

function measureNamedPipe() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const systemPath = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  const sc = spawnSync(join(systemRoot, 'System32', 'sc.exe'), ['showsid', 'JARVISCoreRuntime'], {
    env: { OS: 'Windows_NT', SystemRoot: systemRoot, WINDIR: systemRoot, PATH: systemPath },
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16_384
  });
  const serviceSid = sc.stdout?.match(/S-1-5-80-(?:\d+-){4}\d+/u)?.[0];
  if (sc.error || sc.status !== 0 || !serviceSid) throw new Error('A_CORE_SERVICE_SID_LOOKUP_FAILED');
  const childEnv = { OS: 'Windows_NT', SystemRoot: systemRoot, WINDIR: process.env.WINDIR ?? systemRoot,
    PATH: systemPath, TEMP: process.env.TEMP ?? join(systemRoot, 'Temp'), TMP: process.env.TEMP ?? join(systemRoot, 'Temp') };
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    'scripts/windows-named-pipe-security-probe.ps1', '-ServiceSid', serviceSid, '-Iterations', String(iterations),
    '-MaximumPayloadBytes', String(maximumPayloadBytes)], {
    cwd: workspaceRoot, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1_000_000
  });
  if (child.error || child.status !== 0) {
    const safeCode = child.stderr?.match(/A_[A-Z0-9_]+/u)?.[0] ?? child.error?.code ?? child.status ?? 'unknown';
    throw new Error(`A_NAMED_PIPE_BENCHMARK_FAILED_${safeCode}`);
  }
  const result = JSON.parse(child.stdout);
  if (!result.messageEchoMatches || !result.clientProcessIdDistinct || result.measuredIterations !== iterations - warmupIterations)
    throw new Error('A_NAMED_PIPE_BENCHMARK_RESULT_INVALID');
  return result;
}

async function measureLoopbackHttp() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const child = spawn(process.execPath, [scriptPath, '--http-server', '--requests', String(iterations)], {
    cwd: workspaceRoot, windowsHide: true, env: { SystemRoot: systemRoot, WINDIR: systemRoot, OS: 'Windows_NT', PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.stderr.once('data', chunk => rejectReady(new Error(`A_HTTP_CHILD_ERROR_${chunk.toString().slice(0, 100)}`)));
    lines.once('line', line => { try { resolveReady(JSON.parse(line)); } catch { rejectReady(new Error('A_HTTP_CHILD_READY_INVALID')); } });
  });
  if (!ready.ready || ready.pid === process.pid) throw new Error('A_HTTP_CHILD_PROCESS_NOT_DISTINCT');
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const samples = [];
  let echoMatches = true;
  try {
    for (let index = 0; index < iterations; index++) {
      const startedAt = performance.now();
      const echoed = await new Promise((resolveRequest, rejectRequest) => {
        const outgoing = request({ hostname: '127.0.0.1', port: ready.port, path: '/', method: 'POST', agent,
          headers: { 'content-type': 'application/octet-stream', 'content-length': payload.length } }, incoming => {
          const chunks = [];
          incoming.on('data', chunk => chunks.push(chunk));
          incoming.on('end', () => incoming.statusCode === 200 ? resolveRequest(Buffer.concat(chunks)) : rejectRequest(new Error('A_LOOPBACK_HTTP_STATUS_INVALID')));
        });
        outgoing.once('error', rejectRequest);
        outgoing.end(payload);
      });
      echoMatches &&= echoed.equals(payload);
      if (index >= warmupIterations) samples.push(performance.now() - startedAt);
    }
    if (!echoMatches) throw new Error('A_LOOPBACK_HTTP_ECHO_MISMATCH');
    return { iterations, warmupIterations, measuredIterations: samples.length,
      roundTripP50Ms: percentile(samples, 0.5), roundTripP95Ms: percentile(samples, 0.95), echoMatches,
      clientProcessId: process.pid, serverProcessId: ready.pid, processIdsDistinct: ready.pid !== process.pid };
  } finally {
    agent.destroy();
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

const pipe = measureNamedPipe();
const loopbackHttp = await measureLoopbackHttp();
console.log(JSON.stringify({
  schemaVersion: 'jarvis-ipc-transport-microbenchmark-v1', observedAt: new Date().toISOString(),
  measurementType: 'cross-process same-host transport microbenchmark; not Core workflow latency',
  platform: `${process.platform}-${process.arch}`, nodeVersion: process.version, payloadBytes: payload.length,
  maximumPayloadBytes, iterations, warmupIterations, externalCalls: 0, externalCost: 0,
  pipe: { roundTripP50Ms: pipe.roundTripP50Ms, roundTripP95Ms: pipe.roundTripP95Ms,
    measuredIterations: pipe.measuredIterations, messageEchoMatches: pipe.messageEchoMatches,
    localClientConnected: pipe.localClientConnected, processIdsDistinct: pipe.clientProcessIdDistinct,
    unauthorizedSidDenied: pipe.clientWithoutAllowedSidDenied, logonSidCanCreatePipeInstance: pipe.logonSidCanCreatePipeInstance,
    remoteClientAttempted: pipe.remoteClientAttempted, serviceIdentityAccessTested: pipe.serviceIdentityAccessTested },
  loopbackHttp
}));
