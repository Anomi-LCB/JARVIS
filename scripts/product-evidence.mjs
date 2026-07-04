import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmPrefixArgs = npmExecPath ? [npmExecPath] : [];

const steps = [
  { id: 'core-service-package', args: ['run', 'core:service-package', '--', '--output-dir', 'dist/core-service-package'] },
  { id: 'core-service-smoke', args: ['run', 'core:service-smoke'] },
  { id: 'core-service-soak', args: ['run', 'core:service-soak'] },
  { id: 'core-service-release', args: ['run', 'core:service-release'] },
  { id: 'federated-contract-gate', args: ['run', 'contracts:federated-gate'] },
  { id: 'system-integrity-audit', args: ['run', 'ops:integrity-audit'] },
  { id: 'command-input-quality', args: ['run', 'command-input:quality'] },
  { id: 'context-provider-soak', args: ['run', 'context:provider-soak'] },
  { id: 'pc-agent-package', args: ['run', 'pc-agent:package', '--', '--output', 'dist/pc-agent-installer'] },
  { id: 'pc-agent-install-release', args: ['run', 'pc-agent:install-release'] },
  { id: 'workbook-product-soak', args: ['run', 'workbook:product-soak'] },
  { id: 'shadow-approval-soak', args: ['run', 'shadow:approval-soak'] },
  { id: 'ag-smoke', args: ['run', 'ag:smoke'] },
  { id: 'browser-replay-soak', args: ['run', 'browser:replay-soak'] },
  { id: 'pc-agent-daemon-smoke', args: ['run', 'pc-agent:daemon-smoke', '--', '--output', 'dist/pc-agent-daemon-smoke-report.json'] },
  { id: 'growth-quality', args: ['run', 'growth:quality'] },
  { id: 'security-redteam', args: ['run', 'security:redteam'] },
  { id: 'verification-dashboard', args: ['run', 'verification:dashboard'] },
  { id: 'mobile-verify', args: ['run', 'mobile:verify'] },
  { id: 'wearable-hud-verify', args: ['run', 'wearable:verify'] },
  { id: 'wearable-field-chaos', args: ['run', 'wearable:chaos'] },
  { id: 'bridge-server-soak', args: ['run', 'bridge:server-soak'] },
  { id: 'bridge-network-guard-drill', args: ['run', 'bridge:network-guard-drill'] },
  { id: 'bridge-client-contract-gate', args: ['run', 'bridge:client-contract-gate'] },
  { id: 'mobile-device-smoke', args: ['run', 'mobile:device'] },
  { id: 'mobile-release-dossier', args: ['run', 'mobile:release-dossier'] },
  { id: 'mobile-live-bridge-e2e', args: ['run', 'mobile:live-bridge-e2e'], timeoutMs: 300_000 },
  { id: 'ag-gap', args: ['run', 'ag:gap'] },
  { id: 'ag-product-gate', args: ['run', 'ag:product-gate'] },
  { id: 'windows-admin-install-attempts', args: ['run', 'ops:admin-install-attempts'] },
  { id: 'ag-operator-handoff-pre-worm', args: ['run', 'ag:handoff'] },
  { id: 'ci-worm-promotion', args: ['run', 'ops:worm-promotion'] },
  { id: 'worm-target-prepare', args: ['run', 'ops:worm-target'] },
  { id: 'external-worm-sync-proof', args: ['run', 'ops:worm-sync', '--', '--external-dir', 'artifacts/worm-target'] },
  { id: 'field-validation-kit', args: ['run', 'ops:field-kit'] },
  { id: 'operator-preflight', args: ['run', 'ops:preflight'] },
  { id: 'ag-operator-handoff', args: ['run', 'ag:handoff'] },
  { id: 'final-release-gate', args: ['run', 'ops:final-gate'] },
  { id: 'final-signoff-kit', args: ['run', 'ops:signoff-kit'] },
  { id: 'ag-operator-handoff-post-final', args: ['run', 'ag:handoff'] },
  { id: 'final-release-verification-bundle', args: ['run', 'ops:release-verify', '--', '--no-emit'] }
];

async function main() {
  const results = [];
  for (const step of steps) {
    console.log(`\n# product:evidence ${step.id}`);
    const exitCode = await runNpm(step.args, {
      id: step.id,
      timeoutMs: step.timeoutMs
    });
    const allowExitCodes = step.allowExitCodes ?? [0];
    results.push({ id: step.id, exitCode });
    if (!allowExitCodes.includes(exitCode)) {
      console.error(`product:evidence failed at ${step.id} with exit code ${exitCode}`);
      process.exitCode = exitCode || 1;
      return;
    }
  }

  const gate = JSON.parse(await readFile('dist/ag-product-readiness-gate.json', 'utf8'));
  const incompleteLanes = gate.lanes.filter((lane) => lane.missingArtifactCount > 0 || lane.status !== 'evidence-present');
  if (gate.status !== 'passed' || gate.nextExecutionQueue.length > 0 || incompleteLanes.length > 0) {
    console.error('product:evidence generated artifacts, but the product gate is still incomplete.');
    console.error(JSON.stringify({
      status: gate.status,
      nextExecutionQueue: gate.nextExecutionQueue.length,
      incompleteLanes: incompleteLanes.map((lane) => ({
        laneId: lane.laneId,
        status: lane.status,
        missingArtifactCount: lane.missingArtifactCount
      }))
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('\n# JARVIS product evidence');
  console.log('Status: passed');
  console.log(`Lanes: ${gate.lanes.length}/${gate.lanes.length} evidence-present`);
  console.log('Queue: 0');
  console.log('Reports: dist/ag-product-readiness-gate.json, dist/ag-strict-gap-audit.json');
}

function runNpm(args, { id = args.join(' '), timeoutMs = 900_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(npmCommand, [...npmPrefixArgs, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    };
    const timer = setTimeout(async () => {
      console.error(`product:evidence ${id} timed out after ${timeoutMs}ms`);
      await terminateProcessTree(child);
      finish(124);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => {
      console.error(error.message);
      finish(error.code || 1);
    });
    child.on('exit', (exitCode) => finish(exitCode ?? 1));
  });
}

function terminateProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    killer.on('error', () => {
      child.kill();
      resolve();
    });
    killer.on('exit', () => resolve());
  });
}

await main();
