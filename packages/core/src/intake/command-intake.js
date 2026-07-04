import { createTaskRequest, InputSource, ModuleId } from '../../../shared/src/types.js';
import { buildCommandTextFromExtraction, CommandInputProviderRegistry } from './input-providers.js';

const sourceModuleByInputSource = new Map([
  [InputSource.CLI, ModuleId.CORE],
  [InputSource.PC_UI, ModuleId.CORE],
  [InputSource.MOBILE, ModuleId.MOBILE],
  [InputSource.VOICE, ModuleId.MOBILE],
  [InputSource.TRIGGER, ModuleId.CORE],
  [InputSource.API, ModuleId.BRIDGE]
]);

const allowedInputModes = new Set(['text', 'voice', 'file', 'image']);

export class CommandIntake {
  constructor({ clock = () => new Date(), defaultUserId = 'local_user', inputProviderRegistry = null } = {}) {
    this.clock = clock;
    this.defaultUserId = defaultUserId;
    this.inputProviderRegistry = inputProviderRegistry ?? new CommandInputProviderRegistry({ clock });
  }

  fromCli(rawText, options = {}) {
    return this.wrap(rawText, {
      ...options,
      source: InputSource.CLI,
      sourceModule: ModuleId.CORE,
      deviceId: options.deviceId ?? 'local_cli',
      inputMode: 'text'
    });
  }

  fromMobile(payload = {}, options = {}) {
    return this.wrap(payload.text ?? payload.rawText ?? payload.transcript ?? '', {
      ...options,
      source: InputSource.MOBILE,
      sourceModule: ModuleId.MOBILE,
      deviceId: payload.deviceId ?? options.deviceId ?? 'mobile_lcb_001',
      inputMode: payload.inputMode ?? options.inputMode ?? 'text',
      attachments: payload.attachments ?? options.attachments ?? [],
      metadata: {
        ...options.metadata,
        rawEvidence: this.rawEvidenceFor(payload, { channel: 'mobile' })
      }
    });
  }

  fromVoice({ transcript, audio = null, deviceId = 'voice_device', confidence = null, locale = 'ko-KR', metadata = {} } = {}) {
    return this.wrap(transcript, {
      source: InputSource.VOICE,
      sourceModule: ModuleId.MOBILE,
      deviceId,
      inputMode: 'voice',
      locale,
      attachments: audio ? [audio] : [],
      metadata: {
        ...metadata,
        rawEvidence: this.rawEvidenceFor({ transcript, audio, confidence }, { channel: 'voice' }),
        voice: { confidence, transcriptLength: String(transcript ?? '').length }
      }
    });
  }

  async fromVoiceWithProvider({
    transcript = '',
    audio = null,
    deviceId = 'voice_device',
    confidence = null,
    locale = 'ko-KR',
    metadata = {}
  } = {}, options = {}) {
    const extraction = await this.inputProviderRegistry.extract({
      inputMode: 'voice',
      attachment: audio,
      payload: { transcript, confidence },
      approvedContentAccess: options.approvedContentAccess ?? Boolean(transcript),
      allowedRoots: options.allowedRoots
    });
    const rawText = buildCommandTextFromExtraction({
      prompt: transcript,
      fallback: '음성 명령 처리',
      extraction
    });
    return this.wrap(rawText, {
      source: InputSource.VOICE,
      sourceModule: ModuleId.MOBILE,
      deviceId,
      inputMode: 'voice',
      locale,
      attachments: audio ? [{ ...audio, metadata: { ...(audio.metadata ?? {}), intakeExtraction: attachmentExtractionSummary(extraction) } }] : [],
      metadata: {
        ...metadata,
        rawEvidence: this.rawEvidenceFor({ transcript, audio, confidence }, {
          channel: 'voice',
          extraction
        }),
        inputProvider: extraction,
        voice: {
          confidence: extraction.confidence ?? confidence,
          transcriptLength: String(transcript || extraction.safePreview || '').length,
          transcriptSource: extraction.contentSource ?? 'metadata'
        }
      }
    });
  }

  fromFile({ prompt = '', file, deviceId = 'local_file_intake', metadata = {} } = {}) {
    return this.wrap(prompt || `파일 ${file?.name ?? file?.path ?? 'attachment'} 처리`, {
      source: InputSource.API,
      sourceModule: ModuleId.BRIDGE,
      deviceId,
      inputMode: 'file',
      attachments: file ? [file] : [],
      metadata: {
        ...metadata,
        rawEvidence: this.rawEvidenceFor({ prompt, file }, { channel: 'file' })
      }
    });
  }

