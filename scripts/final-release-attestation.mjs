import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultJsonPath = 'dist/final-release-attestation.json';
const defaultMarkdownPath = 'dist/final-release-attestation.md';
const defaultHashPath = 'dist/final-release-attestation.sha256';

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

async function readJson(path) {
  try {
    return JSON.parse(decodeFileBuffer(await readFile(path)).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function decodeFileBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  const utf8 = buffer.toString('utf8');
  if (utf8.includes('\u0000')) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return utf8.replace(/^\uFEFF/, '');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function check(checkId, passed, detail = {}) {
  return {
    checkId,
    passed: Boolean(passed),
    detail
  };
}

function statusIsSynced(status) {
  return ['synced', 'already-synced'].includes(status);
}

function productionSigningReady(pcProductionSigning) {
  return pcProductionSigning?.production === true && pcProductionSigning?.status === 'passed';
}

function managedObjectLockReady(wormProof) {
  return ['s3-object-lock', 'azure-immutable-blob', 'gcs-bucket-lock'].includes(wormProof?.provider);
}

function rawSecretsAbsent({ signoff, wormProof, ciAnnotations, pcProductionSigning }) {
  return signoff?.generatedArtifacts?.rawAdminTokenStored === false
    && signoff?.generatedArtifacts?.rawWormCredentialStored === false
    && signoff?.generatedArtifacts?.rawExternalCommandStored === false
    && wormProof?.rawCredentialsStored === false
    && wormProof?.rawCommandStored === false
    && (ciAnnotations?.annotations ?? []).every((item) => !JSON.stringify(item).toLowerCase().includes('secret'))
    && pcProductionSigning?.rawCertificateThumbprintStored === false
    && pcProductionSigning?.rawPrivateKeyMaterialStored === false;
}

function buildDistributionReadiness({ wormProof, pcProductionSigning }) {
  const checks = [
    check('production_code_signing_certificate_ready', productionSigningReady(pcProductionSigning), {
      status: pcProductionSigning?.status ?? 'missing',
      production: pcProductionSigning?.production ?? null
    }),
    check('managed_object_lock_worm_storage_ready', managedObjectLockReady(wormProof), {
      provider: wormProof?.provider ?? 'missing',
      status: wormProof?.status ?? 'missing'
    })
  ];
  const ready = checks.every((item) => item.passed);
  return {
    status: ready ? 'external-distribution-ready' : 'pending-production-infrastructure',
    checks,
    nextActions: ready
      ? []
      : [
          'Use a production code-signing certificate and rerun dist/pc-agent-installer/verify-production-signing.ps1 -Production before public distribution.',
          'Promote WORM release evidence to managed immutable storage with object-lock or legal-hold retention before team/public release.'
        ]
  };
}

export async function runFinalReleaseAttestation({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath),
  hashPath = workspacePath(workspaceRoot, defaultHashPath)
} = {}) {
  const [
    ledger,
    finalGate,
    signoff,
    ciAnnotations,
    wormManifest,
    wormProof,
    pcProductionSigning,
    pcReleaseGate
  ] = await Promise.all([
    readJson(workspacePath(workspaceRoot, 'dist/product-completion-ledger.json')),
    readJson(workspacePath(workspaceRoot, 'dist/final-release-gate.json')),
    readJson(workspacePath(workspaceRoot, 'dist/final-signoff-kit-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/ci-verification-annotations.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/manifest.json')),
    readJson(workspacePath(workspaceRoot, 'dist/worm-promotion/external-sync-proof.json')),
    readJson(workspacePath(workspaceRoot, 'dist/pc-agent-installer/production-signing-report.json')),
    readJson(workspacePath(workspaceRoot, 'dist/pc-agent-installer/release-gate-report.json'))
  ]);

  const distributionReadiness = buildDistributionReadiness({ wormProof, pcProductionSigning });
  const blockingChecks = [
    check('product_completion_ledger_ready', ledger?.status === 'ready'
      && ledger?.summary?.blockedDomainCount === 0
      && ledger?.summary?.warningDomainCount === 0, {
      status: ledger?.status ?? 'missing',
      score: ledger?.score ?? null,
      blockedDomainCount: ledger?.summary?.blockedDomainCount ?? null,
      warningDomainCount: ledger?.summary?.warningDomainCount ?? null
    }),
    check('final_release_gate_passed', finalGate?.status === 'passed' && finalGate?.summary?.blockingCheckCount === 0, {
      status: finalGate?.status ?? 'missing',
      blockingCheckCount: finalGate?.summary?.blockingCheckCount ?? null
    }),
    check('final_signoff_ready', signoff?.status === 'ready-for-final-signoff', {
      status: signoff?.status ?? 'missing'
    }),
    check('ci_verification_annotations_passed', ciAnnotations?.status === 'passed' && ciAnnotations?.summary?.errorCount === 0, {
      status: ciAnnotations?.status ?? 'missing',
      errorCount: ciAnnotations?.summary?.errorCount ?? null,
      warningCount: ciAnnotations?.summary?.warningCount ?? null
    }),
    check('worm_manifest_ready', wormManifest?.status === 'ready-for-external-worm-promotion' && Boolean(wormManifest?.bundleHash), {
      status: wormManifest?.status ?? 'missing',
      bundleHash: wormManifest?.bundleHash ?? null,
      artifactCount: wormManifest?.artifactCount ?? null
    }),
    check('worm_sync_verified', statusIsSynced(wormProof?.status) && wormProof?.bundleHash === wormManifest?.bundleHash, {
      proofStatus: wormProof?.status ?? 'missing',
      proofBundleHash: wormProof?.bundleHash ?? null,
      manifestBundleHash: wormManifest?.bundleHash ?? null,
      provider: wormProof?.provider ?? null
    }),
    check('raw_secret_material_absent', rawSecretsAbsent({ signoff, wormProof, ciAnnotations, pcProductionSigning }), {
      signoffRawAdminTokenStored: signoff?.generatedArtifacts?.rawAdminTokenStored ?? null,
      signoffRawWormCredentialStored: signoff?.generatedArtifacts?.rawWormCredentialStored ?? null,
      signoffRawExternalCommandStored: signoff?.generatedArtifacts?.rawExternalCommandStored ?? null,
      wormRawCredentialsStored: wormProof?.rawCredentialsStored ?? null,
      wormRawCommandStored: wormProof?.rawCommandStored ?? null,
      productionSigningRawCertificateThumbprintStored: pcProductionSigning?.rawCertificateThumbprintStored ?? null,
      productionSigningRawPrivateKeyMaterialStored: pcProductionSigning?.rawPrivateKeyMaterialStored ?? null
    })
  ];
  const failedBlocking = blockingChecks.filter((item) => !item.passed);
  const status = failedBlocking.length > 0 ? 'blocked' : 'attested-local-field-release';

  const attestablePayload = {
    attestationVersion: 'jarvis-final-release-attestation-v1',
    status,
    releaseMode: finalGate?.releaseMode ?? 'missing',
    distributionStatus: distributionReadiness.status,
    completionScore: ledger?.score ?? null,
    strictScore: ledger?.summary?.strictScore ?? null,
    productReadinessScore: ledger?.summary?.productReadinessScore ?? null,
    finalReleaseGateStatus: finalGate?.status ?? 'missing',
    finalSignoffStatus: signoff?.status ?? 'missing',
    ciAnnotationStatus: ciAnnotations?.status ?? 'missing',
    wormBundleHash: wormManifest?.bundleHash ?? null,
    wormProofStatus: wormProof?.status ?? 'missing',
    wormProvider: wormProof?.provider ?? 'missing',
    artifactCount: wormManifest?.artifactCount ?? null,
    productionSigningStatus: pcProductionSigning?.status ?? 'missing',
    productionSigningMode: pcProductionSigning?.production === true ? 'production' : 'local-or-not-required',
    pcReleaseGateStatus: pcReleaseGate?.status ?? 'missing',
    checks: blockingChecks,
    distributionChecks: distributionReadiness.checks
  };
  const attestationSha256 = sha256Json(attestablePayload);
  const report = {
    reportVersion: 'jarvis-final-release-attestation-v1',
    generatedAt: new Date().toISOString(),
    status,
    releaseMode: attestablePayload.releaseMode,
    attestationSha256,
    summary: {
      completionScore: attestablePayload.completionScore,
      strictScore: attestablePayload.strictScore,
      productReadinessScore: attestablePayload.productReadinessScore,
      finalReleaseGateStatus: attestablePayload.finalReleaseGateStatus,
      finalSignoffStatus: attestablePayload.finalSignoffStatus,
      ciAnnotationStatus: attestablePayload.ciAnnotationStatus,
      wormBundleHash: attestablePayload.wormBundleHash,
      wormProofStatus: attestablePayload.wormProofStatus,
      wormProvider: attestablePayload.wormProvider,
      artifactCount: attestablePayload.artifactCount,
      productionSigningStatus: attestablePayload.productionSigningStatus,
      productionSigningMode: attestablePayload.productionSigningMode,
      blockingCheckCount: failedBlocking.length
    },
    blockingChecks,
    blockingItems: failedBlocking.map((item) => ({
      checkId: item.checkId,
      detail: item.detail
    })),
    distributionReadiness,
    releaseNotes: buildReleaseNotes({ attestablePayload, distributionReadiness, failedBlocking }),
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      hashPath: resolve(hashPath),
      wormManifestPath: normalizePath('dist/worm-promotion/manifest.json'),
      wormProofPath: normalizePath('dist/worm-promotion/external-sync-proof.json'),
      completionLedgerPath: normalizePath('dist/product-completion-ledger.json'),
      finalGatePath: normalizePath('dist/final-release-gate.json'),
      signoffPath: normalizePath('dist/final-signoff-kit-report.json'),
      ciAnnotationsPath: normalizePath('dist/ci-verification-annotations.json')
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(hashPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(hashPath, `${attestationSha256}  final-release-attestation.json\n`, 'utf8');
  return report;
}

function buildReleaseNotes({ attestablePayload, distributionReadiness, failedBlocking }) {
  return {
    title: 'JARVIS A-G Final Release Attestation',
    localFieldRelease: failedBlocking.length === 0 ? 'ready' : 'blocked',
    externalDistribution: distributionReadiness.status,
    highlights: [
      `Completion ledger: ${attestablePayload.completionScore ?? 'n/a'}%`,
      `Strict implementation: ${attestablePayload.strictScore ?? 'n/a'}`,
      `Product readiness: ${attestablePayload.productReadinessScore ?? 'n/a'}`,
      `Final release gate: ${attestablePayload.finalReleaseGateStatus}`,
      `Final signoff: ${attestablePayload.finalSignoffStatus}`,
      `WORM bundle hash: ${attestablePayload.wormBundleHash ?? 'missing'}`,
      `CI annotations: ${attestablePayload.ciAnnotationStatus}`
    ],
    operatorCommands: [
      'npm run ops:final-gate',
      'npm run ops:signoff-kit',
      'npm run ops:completion-ledger',
      'npm run ops:ci-annotations -- --no-emit',
      'npm run ops:release-attestation'
    ],
    externalDistributionNextActions: distributionReadiness.nextActions
  };
}

function renderMarkdown(report) {
  return [
    '# JARVIS Final Release Attestation',
    '',
    `Status: **${report.status}**`,
    `Release mode: ${report.releaseMode}`,
    `Attestation SHA-256: \`${report.attestationSha256}\``,
    `Completion score: ${report.summary.completionScore ?? 'n/a'}%`,
    `Strict implementation: ${report.summary.strictScore ?? 'n/a'}`,
    `Product readiness: ${report.summary.productReadinessScore ?? 'n/a'}`,
    `Final release gate: ${report.summary.finalReleaseGateStatus}`,
    `Final signoff: ${report.summary.finalSignoffStatus}`,
    `CI annotations: ${report.summary.ciAnnotationStatus}`,
    `WORM bundle hash: \`${report.summary.wormBundleHash ?? 'missing'}\``,
    `WORM provider: ${report.summary.wormProvider}`,
    `Artifacts: ${report.summary.artifactCount ?? 'missing'}`,
    `Production signing: ${report.summary.productionSigningStatus} (${report.summary.productionSigningMode})`,
    '',
    '## Blocking Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.blockingChecks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Distribution Readiness',
    '',
    `Status: **${report.distributionReadiness.status}**`,
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.distributionReadiness.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Release Notes',
    '',
    ...report.releaseNotes.highlights.map((item) => `- ${item}`),
    '',
    '## Operator Commands',
    '',
    ...report.releaseNotes.operatorCommands.map((item) => `- \`${item}\``),
    '',
    '## External Distribution Next Actions',
    '',
    ...(report.releaseNotes.externalDistributionNextActions.length > 0
      ? report.releaseNotes.externalDistributionNextActions.map((item) => `- ${item}`)
      : ['- none']),
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (arg === '--json' || arg === '--output') args.jsonPath = argv[++index];
    else if (arg === '--markdown') args.markdownPath = argv[++index];
    else if (arg === '--sha256' || arg === '--hash') args.hashPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runFinalReleaseAttestation(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Final Release Attestation');
  console.log(`Status: ${report.status}`);
  console.log(`Distribution: ${report.distributionReadiness.status}`);
  console.log(`Attestation SHA-256: ${report.attestationSha256}`);
  console.log('Reports: dist/final-release-attestation.json, dist/final-release-attestation.md, dist/final-release-attestation.sha256');
  if (report.status === 'blocked') process.exitCode = 1;
}
