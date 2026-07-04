import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const textMimePattern = /^text\/|application\/(json|csv|xml|x-ndjson)$/i;
const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.log', '.xml', '.yaml', '.yml']);
const documentExtensions = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.rtf', '.odt', '.ods', '.odp']);
const defaultMaxReadBytes = 64 * 1024;
const defaultMaxPreviewChars = 600;
const execFileAsync = promisify(execFile);

export class CommandInputProviderRegistry {
  constructor({
    clock = () => new Date(),
    allowedRoots = [process.cwd()],
    maxReadBytes = defaultMaxReadBytes,
    maxPreviewChars = defaultMaxPreviewChars,
    providers = null
  } = {}) {
    this.clock = clock;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.maxReadBytes = maxReadBytes;
    this.maxPreviewChars = maxPreviewChars;
    this.providers = providers ?? createDefaultCommandInputProviderPack();
  }

  async extract({ inputMode, attachment = null, payload = {}, approvedContentAccess = false, allowedRoots = null } = {}) {
    const roots = (allowedRoots ?? this.allowedRoots).map((root) => resolve(root));
    const startedAtMs = Date.now();
    const base = {
      extractionVersion: 'a-command-input-provider-extraction-v1',
      inputMode,
      approvedContentAccess,
      rawContentStored: false,
      extractedAt: this.clock().toISOString()
    };
    const provider = this.providers.find((candidate) => candidate.supports({ inputMode, attachment, payload }));
    if (!provider) {
      return {
        ...base,
        providerId: 'a-input-provider-none-v1',
        status: 'unsupported',
        contentRead: false,
        contentPolicy: 'metadata-preserved-content-not-read',
        reason: 'no-provider-supported-input',
        latencyMs: Date.now() - startedAtMs
      };
    }
    if (!approvedContentAccess && provider.requiresContentApproval({ attachment, payload })) {
      return {
        ...base,
        providerId: provider.providerId,
        status: 'requires_approval',
        contentRead: false,
        contentPolicy: 'metadata-preserved-content-not-read',
        reason: 'content-access-not-approved',
        providerContractVersion: provider.providerContract?.contractVersion ?? null,
        latencyMs: Date.now() - startedAtMs
      };
    }

    try {
      const result = await provider.extract({
        attachment,
        payload,
        allowedRoots: roots,
        maxReadBytes: this.maxReadBytes,
        maxPreviewChars: this.maxPreviewChars
      });
      return normalizeExtractionResult({
        ...base,
        ...result,
        providerId: provider.providerId,
        providerContractVersion: provider.providerContract?.contractVersion ?? null,
        latencyMs: Date.now() - startedAtMs
      });
    } catch (error) {
      return {
        ...base,
        providerId: provider.providerId,
        status: 'failed',
        contentRead: false,
        contentPolicy: 'metadata-preserved-content-not-read',
        errorCode: error.code ?? 'A_INPUT_PROVIDER_FAILED',
        errorMessage: error.message,
        providerContractVersion: provider.providerContract?.contractVersion ?? null,
        latencyMs: Date.now() - startedAtMs
      };
    }
  }

  providerCatalog() {
    return {
      catalogVersion: 'a-command-input-provider-catalog-v1',
      generatedAt: this.clock().toISOString(),
      providers: this.providers.map((provider) => ({
        providerId: provider.providerId,
        providerKind: provider.providerKind ?? 'local',
        configured: typeof provider.configured === 'function' ? provider.configured() : true,
        contract: provider.providerContract ?? null,
        supportedInputModes: provider.supportedInputModes ?? []
      }))
    };
  }
}

export function createDefaultCommandInputProviderPack(options = {}) {
  return [
    new ExternalSttCommandProvider(options.stt ?? {}),
    new LocalVoiceTranscriptProvider(),
    new ExternalOcrCommandProvider(options.ocr ?? {}),
    new LocalImageOcrProvider(),
    new DocumentParserCommandProvider(options.document ?? {}),
    new LocalTextFileInputProvider()
  ];
}

export class LocalTextFileInputProvider {
  constructor() {
    this.providerId = 'a-local-file-text-provider-v1';
  }

  supports({ inputMode, attachment }) {
    if (inputMode !== 'file' || !attachment) return false;
    const mimeType = String(attachment.mimeType ?? attachment.contentType ?? '');
    const name = String(attachment.name ?? attachment.fileName ?? attachment.path ?? attachment.uri ?? '');
    return textMimePattern.test(mimeType) || textExtensions.has(extname(name).toLowerCase());
  }

  requiresContentApproval() {
    return true;
  }

  async extract({ attachment, allowedRoots, maxReadBytes, maxPreviewChars }) {
    const localPath = localPathForAttachment(attachment);
    if (!localPath) {
      return metadataOnlyExtraction({
        status: 'metadata_only',
        reason: 'attachment-uri-is-not-local-file',
        trustBoundary: 'LOCAL_FILE_CONTENT'
      });
    }
    assertAllowedLocalPath(localPath, allowedRoots);
    const read = await readLocalTextSample(localPath, { maxReadBytes });
    return extractionFromText(read.text, {
      status: 'extracted',
      contentSource: 'local-text-file',
      trustBoundary: 'LOCAL_FILE_CONTENT',
      sampled: read.sampled,
      sourcePath: localPath,
      sourceSizeBytes: read.sizeBytes,
      maxPreviewChars
    });
  }
}

export class LocalVoiceTranscriptProvider {
  constructor() {
    this.providerId = 'a-local-voice-transcript-provider-v1';
  }

