import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const windowsSigningArtifacts = Object.freeze([
  {
    id: 'core-service-host',
    groupId: 'core-windows',
    label: 'Core Runtime 서비스 호스트',
    relativePath: join('dist', 'core-service-package', 'JarvisCoreRuntimeHost.exe')
  },
  {
    id: 'pc-agent-tray',
    groupId: 'pc-agent-windows',
    label: 'PC Agent 트레이',
    relativePath: join('dist', 'pc-agent-installer', 'JarvisPcAgentTray.exe')
  },
  {
    id: 'pc-agent-service-host',
    groupId: 'pc-agent-windows',
    label: 'PC Agent 서비스 호스트',
    relativePath: join('dist', 'pc-agent-installer', 'JarvisPcAgentServiceHost.exe')
  },
  {
    id: 'pc-agent-runtime-integrity',
    groupId: 'pc-agent-windows',
    label: 'PC Agent 런타임 무결성 매니페스트',
    relativePath: join('dist', 'pc-agent-installer', 'runtime-integrity.psd1')
  },
  {
    id: 'pc-agent-installer',
    groupId: 'pc-agent-windows',
    label: 'PC Agent 설치 프로그램',
    relativePath: join('dist', 'pc-agent-installer', 'JARVIS-PC-Agent-Setup.exe')
  }
]);

const powershellAuditScript = String.raw`
$ErrorActionPreference = "Stop"
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:JARVIS_SIGNING_AUDIT_INPUT)) | ConvertFrom-Json
$results = @()
$chainCache = @{}
function Test-OnlineChain($Certificate) {
  if ($null -eq $Certificate) { return [pscustomobject]@{ trusted = $false; checked = $false } }
  $key = [string]$Certificate.Thumbprint
  if ($chainCache.ContainsKey($key)) { return $chainCache[$key] }
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
    $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    $result = [pscustomobject]@{ trusted = $chain.Build($Certificate); checked = $true }
    $chainCache[$key] = $result
    return $result
  } finally {
    $chain.Dispose()
  }
}
foreach ($item in @($payload)) {
  $path = [string]$item.path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $results += [pscustomobject]@{
      id = [string]$item.id
      exists = $false
      authenticodeStatus = "Missing"
      signerPresent = $false
      timestamped = $false
      selfSigned = $null
      codeSigningEku = $false
      chainTrusted = $false
      onlineRevocationChecked = $false
      publicKeyAlgorithm = $null
      publicKeySize = 0
      timestampChainTrusted = $false
      timestampRevocationChecked = $false
      sha256 = $null
      inspection = "completed"
    }
    continue
  }

  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    $certificate = $signature.SignerCertificate
    $signerPresent = $null -ne $certificate
    $selfSigned = if ($signerPresent) { $certificate.Subject -eq $certificate.Issuer } else { $null }
    $codeSigningEku = $false
    $chainTrusted = $false
    $onlineRevocationChecked = $false
    $publicKeyAlgorithm = $null
    $publicKeySize = 0
    $timestampChainTrusted = $false
    $timestampRevocationChecked = $false
    if ($signerPresent) {
      $codeSigningEku = @($certificate.EnhancedKeyUsageList | ForEach-Object {
        if ($_.ObjectId -is [string]) { [string]$_.ObjectId }
        elseif ($_.ObjectId.Value) { [string]$_.ObjectId.Value }
        else { [string]$_.ObjectId }
      }) -contains "1.3.6.1.5.5.7.3.3"
      $publicKeyAlgorithm = if ($certificate.PublicKey.Oid.Value -eq "1.2.840.113549.1.1.1") { "RSA" } else { "unsupported" }
      $publicKeySize = try { [int]$certificate.PublicKey.Key.KeySize } catch { 0 }
      $signerChain = Test-OnlineChain $certificate
      $chainTrusted = $signerChain.trusted
      $onlineRevocationChecked = $signerChain.checked
    }
    if ($null -ne $signature.TimeStamperCertificate) {
      $timestampChain = Test-OnlineChain $signature.TimeStamperCertificate
      $timestampChainTrusted = $timestampChain.trusted
      $timestampRevocationChecked = $timestampChain.checked
    }
    $results += [pscustomobject]@{
      id = [string]$item.id
      exists = $true
      authenticodeStatus = $signature.Status.ToString()
      signerPresent = $signerPresent
      timestamped = $null -ne $signature.TimeStamperCertificate
      selfSigned = $selfSigned
      codeSigningEku = $codeSigningEku
      chainTrusted = $chainTrusted
      onlineRevocationChecked = $onlineRevocationChecked
      publicKeyAlgorithm = $publicKeyAlgorithm
      publicKeySize = $publicKeySize
      timestampChainTrusted = $timestampChainTrusted
      timestampRevocationChecked = $timestampRevocationChecked
      sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
      inspection = "completed"
    }
  } catch {
    $results += [pscustomobject]@{
      id = [string]$item.id
      exists = $true
      authenticodeStatus = "InspectionError"
      signerPresent = $false
      timestamped = $false
      selfSigned = $null
      codeSigningEku = $false
      chainTrusted = $false
      onlineRevocationChecked = $false
      publicKeyAlgorithm = $null
      publicKeySize = 0
      timestampChainTrusted = $false
      timestampRevocationChecked = $false
      sha256 = $null
      inspection = $_.Exception.GetType().Name
    }
  }
}
$results | ConvertTo-Json -Depth 5 -Compress
`;

