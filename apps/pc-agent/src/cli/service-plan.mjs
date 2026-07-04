import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServicePlan, loadPcAgentInstallConfig } from '../install/service-planner.js';
import { verifyPcAgentServiceReadiness } from '../install/service-verifier.js';

export async function runServicePlanCli(argv = process.argv.slice(2)) {
  const action = argv.find((item) => ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'update', 'verify'].includes(item)) ?? 'status';
  const execute = argv.includes('--execute');
  const json = argv.includes('--json');
  const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
  if (action === 'verify') {
    const packageIndex = argv.indexOf('--package-dir');
    const packageDir = packageIndex >= 0 ? argv[packageIndex + 1] : null;
    const outputIndex = argv.indexOf('--output');
    const outputPath = outputIndex >= 0 ? resolve(argv[outputIndex + 1]) : null;
    const report = await verifyPcAgentServiceReadiness({
      daemonConfig,
      serviceManifest,
      packageDir,
      isAdministrator: argv.includes('--administrator')
    });
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    console.log('# JARVIS PC Agent service verification');
    console.log(`Status: ${report.status}`);
    console.log(`Service: ${report.serviceName}`);
    console.log(`Endpoint: ${report.endpoint}`);
    if (outputPath) console.log(`Report: ${outputPath}`);
    console.log('');
    console.log('Checks:');
    for (const check of report.checks) console.log(`- ${check.id}: ${check.status}`);
    if (report.nextActions.length) {
      console.log('');
      console.log('Next actions:');
      for (const nextAction of report.nextActions) console.log(`- ${nextAction}`);
    }
    return report;
  }
  const plan = createServicePlan({ action, daemonConfig, serviceManifest, execute });
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  console.log(`# JARVIS PC Agent service plan`);
  console.log(`Action: ${plan.action}`);
  console.log(`Mode: ${plan.dryRun ? 'dry-run' : 'execute-requested'}`);
  console.log(`Service: ${plan.serviceName}`);
  console.log(`Endpoint: ${plan.endpoint}`);
  console.log(`Local only: ${plan.localOnly}`);
  console.log('');
  console.log('Commands:');
  for (const command of plan.commands) console.log(`- ${command}`);
  if (plan.warnings.length) {
    console.log('');
    console.log('Warnings:');
    for (const warning of plan.warnings) console.log(`- ${warning}`);
  }
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runServicePlanCli();
}
