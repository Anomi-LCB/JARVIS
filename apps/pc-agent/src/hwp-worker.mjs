import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HwpCreateToolAdapter } from './pc-agent-runtime.js';

export async function runHwpWorker(inputPath) {
  const resolvedInput = resolve(inputPath);
  let request;
  try {
    request = JSON.parse(readFileSync(resolvedInput, 'utf8'));
  } finally {
    try { rmSync(resolvedInput, { force: true }); } catch { /* parent also removes it */ }
  }
  if (request?.workerRequestVersion !== 'jarvis-hwp-worker-request-v1') {
    const error = new Error('Unsupported HWP worker request.');
    error.code = 'B_HWP_WORKER_REQUEST_INVALID';
    throw error;
  }
  const adapter = new HwpCreateToolAdapter({
    timeoutMs: request.timeoutMs,
    allowedRoots: request.allowedRoots,
    workerIsolation: false,
    undoJournal: {
      record() {
        return { undoJournalId: null };
      }
    }
  });
  const result = await adapter.execute(request.args, request.packet);
  return {
    workerResultVersion: 'jarvis-hwp-worker-result-v1',
    workerPid: process.pid,
    result
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHwpWorker(process.argv[2]).then((result) => {
    process.stdout.write(JSON.stringify(result));
  }).catch((error) => {
    process.stderr.write(JSON.stringify({
      workerResultVersion: 'jarvis-hwp-worker-result-v1',
      status: 'failed',
      error: { code: error?.code ?? 'B_HWP_WORKER_FAILED' }
    }));
    process.exitCode = 1;
  });
}