function productionVerified(observation) {
  return observation.exists === true
    && observation.inspection === 'completed'
    && observation.authenticodeStatus === 'Valid'
    && observation.signerPresent === true
    && observation.timestamped === true
    && observation.selfSigned === false
    && observation.codeSigningEku === true
    && observation.chainTrusted === true
    && observation.onlineRevocationChecked === true
    && observation.publicKeyAlgorithm === 'RSA'
    && observation.publicKeySize >= 2048
    && observation.publicKeySize <= 4096
    && observation.timestampChainTrusted === true
    && observation.timestampRevocationChecked === true
    && observation.releaseProvenanceVerified === true;
}

function failureReasons(observation) {
  const reasons = [];
  if (!observation.exists) reasons.push('artifact-missing');
  if (observation.inspection !== 'completed') reasons.push('inspection-failed');
  if (observation.exists && observation.authenticodeStatus !== 'Valid') reasons.push('signature-invalid-or-missing');
  if (!observation.signerPresent) reasons.push('signer-missing');
  if (observation.selfSigned === true) reasons.push('self-signed-certificate');
  if (!observation.codeSigningEku) reasons.push('code-signing-eku-missing');
  if (!observation.chainTrusted) reasons.push('certificate-chain-untrusted');
  if (!observation.onlineRevocationChecked) reasons.push('online-revocation-check-missing');
  if (observation.publicKeyAlgorithm !== 'RSA' || observation.publicKeySize < 2048 || observation.publicKeySize > 4096) reasons.push('unsupported-public-key-policy');
  if (!observation.timestamped) reasons.push('trusted-timestamp-missing');
  if (!observation.timestampChainTrusted) reasons.push('timestamp-chain-untrusted');
  if (!observation.timestampRevocationChecked) reasons.push('timestamp-revocation-check-missing');
  if (!observation.releaseProvenanceVerified) reasons.push('rfc3161-signing-provenance-missing-or-mismatched');
  return [...new Set(reasons)];
}

export function evaluateWindowsCodeSigning({
  observations = [],
  definitions = windowsSigningArtifacts,
  signingRelease = null,
  platform = process.platform,
  clock = () => new Date()
} = {}) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const releaseEvidenceById = new Map((Array.isArray(signingRelease?.artifacts) ? signingRelease.artifacts : []).map((artifact) => [artifact.id, artifact]));
  const releaseStatusAccepted = ['verification-pending', 'passed'].includes(signingRelease?.status);
  const artifacts = definitions.map((definition) => {
    const source = byId.get(definition.id) ?? {};
    const releaseEvidence = releaseEvidenceById.get(definition.id) ?? {};
    const sourceSha256 = typeof source.sha256 === 'string' ? source.sha256.toLowerCase() : null;
    const releaseSha256 = typeof releaseEvidence.sha256 === 'string' ? releaseEvidence.sha256.toLowerCase() : null;
    const releaseProvenanceVerified = releaseStatusAccepted
      && sourceSha256 !== null
      && sourceSha256 === releaseSha256
      && releaseEvidence.passed === true
      && releaseEvidence.fileDigestAlgorithm === 'SHA256'
      && releaseEvidence.timestampProtocol === 'RFC3161'
      && releaseEvidence.timestampDigestAlgorithm === 'SHA256';
    const observation = {
      id: definition.id,
      groupId: definition.groupId,
      label: definition.label,
      exists: source.exists === true,
      authenticodeStatus: typeof source.authenticodeStatus === 'string' ? source.authenticodeStatus : 'NotInspected',
      signerPresent: source.signerPresent === true,
      timestamped: source.timestamped === true,
      selfSigned: typeof source.selfSigned === 'boolean' ? source.selfSigned : null,
      codeSigningEku: source.codeSigningEku === true,
      chainTrusted: source.chainTrusted === true,
      onlineRevocationChecked: source.onlineRevocationChecked === true,
      publicKeyAlgorithm: typeof source.publicKeyAlgorithm === 'string' ? source.publicKeyAlgorithm : null,
      publicKeySize: Number(source.publicKeySize ?? 0),
      timestampChainTrusted: source.timestampChainTrusted === true,
      timestampRevocationChecked: source.timestampRevocationChecked === true,
      releaseProvenanceVerified,
      inspection: typeof source.inspection === 'string' ? source.inspection : 'not-run'
    };
    const verified = platform === 'win32' && productionVerified(observation);
    return {
      ...observation,
      productionVerified: verified,
      blockers: verified ? [] : (platform === 'win32' ? failureReasons(observation) : ['windows-host-required'])
    };
  });
  const groupIds = [...new Set(definitions.map((definition) => definition.groupId))];
  const groups = groupIds.map((id) => {
    const groupArtifacts = artifacts.filter((artifact) => artifact.groupId === id);
    const verifiedArtifactCount = groupArtifacts.filter((artifact) => artifact.productionVerified).length;
    return {
      id,
      status: groupArtifacts.length > 0 && verifiedArtifactCount === groupArtifacts.length ? 'passed' : 'blocked',
      expectedArtifactCount: groupArtifacts.length,
      verifiedArtifactCount,
      artifacts: groupArtifacts
    };
  });
  const status = platform === 'win32' && groups.length > 0 && groups.every((group) => group.status === 'passed')
    ? 'passed'
    : 'blocked';

  return {
    reportVersion: 'jarvis-windows-code-signing-audit-v1',
    generatedAt: clock().toISOString(),
    platform,
    status,
    groups,
    summary: {
      expectedArtifactCount: artifacts.length,
      verifiedArtifactCount: artifacts.filter((artifact) => artifact.productionVerified).length,
      blockerCount: artifacts.filter((artifact) => !artifact.productionVerified).length
    },
    policy: {
      authenticodeStatusRequired: 'Valid',
      trustedChainRequired: true,
      onlineRevocationCheckRequired: true,
      trustedTimestampRequired: true,
      trustedTimestampChainRequired: true,
      fileDigestAlgorithmRequired: 'SHA256',
      timestampProtocolRequired: 'RFC3161',
      timestampDigestAlgorithmRequired: 'SHA256',
      publicKeyPolicy: { algorithm: 'RSA', minimumBits: 2048, maximumBits: 4096 },
      codeSigningEkuRequired: true,
      selfSignedCertificateAllowed: false,
      missingEvidenceFailsClosed: true
    },
    privacy: {
      artifactPathsIncluded: false,
      certificateSubjectsIncluded: false,
      certificateThumbprintsIncluded: false,
      privateKeyMaterialIncluded: false
    }
  };
}

