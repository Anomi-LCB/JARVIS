#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { writeCoreServicePackage } from '../packages/core/src/install/core-service-packager.js';

export async function runCoreServicePackageCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await writeCoreServicePackage({
    cwd: process.cwd(),
    outputDir: args.outputDir ?? 'dist/core-service-package',
    serviceName: args.serviceName ?? undefined,
    displayName: args.displayName ?? undefined,
    port: args.port ? Number(args.port) : undefined,
    host: args.host ?? undefined,
    signed: args.signed === true,
    logs: {
      adminTokenHash: args.adminTokenHash,
      workerDaemonIntervalMs: args.daemonIntervalMs ? Number(args.daemonIntervalMs) : undefined,
      workerDaemonDrainLimit: args.daemonDrainLimit ? Number(args.daemonDrainLimit) : undefined
    }
  });
  console.log('# JARVIS Core service package');
  console.log(`Status: ${result.success ? 'created' : 'failed'}`);
  console.log(`Package: ${result.packageId}`);
  console.log(`Output: ${result.outputDir}`);
  console.log(`Files: ${result.files.length}`);
  console.log(`Runtime: ${result.manifest.runtimeEntry}`);
  return result;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir' || arg === '--output') parsed.outputDir = argv[++index];
    else if (arg === '--service-name') parsed.serviceName = argv[++index];
    else if (arg === '--display-name') parsed.displayName = argv[++index];
    else if (arg === '--port') parsed.port = argv[++index];
    else if (arg === '--host') parsed.host = argv[++index];
    else if (arg === '--admin-token-hash') parsed.adminTokenHash = argv[++index];
    else if (arg === '--daemon-interval-ms') parsed.daemonIntervalMs = argv[++index];
    else if (arg === '--daemon-drain-limit') parsed.daemonDrainLimit = argv[++index];
    else if (arg === '--signed') parsed.signed = true;
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCoreServicePackageCli();
}
