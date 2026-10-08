import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HwpCreateToolAdapter, UndoJournal } from '../apps/pc-agent/src/pc-agent-runtime.js';

const reportPath = resolve(process.env.JARVIS_HWP_DIAGNOSTIC_REPORT ?? 'dist/verification/hwp-host-diagnostic.json');
const timeoutMs = Math.max(5000, Number(process.env.JARVIS_HWP_DIAGNOSTIC_TIMEOUT_MS ?? 30000));
const runRoot = await mkdtemp(join(tmpdir(), 'jarvis-hwp-diagnostic-'));
const workspace = join(runRoot, 'workspace');
const outputPath = join(workspace, 'hwp-host-diagnostic.hwp');
const startedAt = new Date();
let report;

try {
  await mkdir(workspace, { recursive: true });
  const before = hwpAutomationProcessCount();
  const adapter = new HwpCreateToolAdapter({
    timeoutMs,
    allowedRoots: [workspace],
    undoJournal: new UndoJournal({ journalPath: join(runRoot, 'undo-journal.jsonl') })
  });
  const result = await adapter.execute({
    path: outputPath,
    title: 'JARVIS HWP Host Diagnostic',
    blocks: [{ type: 'paragraph', text: 'JARVIS HWP host diagnostic fixture.' }]
  }, { taskId: `task_hwp_diagnostic_${Date.now()}` });
  const artifact = await fileEvidence(outputPath);
  const after = hwpAutomationProcessCount();
  const finishedAt = new Date();
  report = {
    reportVersion: 'jarvis-hwp-host-diagnostic-v1',
    generatedAt: finishedAt.toISOString(),
    status: result.status === 'success' && artifact && after <= before ? 'passed' : 'failed',
    timeoutMs,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    adapterStatus: result.status,
    error: result.error ?? null,
    lastStep: result.evidence?.lastStep ?? null,
    pathApproval: result.evidence?.pathApproval ?? null,
    ownedProcessCleanup: result.evidence?.ownedProcessCleanup ?? null,
    artifact,
    processHygiene: {
      beforeAutomationProcessCount: before,
      afterAutomationProcessCount: after,
      leakedAutomationProcess: after > before
    }
  };
} catch (error) {
  const finishedAt = new Date();
  report = {
    reportVersion: 'jarvis-hwp-host-diagnostic-v1',
    generatedAt: finishedAt.toISOString(),
    status: 'failed',
    timeoutMs,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    error: String(error?.message ?? error).slice(0, 500)
  };
} finally {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

function hwpAutomationProcessCount() {
  try {
    const script = '(Get-CimInstance Win32_Process -Filter "Name = \'Hwp.exe\'" | Where-Object { $_.CommandLine -match "-Automation\\s+-Embedding" } | Measure-Object).Count';
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    }).trim()) || 0;
  } catch {
    return -1;
  }
}

async function fileEvidence(path) {
  try {
    await access(path);
    const [info, body] = await Promise.all([stat(path), readFile(path)]);
    return { size: info.size, sha256: createHash('sha256').update(body).digest('hex') };
  } catch {
    return null;
  }
}