  async fromFileWithProvider({ prompt = '', file, deviceId = 'local_file_intake', metadata = {} } = {}, options = {}) {
    const fallback = `파일 ${file?.name ?? file?.path ?? 'attachment'} 처리`;
    const extraction = await this.inputProviderRegistry.extract({
      inputMode: 'file',
      attachment: file,
      payload: { prompt },
      approvedContentAccess: options.approvedContentAccess === true,
      allowedRoots: options.allowedRoots
    });
    return this.wrap(buildCommandTextFromExtraction({ prompt, fallback, extraction }), {
      source: InputSource.API,
      sourceModule: ModuleId.BRIDGE,
      deviceId,
      inputMode: 'file',
      attachments: file ? [{ ...file, metadata: { ...(file.metadata ?? {}), intakeExtraction: attachmentExtractionSummary(extraction) } }] : [],
      metadata: {
        ...metadata,
        rawEvidence: this.rawEvidenceFor({ prompt, file }, {
          channel: 'file',
          extraction
        }),
        inputProvider: extraction
      }
    });
  }

  fromImage({ prompt = '', image, deviceId = 'local_image_intake', metadata = {} } = {}) {
    return this.wrap(prompt || `이미지 ${image?.name ?? image?.path ?? 'attachment'} 분석`, {
      source: InputSource.API,
      sourceModule: ModuleId.BRIDGE,
      deviceId,
      inputMode: 'image',
      attachments: image ? [image] : [],
      metadata: {
        ...metadata,
        rawEvidence: this.rawEvidenceFor({ prompt, image }, { channel: 'image' })
      }
    });
  }

  async fromImageWithProvider({ prompt = '', image, deviceId = 'local_image_intake', metadata = {} } = {}, options = {}) {
    const fallback = `이미지 ${image?.name ?? image?.path ?? 'attachment'} 분석`;
    const extraction = await this.inputProviderRegistry.extract({
      inputMode: 'image',
      attachment: image,
      payload: { prompt, ocrText: image?.ocrText ?? image?.metadata?.ocrText },
      approvedContentAccess: options.approvedContentAccess === true || Boolean(image?.ocrText ?? image?.metadata?.ocrText),
      allowedRoots: options.allowedRoots
    });
    return this.wrap(buildCommandTextFromExtraction({ prompt, fallback, extraction }), {
      source: InputSource.API,
      sourceModule: ModuleId.BRIDGE,
      deviceId,
      inputMode: 'image',
      attachments: image ? [{ ...image, metadata: { ...(image.metadata ?? {}), intakeExtraction: attachmentExtractionSummary(extraction) } }] : [],
      metadata: {
        ...metadata,
        rawEvidence: this.rawEvidenceFor({ prompt, image }, {
          channel: 'image',
          extraction
        }),
        inputProvider: extraction
      }
    });
  }

  wrap(rawText, options = {}) {
    const inputMode = allowedInputModes.has(options.inputMode) ? options.inputMode : 'text';
    const source = options.source ?? InputSource.API;
    const attachments = this.normalizeAttachments(options.attachments ?? [], { inputMode });
    return createTaskRequest({
      rawText: String(rawText ?? '').trim(),
      source,
      sourceModule: options.sourceModule ?? sourceModuleByInputSource.get(source) ?? ModuleId.CORE,
      deviceId: options.deviceId ?? 'local_device',
      inputMode,
      userId: options.userId ?? this.defaultUserId,
      locale: options.locale ?? 'ko-KR',
      attachments,
      metadata: {
        inputEvidence: {
          source,
          inputMode,
          attachmentCount: attachments.length,
          normalizedAt: options.createdAt ?? this.clock().toISOString()
        },
        ...(options.metadata ?? {})
      },
      createdAt: options.createdAt ?? this.clock().toISOString()
    });
  }

  normalizeAttachments(attachments, { inputMode = 'text' } = {}) {
    return attachments.map((attachment, index) => ({
      attachmentId: attachment.attachmentId ?? `att_${index + 1}`,
      kind: attachment.kind ?? inputMode,
      name: attachment.name ?? attachment.fileName ?? null,
      mimeType: attachment.mimeType ?? attachment.contentType ?? 'application/octet-stream',
      sizeBytes: Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : null,
      uri: attachment.uri ?? attachment.path ?? null,
      sha256: attachment.sha256 ?? null,
      capturedAt: attachment.capturedAt ?? this.clock().toISOString(),
      metadata: attachment.metadata ?? {}
    }));
  }

  rawEvidenceFor(payload, { channel, extraction = null }) {
    return {
      channel,
      receivedAt: this.clock().toISOString(),
      keys: Object.keys(payload ?? {}).sort(),
      contentPolicy: extraction?.contentPolicy ?? 'metadata-preserved-content-not-read',
      providerId: extraction?.providerId ?? null,
      rawContentStored: extraction?.rawContentStored === true ? true : false
    };
  }
}

function attachmentExtractionSummary(extraction) {
  if (!extraction) return null;
  return {
    extractionVersion: extraction.extractionVersion,
    providerId: extraction.providerId,
    status: extraction.status,
    contentRead: extraction.contentRead,
    rawContentStored: extraction.rawContentStored,
    contentHash: extraction.contentHash ?? null,
    redaction: extraction.redaction ?? null
  };
}