  supports({ inputMode }) {
    return inputMode === 'voice';
  }

  requiresContentApproval({ payload }) {
    return !payload?.transcript;
  }

  async extract({ attachment, payload, allowedRoots, maxReadBytes, maxPreviewChars }) {
    if (payload?.transcript) {
      return extractionFromText(payload.transcript, {
        status: 'extracted',
        contentSource: 'provided-transcript',
        trustBoundary: 'USER_COMMAND',
        sampled: false,
        confidence: payload.confidence ?? null,
        maxPreviewChars
      });
    }
    const transcriptPath = attachment?.transcriptPath ?? attachment?.metadata?.transcriptPath;
    if (!transcriptPath) {
      return metadataOnlyExtraction({
        status: 'missing_content',
        reason: 'voice-transcript-not-provided',
        trustBoundary: 'USER_COMMAND'
      });
    }
    const localPath = localPathFromValue(transcriptPath);
    assertAllowedLocalPath(localPath, allowedRoots);
    const read = await readLocalTextSample(localPath, { maxReadBytes });
    return extractionFromText(read.text, {
      status: 'extracted',
      contentSource: 'local-transcript-sidecar',
      trustBoundary: 'USER_COMMAND',
      sampled: read.sampled,
      sourcePath: localPath,
      sourceSizeBytes: read.sizeBytes,
      maxPreviewChars
    });
  }
}

export class LocalImageOcrProvider {
  constructor() {
    this.providerId = 'a-local-image-ocr-provider-v1';
  }

  supports({ inputMode }) {
    return inputMode === 'image';
  }

  requiresContentApproval({ attachment, payload }) {
    return !(payload?.ocrText || attachment?.ocrText || attachment?.metadata?.ocrText);
  }

  async extract({ attachment, payload, allowedRoots, maxReadBytes, maxPreviewChars }) {
    const inlineOcr = payload?.ocrText ?? attachment?.ocrText ?? attachment?.metadata?.ocrText;
    if (inlineOcr) {
      return extractionFromText(inlineOcr, {
        status: 'extracted',
        contentSource: 'provided-ocr-text',
        trustBoundary: 'LOCAL_FILE_CONTENT',
        sampled: false,
        maxPreviewChars
      });
    }
    const ocrPath = attachment?.ocrTextPath ?? attachment?.metadata?.ocrTextPath;
    if (!ocrPath) {
      return metadataOnlyExtraction({
        status: 'missing_content',
        reason: 'image-ocr-text-not-provided',
        trustBoundary: 'LOCAL_FILE_CONTENT'
      });
    }
    const localPath = localPathFromValue(ocrPath);
    assertAllowedLocalPath(localPath, allowedRoots);
    const read = await readLocalTextSample(localPath, { maxReadBytes });
    return extractionFromText(read.text, {
      status: 'extracted',
      contentSource: 'local-ocr-sidecar',
      trustBoundary: 'LOCAL_FILE_CONTENT',
      sampled: read.sampled,
      sourcePath: localPath,
      sourceSizeBytes: read.sizeBytes,
      maxPreviewChars
    });
  }
}

export class ExternalSttCommandProvider {
  constructor({
    command = process.env.JARVIS_STT_COMMAND,
    args = null,
    commandRunner = null,
    timeoutMs = 15_000
  } = {}) {
    this.providerId = 'a-stt-command-provider-v1';
    this.providerKind = 'external-command';
    this.supportedInputModes = ['voice'];
    this.commandSpec = commandSpecFrom({ command, args, defaultArgs: ['{inputPath}'] });
    this.commandRunner = commandRunner;
    this.timeoutMs = timeoutMs;
    this.providerContract = {
      contractVersion: 'a-command-input-real-provider-contract-v1',
      engineType: 'speech-to-text',
      inputMode: 'voice',
      rawContentStored: false,
      requiresApproval: true,
      output: 'redacted-safe-preview-and-content-hash'
    };
  }

  configured() {
    return Boolean(this.commandSpec || this.commandRunner);
  }

  supports({ inputMode, attachment }) {
    return inputMode === 'voice' && Boolean(attachment) && this.configured();
  }

  requiresContentApproval() {
    return true;
  }

  async extract({ attachment, allowedRoots, maxPreviewChars }) {
    const localPath = localPathForAttachment(attachment);
    if (!localPath) {
      return metadataOnlyExtraction({
        status: 'metadata_only',
        reason: 'voice-audio-uri-is-not-local-file',
        trustBoundary: 'USER_COMMAND'
      });
    }
    assertAllowedLocalPath(localPath, allowedRoots);
    const output = await runProviderCommand({
      commandSpec: this.commandSpec,
      commandRunner: this.commandRunner,
      inputPath: localPath,
      timeoutMs: this.timeoutMs,
      kind: 'stt'
    });
    return extractionFromText(output.text, {
      status: 'extracted',
      contentSource: 'external-stt-command',
      trustBoundary: 'USER_COMMAND',
      sampled: false,
      sourcePath: localPath,
      sourceSizeBytes: null,
      confidence: output.confidence ?? null,
      maxPreviewChars,
      adapter: output.adapter
    });
  }
}

