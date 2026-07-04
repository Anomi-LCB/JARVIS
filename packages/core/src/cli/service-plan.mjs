import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCoreServiceLifecyclePlan, verifyCoreServiceReadiness } from '../install/core-service-planner.js';

const args = parseArgs(process.argv.slice(2));
const action = args.action ?? 'status';
const plan = createCoreServiceLifecyclePlan({
  action,
  cwd: process.cwd(),
  execute: args.execute === true,
  port: args.port ? Number(args.port) : undefined,
  logs: {
    adminTokenHash: args.adminTokenHash
  }
});
const readiness = await verifyCoreServiceReadiness({
  cwd: process.cwd(),
  isAdministrator: args.admin === true,
  plan
});
const report = {
  reportVersion: 'a-core-service-lifecycle-report-v1',
  plan,
  readiness
};

if (args.output) {
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log(`# JARVIS Core Service Plan
action: ${plan.action}
dryRun: ${plan.dryRun}
serviceName: ${plan.serviceName}
readiness: ${readiness.status}
commands:
${plan.commands.map((command) => `- ${command}`).join('\n')}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') parsed.execute = true;
    else if (arg === '--admin') parsed.admin = true;
    else if (arg === '--port') parsed.port = argv[++index];
    else if (arg === '--admin-token-hash') parsed.adminTokenHash = argv[++index];
    else if (arg === '--output') parsed.output = argv[++index];
    else if (!parsed.action) parsed.action = arg;
  }
  return parsed;
}