function minimalChildEnvironment(input) {
  return Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    JARVIS_SIGNING_AUDIT_INPUT: input
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
}

async function inspectWithPowerShell(definitions, workspaceRoot) {
  const payload = Buffer.from(JSON.stringify(definitions.map((definition) => ({
    id: definition.id,
    path: resolve(workspaceRoot, definition.relativePath)
  }))), 'utf8').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    powershellAuditScript
  ], {
    cwd: workspaceRoot,
    env: minimalChildEnvironment(payload),
    timeout: 45_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function createWindowsCodeSigningAudit({
  workspaceRoot = repositoryRoot,
  platform = process.platform,
  clock = () => new Date(),
  inspector = inspectWithPowerShell,
  definitions = windowsSigningArtifacts
} = {}) {
  let observations = [];
  let signingRelease = null;
  try {
    signingRelease = JSON.parse(await readFile(resolve(workspaceRoot, 'dist', 'windows-code-signing-release.json'), 'utf8'));
  } catch {
    signingRelease = null;
  }
  if (platform === 'win32') {
    try {
      observations = await inspector(definitions, workspaceRoot);
    } catch {
      observations = definitions.map((definition) => ({
        id: definition.id,
        exists: false,
        authenticodeStatus: 'InspectionError',
        inspection: 'inspector-failed'
      }));
    }
  }
  return evaluateWindowsCodeSigning({ observations, definitions, signingRelease, platform, clock });
}

export function windowsCodeSigningMarkdown(report) {
  const rows = report.groups.flatMap((group) => group.artifacts.map((artifact) =>
    `| ${artifact.productionVerified ? '통과' : '차단'} | ${artifact.label} | ${artifact.authenticodeStatus} | ${artifact.blockers.join(', ') || '-'} |`
  )).join('\n');
  return `# JARVIS Windows 코드 서명 감사\n\n- 판정: ${report.status}\n- 검증: ${report.summary.verifiedArtifactCount}/${report.summary.expectedArtifactCount}\n- 생성 시각: ${report.generatedAt}\n\n| 결과 | 산출물 | Authenticode | 차단 사유 |\n| --- | --- | --- | --- |\n${rows}\n\n유료 Windows 배포에는 신뢰 체인, 코드 서명 EKU, 타임스탬프가 있는 비자체서명 Authenticode 서명이 필요합니다.\n`;
}

export async function writeWindowsCodeSigningAudit(report, {
  jsonPath = resolve('dist', 'windows-code-signing-audit.json'),
  markdownPath = resolve('dist', 'windows-code-signing-audit.md')
} = {}) {
  await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, windowsCodeSigningMarkdown(report), 'utf8')
  ]);
  return { jsonPath, markdownPath };
}

async function runCli() {
  const report = await createWindowsCodeSigningAudit();
  const artifacts = await writeWindowsCodeSigningAudit(report);
  console.log(JSON.stringify({
    status: report.status,
    verifiedArtifactCount: report.summary.verifiedArtifactCount,
    expectedArtifactCount: report.summary.expectedArtifactCount,
    artifacts
  }, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`JARVIS Windows code-signing audit failed: ${error.message}`);
    process.exit(1);
  });
}
