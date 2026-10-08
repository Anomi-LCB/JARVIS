#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadPcAgentInstallConfig } from '../install/service-planner.js';
import { writeInstallerPackage } from '../install/installer-packager.js';

export async function runPackageInstallerCli(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf('--output');
  const outputDir = outputIndex >= 0 ? argv[outputIndex + 1] : 'dist/pc-agent-installer';
  const writeOutputIndex = argv.indexOf('--write-output');
  const writeOutputDir = writeOutputIndex >= 0 ? argv[writeOutputIndex + 1] : null;
  const signed = argv.includes('--signed');
  const { daemonConfig, serviceManifest } = await loadPcAgentInstallConfig();
  const result = await writeInstallerPackage({
    daemonConfig,
    serviceManifest,
    cwd: process.cwd(),
    outputDir,
    writeOutputDir,
    signed
  });
  console.log('# JARVIS PC 에이전트 설치 패키지');
  console.log(`Status: ${result.success ? 'created' : 'failed'}`);
  console.log(`Package: ${result.packageId}`);
  console.log(`Output: ${result.outputDir}`);
  console.log(`Files: ${result.files.length}`);
  if (result.sourcePackageChanged && result.derivedArtifactsStale.length > 0) {
    console.log(`출시 산출물: 재빌드 필요 (${result.derivedArtifactsStale.length}개)`);
  } else {
    console.log('출시 산출물: 소스 패키지와 일치');
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPackageInstallerCli();
}
