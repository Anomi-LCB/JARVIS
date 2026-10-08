import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

test('Windows release signer is explicit, production-only, and privacy-safe', async () => {
  const source = await readFile(new URL('../scripts/sign-windows-release.ps1', import.meta.url), 'utf8');

  assert.match(source, /\[switch\]\$Execute/);
  assert.match(source, /JARVIS_CODE_SIGN_CERT_THUMBPRINT/);
  assert.match(source, /production-certificate-not-self-signed/);
  assert.match(source, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(source, /TimestampServer/);
  assert.match(source, /trusted-timestamp-server-configured/);
  assert.match(source, /ready-to-sign/);
  assert.match(source, /windows-sdk-signtool-available/);
  assert.match(source, /"\/fd", "SHA256"/);
  assert.match(source, /"\/tr", \$TimestampServer, "\/td", "SHA256"/);
  assert.match(source, /RevocationMode\]::Online/);
  assert.match(source, /production-certificate-key-policy/);
  assert.match(source, /TimeStamperCertificate/);
  assert.match(source, /JarvisPcAgentServiceHost\.exe/);
  assert.match(source, /runtime-integrity\.psd1/);
  assert.match(source, /-RuntimeOnly -RequireTimestamp/);
  assert.match(source, /build-nsis-installer\.ps1/);
  assert.match(source, /\$corePackageCli --output/);
  assert.match(source, /package-installer\.mjs/);
  assert.match(source, /--write-output/);
  assert.match(source, /build-tray-exe\.ps1/);
  assert.match(source, /build-service-host\.ps1/);
  assert.match(source, /-SetupOnly -RequireTimestamp/);
  assert.match(source, /jarvis-release-signing-/);
  assert.match(source, /Invoke-AtomicFileReplacement/);
  assert.match(source, /failed-rolled-back/);
  assert.match(source, /verification-pending/);
  assert.match(source, /windows-code-signing-audit\.mjs/);
  assert.match(source, /pc-agent-signature-report/);
  assert.match(source, /code-signing-artifacts-updated/);
  assert.match(source, /jarvis-release-evidence-invalidated-v1/);
  assert.match(source, /destinationExisted/);
  assert.match(source, /Remove-PromotedDestination/);
  assert.match(source, /certificateThumbprintStored = \$false/);
  assert.match(source, /privateKeyMaterialStored = \$false/);
  assert.doesNotMatch(source, /Write-Host\s+\$CertificateThumbprint/);
  assert.doesNotMatch(source, /Set-AuthenticodeSignature/);
});

test('PC Agent package tamper audit exercises signed source and runtime boundaries', async () => {
  const source = await readFile(new URL('../scripts/pc-agent-package-tamper-audit.ps1', import.meta.url), 'utf8');

  assert.match(source, /baseline-valid/);
  assert.match(source, /source-file-tamper/);
  assert.match(source, /runtime-binary-tamper/);
  assert.match(source, /runtime-manifest-tamper/);
  assert.match(source, /setup-binary-tamper/);
  assert.match(source, /Start-Process[^\n]+-WindowStyle Hidden/);
  assert.match(source, /rawSecretsIncluded = \$false/);
  assert.match(source, /certificateThumbprintsIncluded = \$false/);
});

test('PC Agent local release rebuild is explicit, staged, rollback-safe, and privacy-safe', async () => {
  const source = await readFile(new URL('../scripts/rebuild-pc-agent-local-release.ps1', import.meta.url), 'utf8');

  assert.match(source, /\[switch\]\$Execute/);
  assert.match(source, /--write-output \$stagePackageRoot/);
  assert.match(source, /verify-package\.ps1"\) -SourceOnly/);
  assert.match(source, /build-tray-exe\.ps1/);
  assert.match(source, /build-service-host\.ps1/);
  assert.match(source, /-RuntimeOnly/);
  assert.match(source, /-SetupOnly/);
  assert.match(source, /Replace-Atomic/);
  assert.match(source, /failed-rolled-back/);
  assert.match(source, /release-history/);
  assert.match(source, /-WindowStyle Hidden/);
  assert.match(source, /certificateThumbprintStored = \$false/);
  assert.match(source, /privateKeyMaterialStored = \$false/);
  assert.doesNotMatch(source, /Write-Host\s+\$certificate\.Thumbprint/i);
});

test('Windows release preflight never mutates artifacts when the production certificate is absent', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-windows-signing-preflight-'));
  const scriptDir = join(root, 'scripts');
  const pcCliDir = join(root, 'apps', 'pc-agent', 'src', 'cli');
  const coreDir = join(root, 'dist', 'core-service-package');
  const pcDir = join(root, 'dist', 'pc-agent-installer');
  const targetNames = [
    [coreDir, 'JarvisCoreRuntimeHost.exe'],
    [pcDir, 'JarvisPcAgentTray.exe'],
    [pcDir, 'JarvisPcAgentServiceHost.exe'],
    [pcDir, 'runtime-integrity.psd1'],
    [pcDir, 'JARVIS-PC-Agent-Setup.exe']
  ];
  try {
    await Promise.all([mkdir(scriptDir, { recursive: true }), mkdir(pcCliDir, { recursive: true }), mkdir(coreDir, { recursive: true }), mkdir(pcDir, { recursive: true })]);
    const source = await readFile(new URL('../scripts/sign-windows-release.ps1', import.meta.url));
    await writeFile(join(scriptDir, 'sign-windows-release.ps1'), source);
    await writeFile(join(scriptDir, 'core-service-package.mjs'), '// fixture');
    await writeFile(join(scriptDir, 'windows-code-signing-audit.mjs'), '// fixture');
    await writeFile(join(pcCliDir, 'package-installer.mjs'), '// fixture');
    for (const [directory, name] of targetNames) await writeFile(join(directory, name), `fixture:${name}`);
    for (const name of ['package-manifest.json', 'sign-artifacts.ps1', 'build-nsis-installer.ps1', 'installer.nsi']) {
      await writeFile(join(pcDir, name), `fixture:${name}`);
    }
    const before = await Promise.all(targetNames.map(([directory, name]) => sha256(join(directory, name))));
    let exitCode = 0;
    try {
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(scriptDir, 'sign-windows-release.ps1'),
        '-CertificateThumbprint', ''
      ], { timeout: 20_000, windowsHide: true });
    } catch (error) {
      exitCode = Number(error.code);
    }
    const after = await Promise.all(targetNames.map(([directory, name]) => sha256(join(directory, name))));
    const report = JSON.parse(await readFile(join(root, 'dist', 'windows-code-signing-release.json'), 'utf8'));

    assert.equal(exitCode, 2);
    assert.deepEqual(after, before);
    assert.equal(report.status, 'blocked');
    assert.equal(report.executeRequested, false);
    assert.equal(report.privacy.privateKeyMaterialStored, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows signing transaction restores every promoted artifact after a simulated partial failure', { skip: process.platform !== 'win32' }, async () => {
  const scriptPath = fileURLToPath(new URL('../scripts/sign-windows-release.ps1', import.meta.url));
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-TransactionSelfTest'
  ], { timeout: 20_000, windowsHide: true });
  const report = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));

  assert.equal(report.status, 'passed');
  assert.equal(report.artifactCount, 5);
  assert.equal(report.promotedBeforeFailure, 3);
  assert.equal(report.restoredCount, 3);
  assert.equal(report.restoredExactly, true);
  assert.equal(report.originallyMissingCount, 1);
  assert.equal(report.removedCreatedCount, 1);
});