export class ExternalOcrCommandProvider {
  constructor({
    command = process.env.JARVIS_OCR_COMMAND,
    args = null,
    commandRunner = null,
    timeoutMs = 15_000
  } = {}) {
    this.providerId = 'a-ocr-command-provider-v1';
    this.providerKind = 'external-command';
    this.supportedInputModes = ['image'];
    this.commandSpec = commandSpecFrom({ command, args, defaultArgs: ['{inputPath}'] });
    this.commandRunner = commandRunner;
    this.timeoutMs = timeoutMs;
    this.providerContract = {
      contractVersion: 'a-command-input-real-provider-contract-v1',
      engineType: 'ocr',
      inputMode: 'image',
      rawContentStored: false,
      requiresApproval: true,
      output: 'redacted-safe-preview-and-content-hash'
    };
  }

  configured() {
    return Boolean(this.commandSpec || this.commandRunner);
  }

  supports({ inputMode, attachment, payload }) {
    return inputMode === 'image' && Boolean(attachment) && !payload?.ocrText && this.configured();
  }

  requiresContentApproval() {
    return true;
  }

  async extract({ attachment, allowedRoots, maxPreviewChars }) {
    const localPath = localPathForAttachment(attachment);
    if (!localPath) {
      return metadataOnlyExtraction({
        status: 'metadata_only',
        reason: 'image-uri-is-not-local-file',
        trustBoundary: 'LOCAL_FILE_CONTENT'
      });
    }
    assertAllowedLocalPath(localPath, allowedRoots);
    const output = await runProviderCommand({
      commandSpec: this.commandSpec,
      commandRunner: this.commandRunner,
      inputPath: localPath,
      timeoutMs: this.timeoutMs,
      kind: 'ocr'
    });
    return extractionFromText(output.text, {
      status: 'extracted',
      contentSource: 'external-ocr-command',
      trustBoundary: 'LOCAL_FILE_CONTENT',
      sampled: false,
      sourcePath: localPath,
      sourceSizeBytes: null,
      confidence: output.confidence ?? null,
      maxPreviewChars,
      adapter: output.adapter
    });
  }
}

export class DocumentParserCommandProvider {
  constructor({
    command = process.env.JARVIS_DOCUMENT_PARSER_COMMAND,
    args = null,
    pdfCommand = process.env.JARVIS_PDF_TEXT_COMMAND,
    officeCommand = process.env.JARVIS_OFFICE_TEXT_COMMAND,
    commandRunner = null,
    timeoutMs = 20_000
  } = {}) {
    this.providerId = 'a-document-parser-provider-v1';
    this.providerKind = 'external-command';
    this.supportedInputModes = ['file'];
    this.defaultCommandSpec = commandSpecFrom({ command, args, defaultArgs: ['{inputPath}'] });
    this.pdfCommandSpec = commandSpecFrom({ command: pdfCommand, defaultArgs: ['{inputPath}'] });
    this.officeCommandSpec = commandSpecFrom({ command: officeCommand, defaultArgs: ['{inputPath}'] });
    this.commandRunner = commandRunner;
    this.timeoutMs = timeoutMs;
    this.providerContract = {
      contractVersion: 'a-command-input-document-parser-contract-v1',
      engineType: 'document-parser',
      inputMode: 'file',
      supportedExtensions: [...documentExtensions],
      rawContentStored: false,
      requiresApproval: true,
      output: 'redacted-safe-preview-and-content-hash'
    };
  }

  configured() {
    return Boolean(this.defaultCommandSpec || this.pdfCommandSpec || this.officeCommandSpec || this.commandRunner);
  }

  supports({ inputMode, attachment }) {
    if (inputMode !== 'file' || !attachment) return false;
    return documentExtensions.has(extname(String(attachment.name ?? attachment.fileName ?? attachment.path ?? attachment.uri ?? '')).toLowerCase());
  }

  requiresContentApproval() {
    return true;
  }

  async extract({ attachment, allowedRoots, maxPreviewChars }) {
    const localPath = localPathForAttachment(attachment);
    if (!localPath) {
      return metadataOnlyExtraction({
        status: 'metadata_only',
        reason: 'document-uri-is-not-local-file',
        trustBoundary: 'LOCAL_FILE_CONTENT'
      });
    }
    assertAllowedLocalPath(localPath, allowedRoots);
    const family = documentFamilyForPath(localPath);
    const commandSpec = family === 'pdf'
      ? this.pdfCommandSpec ?? this.defaultCommandSpec
      : this.officeCommandSpec ?? this.defaultCommandSpec;
    if (!commandSpec && !this.commandRunner) {
      return {
        ...metadataOnlyExtraction({
          status: 'provider_not_configured',
          reason: `${family}-parser-command-not-configured`,
          trustBoundary: 'LOCAL_FILE_CONTENT'
        }),
        contentSource: `${family}-document-parser`
      };
    }
    const output = await runProviderCommand({
      commandSpec,
      commandRunner: this.commandRunner,
      inputPath: localPath,
      timeoutMs: this.timeoutMs,
      kind: family
    });
    return extractionFromText(output.text, {
      status: 'extracted',
      contentSource: `${family}-document-parser-command`,
      trustBoundary: 'LOCAL_FILE_CONTENT',
      sampled: false,
      sourcePath: localPath,
      sourceSizeBytes: null,
      confidence: output.confidence ?? null,
      maxPreviewChars,
      adapter: output.adapter
    });
  }
}

