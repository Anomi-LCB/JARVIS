import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';

test('capability description reflects dynamically activated workflow adapters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-capability-describe-'));
  try {
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: root });
    const adapter = runtime.pcAgent.registry.get('capability.describe');
    const result = await adapter.execute();
    const executableTools = runtime.pcAgent.registry.capabilityMatrix()
      .filter((contract) => contract.toolName !== 'capability.describe');

    assert.equal(runtime.pcAgent.registry.get('workflow.execute') !== undefined, true);
    assert.match(result.summary, /검증된 로컬 복합 워크플로 실행/u);
    assert.equal(result.capabilityCount, executableTools.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
