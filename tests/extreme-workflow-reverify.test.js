import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { reverifyExtremeWorkflowAudit } from '../scripts/extreme-workflow-50-reverify.mjs';

const execFileAsync = promisify(execFile);

test('extreme audit hash-chain reverification passes clean evidence and detects result tampering', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jarvis-extreme-reverify-'));
  const root = join(temp, 'audit');
  try {
    await execFileAsync(process.execPath, [
      resolve('scripts/extreme-workflow-50-audit.mjs'),
      '--root', root,
      '--cases', 'E01,E05'
    ], { cwd: resolve('.'), windowsHide: true, timeout: 60_000 });

    const clean = await reverifyExtremeWorkflowAudit(root);
    assert.equal(clean.status, 'passed');
    assert.equal(clean.resultCount, 2);

    await appendFile(join(root, 'cycle-01', 'E01', 'result.json'), ' \n', 'utf8');
    const tampered = await reverifyExtremeWorkflowAudit(root);
    assert.equal(tampered.status, 'failed');
    assert.equal(tampered.checks.some((item) => item.name === 'result 1 byte hash' && !item.pass), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