export async function runCommandInputProviderQualityReport({
  registry = new CommandInputProviderRegistry(),
  fixtures = defaultCommandInputProviderQualityFixtures(),
  allowedRoots = [process.cwd()],
  failBelowAccuracy = 0.9,
  clock = () => new Date()
} = {}) {
  const catalog = registry.providerCatalog?.() ?? null;
  const results = [];
  for (const fixture of fixtures) {
    const startedAtMs = Date.now();
    const extraction = await registry.extract({
      inputMode: fixture.inputMode,
      attachment: fixture.attachment,
      payload: fixture.payload ?? {},
      approvedContentAccess: fixture.approvedContentAccess !== false,
      allowedRoots
    });
    const elapsedMs = extraction.latencyMs ?? Date.now() - startedAtMs;
    const expectedTextIncludes = fixture.expectedTextIncludes ?? [];
    const textMatched = expectedTextIncludes.every((text) => String(extraction.safePreview ?? '').includes(text));
    const providerMatched = fixture.expectedProviderId ? extraction.providerId === fixture.expectedProviderId : true;
    const hashMatched = fixture.expectedContentHash ? extraction.contentHash === fixture.expectedContentHash : true;
    const passed = extraction.status === 'extracted' && textMatched && providerMatched && hashMatched && extraction.rawContentStored === false;
    const expectedTextIncludesHashes = expectedTextIncludes.map((text) => `sha256:${sha256(text)}`);
    results.push({
      fixtureId: fixture.fixtureId,
      inputMode: fixture.inputMode,
      fixtureSpecHash: `sha256:${sha256(JSON.stringify({
        fixtureId: fixture.fixtureId,
        inputMode: fixture.inputMode,
        expectedProviderId: fixture.expectedProviderId ?? null,
        expectedTextIncludesHashes,
        expectedContentHash: fixture.expectedContentHash ?? null,
        attachmentNameHash: fixture.attachment?.name ? `sha256:${sha256(fixture.attachment.name)}` : null,
        attachmentMimeType: fixture.attachment?.mimeType ?? fixture.attachment?.contentType ?? null
      }))}`,
      expectedProviderId: fixture.expectedProviderId ?? null,
      actualProviderId: extraction.providerId,
      status: passed ? 'passed' : 'failed',
      extractionStatus: extraction.status,
      contentSource: extraction.contentSource ?? null,
      latencyMs: elapsedMs,
      contentRead: extraction.contentRead,
      rawContentStored: extraction.rawContentStored,
      rawExpectedTextStored: false,
      rawAttachmentPathStored: false,
      expectedTextIncludesCount: expectedTextIncludes.length,
      expectedTextIncludesHashes,
      textMatched,
      providerMatched,
      hashMatched,
      redactionApplied: extraction.redaction?.applied ?? false,
      errorCode: extraction.errorCode ?? null
    });
  }
  const passedCount = results.filter((item) => item.status === 'passed').length;
  const providerGroups = groupProviderQuality(results);
  const latencies = results.map((item) => item.latencyMs).filter(Number.isFinite).sort((left, right) => left - right);
  const driftItems = results.filter((item) => !item.providerMatched || !item.hashMatched || !item.textMatched);
  const accuracy = results.length ? Number((passedCount / results.length).toFixed(4)) : 0;
  const report = {
    reportVersion: 'a-command-input-provider-quality-report-v1',
    driftVersion: 'a-command-input-provider-drift-telemetry-v1',
    generatedAt: clock().toISOString(),
    status: accuracy >= failBelowAccuracy && driftItems.length === 0 ? 'passed' : 'failed',
    failBelowAccuracy,
    fixtureCount: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    accuracy,
    latency: {
      minMs: latencies[0] ?? null,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      maxMs: latencies.at(-1) ?? null
    },
    providerGroups,
    drift: {
      status: driftItems.length ? 'drift_detected' : 'clean',
      driftCount: driftItems.length,
      items: driftItems.map((item) => ({
        fixtureId: item.fixtureId,
        expectedProviderId: item.expectedProviderId,
        actualProviderId: item.actualProviderId,
        textMatched: item.textMatched,
        hashMatched: item.hashMatched
      }))
    },
    catalog,
    results
  };
  const deploymentReadiness = createCommandInputProviderDeploymentReadiness({ report });
  const releaseDossier = createCommandInputProviderReleaseDossier({ report, deploymentReadiness });
  const productGate = createCommandInputProviderProductGate({ report, deploymentReadiness, releaseDossier });
  return {
    ...report,
    deploymentReadiness,
    releaseDossier,
    productGate
  };
}

export function createCommandInputProviderDeploymentReadiness({
  report,
  requiredProviderIds = [
    'a-stt-command-provider-v1',
    'a-ocr-command-provider-v1',
    'a-document-parser-provider-v1'
  ]
} = {}) {
  const catalogProviders = report?.catalog?.providers ?? [];
  const providerGroups = report?.providerGroups ?? [];
  const items = requiredProviderIds.map((providerId) => {
    const catalog = catalogProviders.find((provider) => provider.providerId === providerId) ?? null;
    const quality = providerGroups.find((provider) => provider.providerId === providerId) ?? null;
    const configured = catalog?.configured === true;
    const tested = Boolean(quality && quality.fixtureCount >= 1 && quality.failedCount === 0);
    return {
      providerId,
      configured,
      tested,
      contractVersion: catalog?.contract?.contractVersion ?? null,
      fixtureCount: quality?.fixtureCount ?? 0,
      accuracy: quality?.accuracy ?? 0,
      p95LatencyMs: quality?.p95LatencyMs ?? null,
      status: configured && tested ? 'passed' : 'failed'
    };
  });
  return {
    readinessVersion: 'a-command-input-provider-deployment-readiness-v1',
    generatedAt: new Date().toISOString(),
    status: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    requiredProviderIds,
    rawContentStored: false,
    items
  };
}

