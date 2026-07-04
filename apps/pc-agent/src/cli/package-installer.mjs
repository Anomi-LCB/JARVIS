#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadPcAgentInstallConfig } from '../install/service-planner.js';
import { writeInstallerPackage } from '../install/installer-packager.js';

export async function runPackageInstallerCli(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf('--output');
  const outputDir = outputIndex >= 0 ? argv[outputIndex + 1] : 'dist/pc-agent-installer';
  const signed = argv.includes('--signed');
  const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
  const result = await writeInstallerPackage({
    daemonConfig,
    serviceManifest,
    cwd: process.cwd(),
    outputDir,
    signed
  });
  console.log('# JARVIS PC Agent installer package');
  console.log(`Status: ${result.success ? 'created' : 'failed'}`);
  console.log(`Package: ${result.packageId}`);
  console.log(`Output: ${result.outputDir}`);
  console.log(`Files: ${result.files.length}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPackageInstallerCli();
}
