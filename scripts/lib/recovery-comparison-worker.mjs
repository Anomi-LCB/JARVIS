import { performance } from 'node:perf_hooks';
import { evaluateRecoveryScenario } from './recovery-comparison-adapter.mjs';

const [arm, scenario] = process.argv.slice(2);
const start = performance.now();
const memoryIntervalMs = 2;
const readRss = () => {
  try { return process.memoryUsage.rss(); } catch { return null; }
};
const baselineRssBytes = readRss();
let sampledPeakRssBytes = baselineRssBytes;
let memorySampleCount = baselineRssBytes === null ? 0 : 1;
const memorySampler = setInterval(() => {
  const rssBytes = readRss();
  if (rssBytes === null) return;
  memorySampleCount++;
  sampledPeakRssBytes = Math.max(sampledPeakRssBytes ?? 0, rssBytes);
}, memoryIntervalMs);
try {
  const result = await evaluateRecoveryScenario({ scenario, arm });
  clearInterval(memorySampler);
  const finalRssBytes = readRss();
  if (finalRssBytes !== null) {
    memorySampleCount++;
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes ?? 0, finalRssBytes);
  }
  process.stdout.write(JSON.stringify({ ok: true, sample: { ...result, elapsedMs: performance.now() - start,
    processMemory: baselineRssBytes === null || sampledPeakRssBytes === null ? null : {
      baselineRssBytes, sampledPeakRssBytes, sampledPeakDeltaBytes: Math.max(0, sampledPeakRssBytes - baselineRssBytes),
      sampleCount: memorySampleCount, intervalMs: memoryIntervalMs, scope: 'isolated-worker-process-rss-sampled-lower-bound'
    } } }));
} catch {
  clearInterval(memorySampler);
  process.stdout.write(JSON.stringify({ ok: false, errorCode: 'A_COMPARISON_ADAPTER_FAILED' }));
  process.exitCode = 1;
}