export function createCommandInputProviderReleaseDossier({
  report,
  deploymentReadiness = createCommandInputProviderDeploymentReadiness({ report })
} = {}) {
  const artifactManifest = createCommandInputProviderReleaseArtifactManifest({ report, deploymentReadiness });
  const longTermDriftTrend = createCommandInputProviderLongTermDriftTrend({ report });
  const ciNightlyGatePlan = createCommandInputProviderCiNightlyGatePlan({ report });
  const operationalHandoffManifest = createCommandInputProviderOperationalHandoffManifest({ report, deploymentReadiness });
  const externalWormPromotionPackage = createCommandInputProviderExternalWormPromotionPackage({
    artifactManifest,
    longTermDriftTrend,
    ciNightlyGatePlan,
    operationalHandoffManifest
  });
  const status = report?.status === 'passed'
    && report?.drift?.status === 'clean'
    && deploymentReadiness.status === 'passed'
    && operationalHandoffManifest.status === 'ready'
    && artifactManifest.rawLeakCheck.rawLeakDetected === false
    && externalWormPromotionPackage.status === 'ready'
    ? 'passed'
    : 'failed';
  return {
    dossierVersion: 'a-command-input-provider-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status,
    reportVersion: report?.reportVersion ?? null,
    driftVersion: report?.driftVersion ?? null,
    readinessVersion: deploymentReadiness.readinessVersion,
    fixtureCount: report?.fixtureCount ?? 0,
    accuracy: report?.accuracy ?? 0,
    p95LatencyMs: report?.latency?.p95Ms ?? null,
    driftStatus: report?.drift?.status ?? 'unknown',
    providerCount: deploymentReadiness.items.length,
    rawContentStored: false,
    rawExpectedTextStored: false,
    rawAttachmentPathsStored: false,
    artifactManifest,
    longTermDriftTrend,
    ciNightlyGatePlan,
    operationalHandoffManifest,
    externalWormPromotionPackage,
    recommendedReleaseAction: status === 'passed'
      ? 'attach_provider_quality_report_release_dossier_and_worm_promotion_package'
      : 'block_command_input_provider_release_until_quality_gate_passes'
  };
}

export function createCommandInputProviderReleaseArtifactManifest({
  report,
  deploymentReadiness = createCommandInputProviderDeploymentReadiness({ report })
} = {}) {
  const providerContractManifest = {
    manifestVersion: 'a-command-input-provider-contract-manifest-v1',
    providerCount: deploymentReadiness.items.length,
    providers: deploymentReadiness.items.map((item) => ({
      providerId: item.providerId,
      configured: item.configured,
      tested: item.tested,
      contractVersion: item.contractVersion,
      contractHash: `sha256:${sha256(`${item.providerId}:${item.contractVersion ?? 'none'}`)}`,
      status: item.status
    }))
  };
  const providerQualityArtifacts = (report?.providerGroups ?? []).map((item) => ({
    providerId: item.providerId,
    fixtureCount: item.fixtureCount,
    accuracy: item.accuracy,
    p95LatencyMs: item.p95LatencyMs,
    artifactHash: `sha256:${sha256(JSON.stringify({
      providerId: item.providerId,
      fixtureCount: item.fixtureCount,
      accuracy: item.accuracy,
      p95LatencyMs: item.p95LatencyMs
    }))}`
  }));
  const rawLeakSurface = JSON.stringify({
    providerContractManifest,
    providerQualityArtifacts,
    reportVersion: report?.reportVersion ?? null,
    driftVersion: report?.driftVersion ?? null,
    resultHashes: (report?.results ?? []).map((item) => item.fixtureSpecHash)
  });
  const forbiddenTokens = ['expectedTextIncludes', 'safePreview', 'sourcePath', 'attachmentPath', 'transcriptPath', 'ocrTextPath'];
  const rawLeakDetected = forbiddenTokens.some((token) => rawLeakSurface.includes(token));
  return {
    artifactManifestVersion: 'a-command-input-provider-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    qualityReportHash: `sha256:${sha256(JSON.stringify({
      reportVersion: report?.reportVersion ?? null,
      status: report?.status ?? null,
      accuracy: report?.accuracy ?? null,
      fixtureCount: report?.fixtureCount ?? 0,
      providerGroups: report?.providerGroups ?? [],
      resultHashes: (report?.results ?? []).map((item) => item.fixtureSpecHash)
    }))}`,
    driftTelemetryHash: `sha256:${sha256(JSON.stringify(report?.drift ?? null))}`,
    deploymentReadinessHash: `sha256:${sha256(JSON.stringify(deploymentReadiness))}`,
    providerContractManifest,
    providerQualityArtifacts,
    rawContentStored: false,
    rawExpectedTextStored: false,
    rawAttachmentPathsStored: false,
    rawLeakCheck: {
      checkVersion: 'a-command-input-provider-raw-leak-check-v1',
      checkedFixtureCount: report?.fixtureCount ?? 0,
      checkedProviderCount: providerContractManifest.providerCount,
      forbiddenTokenCount: forbiddenTokens.length,
      rawLeakDetected
    }
  };
}

export function createCommandInputProviderLongTermDriftTrend({ report } = {}) {
  return {
    trendVersion: 'a-command-input-provider-long-term-drift-trend-v1',
    generatedAt: new Date().toISOString(),
    currentStatus: report?.drift?.status ?? 'unknown',
    driftCount: report?.drift?.driftCount ?? 0,
    accuracy: report?.accuracy ?? 0,
    providerCount: report?.providerGroups?.length ?? 0,
    fixtureCount: report?.fixtureCount ?? 0,
    retentionPolicy: {
      minimumRetentionDays: 365,
      rawUserContentStored: false,
      rawFixtureTextStored: false,
      hashOnlyCorpus: true
    },
    trendPointHash: `sha256:${sha256(JSON.stringify({
      generatedAt: report?.generatedAt ?? null,
      driftStatus: report?.drift?.status ?? null,
      driftCount: report?.drift?.driftCount ?? 0,
      accuracy: report?.accuracy ?? 0,
      providerGroups: report?.providerGroups ?? []
    }))}`
  };
}

export function createCommandInputProviderCiNightlyGatePlan({ report } = {}) {
  return {
    planVersion: 'a-command-input-provider-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run command-input:quality',
    requiredForPr: true,
    requiredForNightly: true,
    failBelowAccuracy: report?.failBelowAccuracy ?? 0.9,
    requiredProviders: [
      'a-stt-command-provider-v1',
      'a-ocr-command-provider-v1',
      'a-document-parser-provider-v1'
    ],
    requiredChecks: [
      'command_input_quality_report_passed',
      'command_input_provider_drift_clean',
      'command_input_operational_handoff_ready',
      'command_input_release_artifact_manifest_ready',
      'command_input_worm_promotion_package_ready'
    ],
    artifactOutputs: [
      'dist/command-input-provider-quality-report.json',
      'dist/command-input-provider-quality-report.md',
      'dist/command-input-provider-quality-report.csv'
    ],
    rawContentStored: false,
    planHash: `sha256:${sha256(JSON.stringify({
      reportVersion: report?.reportVersion ?? null,
      failBelowAccuracy: report?.failBelowAccuracy ?? 0.9,
      fixtureCount: report?.fixtureCount ?? 0
    }))}`
  };
}

export function createCommandInputProviderOperationalHandoffManifest({
  report,
  deploymentReadiness = createCommandInputProviderDeploymentReadiness({ report }),
  maxP95LatencyMs = 1500
} = {}) {
  const providerGroups = new Map((report?.providerGroups ?? []).map((item) => [item.providerId, item]));
  const requiredProviderIds = [
    'a-stt-command-provider-v1',
    'a-ocr-command-provider-v1',
    'a-document-parser-provider-v1'
  ];
  const providers = deploymentReadiness.items.map((item) => {
    const quality = providerGroups.get(item.providerId);
    return {
      providerId: item.providerId,
      contractVersion: item.contractVersion,
      configured: item.configured,
      tested: item.tested,
      requiredForOperationalRelease: requiredProviderIds.includes(item.providerId),
      fixtureCount: quality?.fixtureCount ?? 0,
      accuracy: quality?.accuracy ?? 0,
      p95LatencyMs: quality?.p95LatencyMs ?? null,
      healthStatus: item.configured && item.tested && (quality?.accuracy ?? 0) >= 1 && (!Number.isFinite(quality?.p95LatencyMs) || quality.p95LatencyMs <= maxP95LatencyMs)
        ? 'ready'
        : 'blocked',
      rawProviderCommandStored: false
    };
  });
  const requiredReady = requiredProviderIds.every((providerId) => providers.some((provider) => provider.providerId === providerId && provider.healthStatus === 'ready'));
  return {
    manifestVersion: 'a-command-input-provider-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'a-command-input-provider-health-handshake-v1',
    fallbackPolicy: {
      policyVersion: 'a-command-input-provider-fallback-policy-v1',
      localFirstWhenProvidedTextExists: true,
      externalCommandRequiredForAudioImageAndDocumentFiles: true,
      preserveMetadataWhenProviderUnavailable: true,
      rawContentStoredDuringFallback: false
    },
    generatedAt: new Date().toISOString(),
    status: requiredReady ? 'ready' : 'blocked',
    requiredProviderIds,
    maxP95LatencyMs,
    providers,
    providerHealthHash: `sha256:${sha256(JSON.stringify(providers.map((provider) => ({
      providerId: provider.providerId,
      contractVersion: provider.contractVersion,
      healthStatus: provider.healthStatus,
      fixtureCount: provider.fixtureCount,
      accuracy: provider.accuracy,
      p95LatencyMs: provider.p95LatencyMs
    }))))}`,
    rawProviderCommandStored: false,
    rawFixturePayloadStored: false,
    rawAttachmentPathsStored: false
  };
}

export function createCommandInputProviderExternalWormPromotionPackage({
  artifactManifest,
  longTermDriftTrend,
  ciNightlyGatePlan,
  operationalHandoffManifest
} = {}) {
  return {
    packageVersion: 'a-command-input-provider-worm-promotion-package-v1',
    providerContractVersion: 'a-command-input-provider-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'a-command-input-provider-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && operationalHandoffManifest?.status === 'ready'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: `sha256:${sha256(JSON.stringify(artifactManifest ?? null))}`,
    driftTrendHash: `sha256:${sha256(JSON.stringify(longTermDriftTrend ?? null))}`,
    ciNightlyGatePlanHash: `sha256:${sha256(JSON.stringify(ciNightlyGatePlan ?? null))}`,
    operationalHandoffHash: `sha256:${sha256(JSON.stringify(operationalHandoffManifest ?? null))}`,
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawContentStored: false,
    rawExpectedTextStored: false,
    rawAttachmentPathsStored: false,
    rawProviderCommandStored: false
  };
}

export function createCommandInputProviderProductGate({
  report,
  deploymentReadiness = createCommandInputProviderDeploymentReadiness({ report }),
  releaseDossier = createCommandInputProviderReleaseDossier({ report, deploymentReadiness }),
  minAccuracy = 0.9,
  maxP95LatencyMs = 1500
} = {}) {
  const checks = [
    {
      checkId: 'command_input_quality_report_passed',
      passed: report?.reportVersion === 'a-command-input-provider-quality-report-v1'
        && report?.status === 'passed'
        && Number(report?.accuracy ?? 0) >= minAccuracy
    },
    {
      checkId: 'command_input_provider_drift_clean',
      passed: report?.driftVersion === 'a-command-input-provider-drift-telemetry-v1'
        && report?.drift?.status === 'clean'
    },
    {
      checkId: 'command_input_raw_content_not_stored',
      passed: (report?.results ?? []).every((item) => item.rawContentStored === false
        && item.rawExpectedTextStored === false
        && item.rawAttachmentPathStored === false
        && !Object.hasOwn(item, 'expectedTextIncludes'))
    },
    {
      checkId: 'command_input_required_providers_configured_and_tested',
      passed: deploymentReadiness.readinessVersion === 'a-command-input-provider-deployment-readiness-v1'
        && deploymentReadiness.status === 'passed'
    },
    {
      checkId: 'command_input_latency_budget_met',
      passed: !Number.isFinite(report?.latency?.p95Ms) || Number(report.latency.p95Ms) <= maxP95LatencyMs
    },
    {
      checkId: 'command_input_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'a-command-input-provider-release-dossier-v1'
        && releaseDossier.status === 'passed'
    },
    {
      checkId: 'command_input_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-command-input-provider-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
    },
    {
      checkId: 'command_input_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'a-command-input-provider-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'a-command-input-provider-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
    },
    {
      checkId: 'command_input_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-command-input-provider-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-command-input-provider-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    },
    {
      checkId: 'command_input_ci_nightly_gate_plan_ready',
      passed: releaseDossier.ciNightlyGatePlan?.planVersion === 'a-command-input-provider-ci-nightly-gate-plan-v1'
        && releaseDossier.ciNightlyGatePlan?.requiredForPr === true
        && releaseDossier.ciNightlyGatePlan?.requiredForNightly === true
    }
  ];
  return {
    productGateVersion: 'a-command-input-provider-product-gate-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    thresholds: {
      minAccuracy,
      maxP95LatencyMs
    },
    checks,
    deploymentReadiness,
    releaseDossier
  };
}

export function defaultCommandInputProviderQualityFixtures() {
  return [
    {
      fixtureId: 'voice.stt_command_provider',
      inputMode: 'voice',
      expectedProviderId: 'a-stt-command-provider-v1',
      expectedTextIncludes: ['회의록'],
      attachment: { name: 'fixture.wav', path: 'fixture.wav', mimeType: 'audio/wav' }
    },
    {
      fixtureId: 'image.ocr_command_provider',
      inputMode: 'image',
      expectedProviderId: 'a-ocr-command-provider-v1',
      expectedTextIncludes: ['화면'],
      attachment: { name: 'screen.png', path: 'screen.png', mimeType: 'image/png' }
    },
    {
      fixtureId: 'document.pdf_parser_provider',
      inputMode: 'file',
      expectedProviderId: 'a-document-parser-provider-v1',
      expectedTextIncludes: ['PDF'],
      attachment: { name: 'brief.pdf', path: 'brief.pdf', mimeType: 'application/pdf' }
    },
    {
      fixtureId: 'document.office_parser_provider',
      inputMode: 'file',
      expectedProviderId: 'a-document-parser-provider-v1',
      expectedTextIncludes: ['Office'],
      attachment: { name: 'brief.docx', path: 'brief.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    }
  ];
}

export function buildCommandTextFromExtraction({ prompt = '', fallback = '', extraction }) {
  const base = String(prompt || fallback || '').trim();
  if (!extraction || extraction.status !== 'extracted' || !extraction.safePreview) return base || fallback;
  const prefix = base ? `${base}\n\n` : '';
  return `${prefix}첨부 추출 요약: ${extraction.safePreview}`.trim();
}

function normalizeExtractionResult(result) {
  return {
    contentRead: result.status === 'extracted',
    contentPolicy: result.status === 'extracted'
      ? 'approved-provider-redacted-preview-raw-content-not-stored'
      : 'metadata-preserved-content-not-read',
    rawContentStored: false,
    ...result
  };
}

function metadataOnlyExtraction({ status, reason, trustBoundary }) {
  return {
    status,
    contentRead: false,
    rawContentStored: false,
    trustBoundary,
    reason
  };
}

function extractionFromText(value, {
  status,
  contentSource,
  trustBoundary,
  sampled,
  sourcePath = null,
  sourceSizeBytes = null,
  confidence = null,
  maxPreviewChars,
  adapter = null
}) {
  const text = String(value ?? '');
  const redacted = redactSensitiveText(text);
  const safePreview = previewText(redacted.text, maxPreviewChars);
  return {
    status,
    contentRead: true,
    rawContentStored: false,
    contentSource,
    trustBoundary,
    sampled,
    sourcePath,
    sourceSizeBytes,
    extractedTextLength: text.length,
    safePreview,
    safePreviewLength: safePreview.length,
    contentHash: `sha256:${sha256(text)}`,
    redaction: redacted.redaction,
    confidence,
    adapter
  };
}

async function readLocalTextSample(path, { maxReadBytes }) {
  const stats = await stat(path);
  const bytesToRead = Math.min(stats.size, maxReadBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(path, 'r');
  try {
    await handle.read(buffer, 0, bytesToRead, 0);
  } finally {
    await handle.close();
  }
  return {
    text: buffer.toString('utf8'),
    sampled: stats.size > maxReadBytes,
    sizeBytes: stats.size
  };
}

function commandSpecFrom({ command, args = null, defaultArgs = [] } = {}) {
  if (!command) return null;
  if (Array.isArray(command)) {
    const [executable, ...rest] = command;
    return executable ? { command: executable, args: args ?? rest } : null;
  }
  if (typeof command === 'object') {
    return command.command ? { command: command.command, args: command.args ?? args ?? defaultArgs } : null;
  }
  return { command: String(command), args: args ?? defaultArgs };
}

async function runProviderCommand({ commandSpec, commandRunner, inputPath, timeoutMs, kind }) {
  const request = { inputPath, kind, timeoutMs, commandSpec };
  const raw = commandRunner
    ? await commandRunner(request)
    : await defaultProviderCommandRunner(request);
  return normalizeAdapterOutput(raw, { kind });
}

async function defaultProviderCommandRunner({ commandSpec, inputPath, timeoutMs }) {
  if (!commandSpec?.command) {
    const error = new Error('Provider command is not configured.');
    error.code = 'A_INPUT_PROVIDER_COMMAND_NOT_CONFIGURED';
    throw error;
  }
  const args = (commandSpec.args ?? ['{inputPath}']).map((arg) => String(arg).replaceAll('{inputPath}', inputPath));
  const { stdout } = await execFileAsync(commandSpec.command, args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

function normalizeAdapterOutput(raw, { kind }) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    return {
      text: raw.text ?? raw.transcript ?? raw.ocrText ?? raw.content ?? '',
      confidence: raw.confidence ?? null,
      adapter: {
        adapterVersion: raw.adapterVersion ?? 'a-command-input-adapter-output-v1',
        providerKind: kind,
        engine: raw.engine ?? 'injected-command-runner',
        latencyMs: raw.latencyMs ?? null
      }
    };
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return normalizeAdapterOutput(parsed, { kind });
  } catch {
    // Plain text command output is the normal adapter contract.
  }
  return {
    text,
    confidence: null,
    adapter: {
      adapterVersion: 'a-command-input-adapter-output-v1',
      providerKind: kind,
      engine: 'external-command-stdout',
      latencyMs: null
    }
  };
}

function documentFamilyForPath(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  return 'office';
}

function groupProviderQuality(results) {
  const groups = new Map();
  for (const item of results) {
    const key = item.actualProviderId ?? 'unknown';
    const group = groups.get(key) ?? {
      providerId: key,
      fixtureCount: 0,
      passedCount: 0,
      failedCount: 0,
      averageLatencyMs: 0,
      p95LatencyMs: null
    };
    group.fixtureCount += 1;
    if (item.status === 'passed') group.passedCount += 1;
    else group.failedCount += 1;
    group.averageLatencyMs += Number(item.latencyMs ?? 0);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const latencies = results
      .filter((item) => (item.actualProviderId ?? 'unknown') === group.providerId)
      .map((item) => item.latencyMs)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    return {
      ...group,
      accuracy: group.fixtureCount ? Number((group.passedCount / group.fixtureCount).toFixed(4)) : 0,
      averageLatencyMs: group.fixtureCount ? Number((group.averageLatencyMs / group.fixtureCount).toFixed(2)) : 0,
      p95LatencyMs: percentile(latencies, 0.95)
    };
  });
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

function localPathForAttachment(attachment) {
  return localPathFromValue(attachment?.path ?? attachment?.uri);
}

function localPathFromValue(value) {
  if (!value) return null;
  const text = String(value);
  if (text.startsWith('file://')) return resolve(fileURLToPath(text));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  return resolve(text);
}

function assertAllowedLocalPath(path, allowedRoots) {
  if (!path) {
    const error = new Error('Local path is required for provider extraction.');
    error.code = 'A_INPUT_PROVIDER_PATH_REQUIRED';
    throw error;
  }
  const normalized = resolve(path).toLowerCase();
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = resolve(root).toLowerCase();
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}\\`) || normalized.startsWith(`${normalizedRoot}/`);
  });
  if (!allowed) {
    const error = new Error(`Input provider path is outside allowed roots: ${path}`);
    error.code = 'A_INPUT_PROVIDER_PATH_OUTSIDE_ALLOWED_ROOTS';
    throw error;
  }
}

function redactSensitiveText(value) {
  let text = String(value ?? '');
  const findings = [];
  const rules = [
    { id: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[masked-email]' },
    { id: 'phone', pattern: /\b01[016789]-?\d{3,4}-?\d{4}\b/g, replacement: '[masked-phone]' },
    { id: 'resident-registration-number', pattern: /\b\d{6}-\d{7}\b/g, replacement: '[masked-rrn]' },
    { id: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/g, replacement: 'Bearer [masked]' },
    { id: 'secret-assignment', pattern: /\b(token|password|secret|api[_-]?key)\s*=\s*[^ \n\r\t;]+/gi, replacement: (_match, key) => `${key}=[masked]` }
  ];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      findings.push(rule.id);
      text = text.replace(rule.pattern, rule.replacement);
    }
  }
  return {
    text,
    redaction: {
      strategy: 'mask-sensitive-input-provider-preview',
      applied: findings.length > 0,
      findings: [...new Set(findings)],
      findingCount: new Set(findings).size
    }
  };
}

function previewText(value, maxChars) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}
