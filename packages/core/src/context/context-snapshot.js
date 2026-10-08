import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { arch, platform, release } from 'node:os';
import { createContextSnapshot, maskSensitive, stableId } from '../../../shared/src/types.js';
import {projectMemoryContext} from './memory-context-projection.js';

const sensitiveNamePattern = /password|secret|token|credential|private|주민|비밀|암호|계좌|상담|개인/i;
const desktopContentScope = 'desktop.content';
const desktopAppTitleScope = 'desktop.app_titles';
const desktopScreenOcrScope = 'desktop.screen_ocr';
const desktopOsEventScope = 'desktop.os_events';

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function compactText(value, maxLength = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function redactSensitiveText(value) {
  if (value == null || value === '') {
    return { text: '', findings: [] };
  }
  let text = String(value);
  const findings = [];
  const replacements = [
    {
      name: 'email',
      regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      replacement: '[masked-email]'
    },
    {
      name: 'phone',
      regex: /\b(?:\+?82[-.\s]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}\b/g,
      replacement: '[masked-phone]'
    },
    {
      name: 'resident-registration-number',
      regex: /\b\d{6}-\d{7}\b/g,
      replacement: '[masked-rrn]'
    },
    {
      name: 'bearer-token',
      regex: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
      replacement: 'Bearer [masked]'
    },
    {
      name: 'credential-assignment',
      regex: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)\s*[:=]\s*["']?[^"'\s,;]+/gi,
      replacement: (_match, key) => `${key}=[masked]`
    }
  ];
  for (const rule of replacements) {
    text = text.replace(rule.regex, (...args) => {
      findings.push(rule.name);
      return typeof rule.replacement === 'function' ? rule.replacement(...args) : rule.replacement;
    });
  }
  if (sensitiveNamePattern.test(text) && text === String(value)) {
    findings.push('sensitive-keyword');
    text = '[masked-sensitive-text]';
  }
  return { text, findings };
}

function containsSensitiveDesktopText(value) {
  const text = String(value ?? '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
    || /\b(?:\+?82[-.\s]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}\b/.test(text)
    || /token=|secret=|password=|api[_-]?key=/i.test(text)
    || /[a-z]:\\[^\s]+/i.test(text);
}

function normalizeDesktopApproval(approval = {}) {
  const scopes = Array.isArray(approval?.scopes) ? approval.scopes : [];
  const approved = approval?.approved === true;
  const allowContent = approved && (approval.allowContent === true || scopes.includes(desktopContentScope));
  const allowAppTitles = approved && (allowContent || approval.allowAppTitles === true || scopes.includes(desktopAppTitleScope));
  const allowScreenOcr = approved && (allowContent || approval.allowScreenOcr === true || scopes.includes(desktopScreenOcrScope));
  const allowOsEventDetails = approved && (allowContent || approval.allowOsEventDetails === true || scopes.includes(desktopOsEventScope));
  return {
    approved,
    allowContent,
    allowAppTitles,
    allowScreenOcr,
    allowOsEventDetails,
    anyContentAllowed: allowAppTitles || allowScreenOcr || allowOsEventDetails,
    approvalId: approval?.approvalId ?? null,
    approvedBy: approval?.approvedBy ?? null,
    approvedAt: approval?.approvedAt ?? null,
    scopes
  };
}

function withoutDesktopApproval(environment = {}) {
  const { desktopContextApproval: _desktopContextApproval, ...provided } = environment ?? {};
  return provided;
}

function basenameLike(value) {
  if (value == null || value === '') return null;
  const item = String(value).split(/[\\/]/).filter(Boolean).pop() ?? String(value);
  return sensitiveNamePattern.test(item) ? '[sensitive-executable]' : item;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function durationSince(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length) : null;
}

function percentile(values, pct) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((pct / 100) * clean.length) - 1));
  return clean[index];
}

function isDesktopContextLatencyBudgetSample(sample) {
  return sample?.expectedFailure !== true
    && sample?.providerStatus === 'collected'
    && !(sample?.adapterStatuses ?? []).some((item) => item.status === 'provider-error')
    && Number.isFinite(sample?.latencyMs);
}

function readPowerShellJson(script, { timeoutMs = 1200 } = {}) {
  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return safeJsonParse(output.trim(), null);
}

function runCommandText(command, { timeoutMs = 1200 } = {}) {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  return execFileSync(shell, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function desktopPermissionScopeItems(gates) {
  return [
    {
      scope: desktopAppTitleScope,
      label: 'Active app and window titles',
      approved: gates.allowAppTitles,
      rawContentStored: false
    },
    {
      scope: desktopScreenOcrScope,
      label: 'Screen OCR preview',
      approved: gates.allowScreenOcr,
      rawContentStored: false
    },
    {
      scope: desktopOsEventScope,
      label: 'Recent OS event details',
      approved: gates.allowOsEventDetails,
      rawContentStored: false
    }
  ];
}

export function createDesktopContextPermissionUx({ providerConfigured = false, gates = normalizeDesktopApproval() } = {}) {
  const state = !providerConfigured
    ? 'provider-not-configured'
    : (gates.anyContentAllowed ? 'approved' : 'approval-required');
  return {
    uxVersion: 'a-desktop-context-permission-ux-v1',
    state,
    approvalId: gates.approvalId,
    approvedBy: gates.approvedBy,
    approvedAt: gates.approvedAt,
    requiredBeforeContentRead: providerConfigured && !gates.anyContentAllowed,
    requestedScopes: desktopPermissionScopeItems(gates),
    primaryAction: state === 'approval-required' ? 'request-desktop-context-approval' : 'none',
    denialFallback: 'metadata-only-context',
    rawContentStored: false
  };
}

function adapterTelemetry({
  providerVersion,
  adapterId,
  status,
  startedAtMs,
  permissionState = 'metadata-only',
  nativeProbe = false,
  errorCode = null,
  detail = {}
}) {
  return {
    telemetryVersion: 'a-desktop-context-adapter-telemetry-v1',
    providerVersion,
    adapterId,
    status,
    latencyMs: durationSince(startedAtMs),
    permissionState,
    nativeProbe,
    errorCode,
    rawContentStored: false,
    ...detail
  };
}

function sanitizeAdapterTelemetry(items = []) {
  return toArray(items)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      telemetryVersion: item.telemetryVersion ?? 'a-desktop-context-adapter-telemetry-v1',
      providerVersion: item.providerVersion ?? item.adapterVersion ?? null,
      adapterId: item.adapterId ?? item.providerId ?? null,
      status: item.status ?? 'unknown',
      latencyMs: Number.isFinite(item.latencyMs) ? item.latencyMs : null,
      permissionState: item.permissionState ?? null,
      nativeProbe: item.nativeProbe === true,
      errorCode: item.errorCode ?? null,
      rawContentStored: false
    }));
}

export class WindowsUiAutomationContextProvider {
  constructor({ enableNativeProbe = platform() === 'win32', maxOpenApps = 12, timeoutMs = 1200 } = {}) {
    this.providerVersion = 'a-windows-uiautomation-provider-v1';
    this.adapterId = 'windows-uiautomation-open-apps';
    this.enableNativeProbe = enableNativeProbe;
    this.maxOpenApps = maxOpenApps;
    this.timeoutMs = timeoutMs;
  }

  collect(request = {}) {
    const startedAtMs = Date.now();
    const permissionState = request.allowAppTitles ? 'approved-app-titles' : 'metadata-only';
    if (platform() !== 'win32') {
      return {
        openApps: [],
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'unsupported-platform',
          startedAtMs,
          permissionState,
          nativeProbe: false,
          detail: { platform: platform() }
        })
      };
    }
    if (!this.enableNativeProbe) {
      return {
        openApps: [],
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'native-probe-disabled',
          startedAtMs,
          permissionState,
          nativeProbe: false,
          detail: { platform: 'win32' }
        })
      };
    }

    try {
      const includeTitle = request.allowAppTitles === true ? '$true' : '$false';
      const script = [
        `$includeTitle = ${includeTitle}`,
        `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First ${this.maxOpenApps} Id,ProcessName,Path,@{Name='MainWindowTitle';Expression={ if ($includeTitle) { $_.MainWindowTitle } else { $null } }} | ConvertTo-Json -Compress`
      ].join('; ');
      const parsed = toArray(readPowerShellJson(script, { timeoutMs: this.timeoutMs }));
      return {
        openApps: parsed.map((item, index) => ({
          appId: `win_process_${item.Id ?? index + 1}`,
          executable: item.Path ?? item.ProcessName,
          pid: Number.isInteger(item.Id) ? item.Id : null,
          active: index === 0,
          title: request.allowAppTitles ? item.MainWindowTitle : null
        })),
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'collected',
          startedAtMs,
          permissionState,
          nativeProbe: true,
          detail: { itemCount: parsed.length }
        })
      };
    } catch (error) {
      return {
        openApps: [],
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'provider-error',
          startedAtMs,
          permissionState,
          nativeProbe: true,
          errorCode: 'A_WINDOWS_UIA_PROVIDER_FAILED',
          detail: { message: compactText(error.message, 120) }
        })
      };
    }
  }
}

export class WindowsOcrContextProvider {
  constructor({
    enableNativeProbe = platform() === 'win32',
    ocrCommand = process.env.JARVIS_DESKTOP_OCR_COMMAND,
    timeoutMs = 1200
  } = {}) {
    this.providerVersion = 'a-windows-ocr-provider-v1';
    this.adapterId = 'windows-screen-ocr';
    this.enableNativeProbe = enableNativeProbe;
    this.ocrCommand = ocrCommand;
    this.timeoutMs = timeoutMs;
  }

  collect(request = {}) {
    const startedAtMs = Date.now();
    const permissionState = request.allowScreenOcr ? 'approved-screen-ocr' : 'metadata-only';
    if (platform() !== 'win32') {
      return {
        screen: null,
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'unsupported-platform',
          startedAtMs,
          permissionState,
          nativeProbe: false,
          detail: { platform: platform() }
        })
      };
    }
    if (!this.enableNativeProbe) {
      return {
        screen: {
          displayCount: null,
          dimensions: null,
          activeApp: null,
          activeWindowTitle: null,
          ocrText: null,
          screenshotHash: null
        },
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'native-probe-disabled',
          startedAtMs,
          permissionState,
          nativeProbe: false,
          detail: { ocrCommandConfigured: Boolean(this.ocrCommand) }
        })
      };
    }

    try {
      const screenScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ Width = $_.Bounds.Width; Height = $_.Bounds.Height; Primary = $_.Primary } } | ConvertTo-Json -Compress'
      ].join('; ');
      const screens = toArray(readPowerShellJson(screenScript, { timeoutMs: this.timeoutMs }));
      const primary = screens.find((item) => item.Primary === true) ?? screens[0] ?? null;
      const ocrText = request.allowScreenOcr && this.ocrCommand
        ? runCommandText(this.ocrCommand, { timeoutMs: this.timeoutMs })
        : null;
      const status = request.allowScreenOcr && !this.ocrCommand ? 'ocr-command-not-configured' : 'collected';
      return {
        screen: {
          displayCount: screens.length || null,
          dimensions: primary ? { width: Number(primary.Width), height: Number(primary.Height) } : null,
          activeApp: null,
          activeWindowTitle: null,
          ocrText,
          screenshotHash: null
        },
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status,
          startedAtMs,
          permissionState,
          nativeProbe: true,
          detail: { displayCount: screens.length, ocrCommandConfigured: Boolean(this.ocrCommand) }
        })
      };
    } catch (error) {
      return {
        screen: null,
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'provider-error',
          startedAtMs,
          permissionState,
          nativeProbe: true,
          errorCode: 'A_WINDOWS_OCR_PROVIDER_FAILED',
          detail: { message: compactText(error.message, 120) }
        })
      };
    }
  }
}

export class WindowsOsEventContextProvider {
  constructor({
    enableNativeProbe = platform() === 'win32',
    eventCommand = process.env.JARVIS_DESKTOP_OS_EVENTS_COMMAND,
    maxEvents = 8,
    timeoutMs = 1200
  } = {}) {
    this.providerVersion = 'a-windows-os-event-provider-v1';
    this.adapterId = 'windows-os-event-source';
    this.enableNativeProbe = enableNativeProbe;
    this.eventCommand = eventCommand;
    this.maxEvents = maxEvents;
    this.timeoutMs = timeoutMs;
  }

  collect(request = {}) {
    const startedAtMs = Date.now();
    const permissionState = request.allowOsEventDetails ? 'approved-os-events' : 'metadata-only';
    if (platform() !== 'win32') {
      return {
        osEvents: [],
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'unsupported-platform',
          startedAtMs,
          permissionState,
          nativeProbe: false,
          detail: { platform: platform() }
        })
      };
    }
    if (!this.enableNativeProbe || !request.allowOsEventDetails) {
      return {
        osEvents: [],
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: this.enableNativeProbe ? 'approval-required' : 'native-probe-disabled',
          startedAtMs,
          permissionState,
          nativeProbe: false
        })
      };
    }

    try {
      const parsed = this.eventCommand
        ? toArray(safeJsonParse(runCommandText(this.eventCommand, { timeoutMs: this.timeoutMs }), []))
        : toArray(readPowerShellJson([
            `Get-WinEvent -LogName Application -MaxEvents ${this.maxEvents}`,
            'Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message',
            'ConvertTo-Json -Compress'
          ].join(' | '), { timeoutMs: this.timeoutMs }));
      return {
        osEvents: parsed.slice(0, this.maxEvents).map((item, index) => ({
          eventId: `win_event_${item.Id ?? index + 1}`,
          type: item.LevelDisplayName ?? 'windows-event',
          source: item.ProviderName ?? item.Source ?? 'windows',
          timestamp: item.TimeCreated ?? null,
          detail: item.Message ?? item.detail ?? null
        })),
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'collected',
          startedAtMs,
          permissionState,
          nativeProbe: true,
          detail: { itemCount: parsed.length }
        })
      };
    } catch (error) {
      return {
        osEvents: [],
        telemetry: adapterTelemetry({
          providerVersion: this.providerVersion,
          adapterId: this.adapterId,
          status: 'provider-error',
          startedAtMs,
          permissionState,
          nativeProbe: true,
          errorCode: 'A_WINDOWS_OS_EVENT_PROVIDER_FAILED',
          detail: { message: compactText(error.message, 120) }
        })
      };
    }
  }
}

export class WindowsDesktopContextProvider {
  constructor(options = {}) {
    this.providerId = 'a-windows-desktop-context-provider-pack-v1';
    this.providerVersion = 'a-windows-desktop-context-provider-pack-v1';
    this.uiAutomationProvider = options.uiAutomationProvider ?? new WindowsUiAutomationContextProvider(options);
    this.ocrProvider = options.ocrProvider ?? new WindowsOcrContextProvider(options);
    this.osEventProvider = options.osEventProvider ?? new WindowsOsEventContextProvider(options);
    this.sharedNativeProbeTtlMs = Number(options.sharedNativeProbeTtlMs ?? 2000);
    this.sharedNativeProbeCache = new Map();
    this.providerVersions = [
      this.uiAutomationProvider.providerVersion,
      this.ocrProvider.providerVersion,
      this.osEventProvider.providerVersion
    ];
    this.providerContract = {
      contractVersion: 'a-windows-desktop-context-provider-pack-v1',
      platform: 'win32',
      permissionModel: 'approval-gated-desktop-context',
      rawContentStored: false,
      adapters: [
        {
          providerVersion: this.uiAutomationProvider.providerVersion,
          purpose: 'UIAutomation open app/window metadata',
          requiredScopes: [desktopAppTitleScope]
        },
        {
          providerVersion: this.ocrProvider.providerVersion,
          purpose: 'screen OCR preview through configured Windows OCR command adapter',
          requiredScopes: [desktopScreenOcrScope]
        },
        {
          providerVersion: this.osEventProvider.providerVersion,
          purpose: 'Windows event source adapter',
          requiredScopes: [desktopOsEventScope]
        }
      ]
    };
  }

  collectDesktopContext(request = {}) {
    if (this.canUseSharedNativeProbe()) {
      return this.collectDesktopContextWithSharedProbe(request);
    }
    const openApps = this.uiAutomationProvider.collect(request);
    const screen = this.ocrProvider.collect(request);
    const osEvents = this.osEventProvider.collect(request);
    return {
      providerId: this.providerId,
      providerVersion: this.providerVersion,
      providerVersions: this.providerVersions,
      providerContract: this.providerContract,
      adapterTelemetry: [openApps.telemetry, screen.telemetry, osEvents.telemetry],
      openApps: openApps.openApps,
      screen: screen.screen,
      osEvents: osEvents.osEvents
    };
  }

  canUseSharedNativeProbe() {
    return platform() === 'win32'
      && this.uiAutomationProvider.enableNativeProbe === true
      && this.ocrProvider.enableNativeProbe === true
      && this.osEventProvider.enableNativeProbe === true
      && !this.ocrProvider.ocrCommand
      && !this.osEventProvider.eventCommand;
  }

  collectDesktopContextWithSharedProbe(request = {}) {
    const startedAtMs = Date.now();
    const includeTitle = request.allowAppTitles === true ? '$true' : '$false';
    const includeEvents = request.allowOsEventDetails === true ? '$true' : '$false';
    const maxOpenApps = Math.max(1, Number(this.uiAutomationProvider.maxOpenApps ?? 12));
    const maxEvents = Math.max(1, Number(this.osEventProvider.maxEvents ?? 8));
    const cacheKey = this.sharedNativeProbeCacheKey({ includeTitle, includeEvents, maxOpenApps, maxEvents });
    const cached = this.readSharedNativeProbeCache(cacheKey);
    if (cached) {
      return this.mapSharedNativeProbePayload(cached, request, startedAtMs, { cacheHit: true });
    }
    const timeoutMs = Math.min(
      1600,
      Math.max(
        Number(this.uiAutomationProvider.timeoutMs ?? 1200),
        Number(this.ocrProvider.timeoutMs ?? 1200),
        Number(this.osEventProvider.timeoutMs ?? 1200)
      )
    );
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$includeTitle = ${includeTitle}`,
      `$includeEvents = ${includeEvents}`,
      `$maxOpenApps = ${maxOpenApps}`,
      `$maxEvents = ${maxEvents}`,
      '$openApps = try { @{ Status = "collected"; Items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First $maxOpenApps Id,ProcessName,Path,@{Name="MainWindowTitle";Expression={ if ($includeTitle) { $_.MainWindowTitle } else { $null } }}) } } catch { @{ Status = "provider-error"; Error = $_.Exception.Message; Items = @() } }',
      '$screens = try { Add-Type -AssemblyName System.Windows.Forms; @{ Status = "collected"; Items = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ Width = $_.Bounds.Width; Height = $_.Bounds.Height; Primary = $_.Primary } }) } } catch { @{ Status = "provider-error"; Error = $_.Exception.Message; Items = @() } }',
      '$events = if ($includeEvents) { @{ Status = "collected"; Items = @(); DetailMode = "external-command-required" } } else { @{ Status = "approval-required"; Items = @() } }',
      '@{ OpenApps = $openApps; Screens = $screens; Events = $events } | ConvertTo-Json -Compress -Depth 6'
    ].join('; ');

    try {
      const payload = readPowerShellJson(script, { timeoutMs });
      this.writeSharedNativeProbeCache(cacheKey, payload);
      return this.mapSharedNativeProbePayload(payload, request, startedAtMs, { cacheHit: false });
    } catch (error) {
      const detail = { message: compactText(error.message, 120), sharedProbe: true };
      return {
        providerId: this.providerId,
        providerVersion: this.providerVersion,
        providerVersions: this.providerVersions,
        providerContract: this.providerContract,
        adapterTelemetry: [
          adapterTelemetry({
            providerVersion: this.uiAutomationProvider.providerVersion,
            adapterId: this.uiAutomationProvider.adapterId,
            status: 'provider-error',
            startedAtMs,
            permissionState: request.allowAppTitles ? 'approved-app-titles' : 'metadata-only',
            nativeProbe: true,
            errorCode: 'A_WINDOWS_SHARED_DESKTOP_PROVIDER_FAILED',
            detail
          }),
          adapterTelemetry({
            providerVersion: this.ocrProvider.providerVersion,
            adapterId: this.ocrProvider.adapterId,
            status: 'provider-error',
            startedAtMs,
            permissionState: request.allowScreenOcr ? 'approved-screen-ocr' : 'metadata-only',
            nativeProbe: true,
            errorCode: 'A_WINDOWS_SHARED_DESKTOP_PROVIDER_FAILED',
            detail
          }),
          adapterTelemetry({
            providerVersion: this.osEventProvider.providerVersion,
            adapterId: this.osEventProvider.adapterId,
            status: request.allowOsEventDetails ? 'provider-error' : 'approval-required',
            startedAtMs,
            permissionState: request.allowOsEventDetails ? 'approved-os-events' : 'metadata-only',
            nativeProbe: request.allowOsEventDetails === true,
            errorCode: request.allowOsEventDetails ? 'A_WINDOWS_SHARED_DESKTOP_PROVIDER_FAILED' : null,
            detail
          })
        ],
        openApps: [],
        screen: null,
        osEvents: []
      };
    }
  }

  sharedNativeProbeCacheKey({ includeTitle, includeEvents, maxOpenApps, maxEvents }) {
    return [includeTitle, includeEvents, maxOpenApps, maxEvents].join('|');
  }

  readSharedNativeProbeCache(cacheKey) {
    const cached = this.sharedNativeProbeCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.storedAtMs > this.sharedNativeProbeTtlMs) {
      this.sharedNativeProbeCache.delete(cacheKey);
      return null;
    }
    return cached.payload;
  }

  writeSharedNativeProbeCache(cacheKey, payload) {
    if (payload == null || this.sharedNativeProbeTtlMs <= 0) return;
    this.sharedNativeProbeCache.set(cacheKey, { storedAtMs: Date.now(), payload });
  }

  mapSharedNativeProbePayload(payload, request, startedAtMs, probeMeta = {}) {
    const openAppsPayload = payload?.OpenApps ?? {};
    const screensPayload = payload?.Screens ?? {};
    const eventsPayload = payload?.Events ?? {};
    const openAppsItems = toArray(openAppsPayload.Items);
    const screenItems = toArray(screensPayload.Items);
    const eventItems = toArray(eventsPayload.Items);
    const primary = screenItems.find((item) => item.Primary === true) ?? screenItems[0] ?? null;
    const openAppsStatus = openAppsPayload.Status ?? 'provider-error';
    const screenProbeStatus = screensPayload.Status ?? 'provider-error';
    const screenStatus = screenProbeStatus === 'collected' && request.allowScreenOcr && !this.ocrProvider.ocrCommand
      ? 'ocr-command-not-configured'
      : screenProbeStatus;
    const eventStatus = request.allowOsEventDetails
      ? (eventsPayload.Status ?? 'provider-error')
      : 'approval-required';
    return {
      providerId: this.providerId,
      providerVersion: this.providerVersion,
      providerVersions: this.providerVersions,
      providerContract: this.providerContract,
      adapterTelemetry: [
        adapterTelemetry({
          providerVersion: this.uiAutomationProvider.providerVersion,
          adapterId: this.uiAutomationProvider.adapterId,
          status: openAppsStatus,
          startedAtMs,
          permissionState: request.allowAppTitles ? 'approved-app-titles' : 'metadata-only',
          nativeProbe: true,
          errorCode: openAppsStatus === 'provider-error' ? 'A_WINDOWS_UIA_PROVIDER_FAILED' : null,
          detail: { itemCount: openAppsItems.length, sharedProbe: true, cacheHit: probeMeta.cacheHit === true }
        }),
        adapterTelemetry({
          providerVersion: this.ocrProvider.providerVersion,
          adapterId: this.ocrProvider.adapterId,
          status: screenStatus,
          startedAtMs,
          permissionState: request.allowScreenOcr ? 'approved-screen-ocr' : 'metadata-only',
          nativeProbe: true,
          errorCode: screenProbeStatus === 'provider-error' ? 'A_WINDOWS_OCR_PROVIDER_FAILED' : null,
          detail: {
            displayCount: screenItems.length,
            ocrCommandConfigured: Boolean(this.ocrProvider.ocrCommand),
            sharedProbe: true,
            cacheHit: probeMeta.cacheHit === true
          }
        }),
        adapterTelemetry({
          providerVersion: this.osEventProvider.providerVersion,
          adapterId: this.osEventProvider.adapterId,
          status: eventStatus,
          startedAtMs,
          permissionState: request.allowOsEventDetails ? 'approved-os-events' : 'metadata-only',
          nativeProbe: request.allowOsEventDetails === true,
          errorCode: eventStatus === 'provider-error' ? 'A_WINDOWS_OS_EVENT_PROVIDER_FAILED' : null,
          detail: {
            itemCount: eventItems.length,
            sharedProbe: true,
            cacheHit: probeMeta.cacheHit === true,
            detailMode: eventsPayload.DetailMode ?? null
          }
        })
      ],
      openApps: openAppsItems.map((item, index) => ({
        appId: `win_process_${item.Id ?? index + 1}`,
        executable: item.Path ?? item.ProcessName,
        pid: Number.isInteger(item.Id) ? item.Id : null,
        active: index === 0,
        title: request.allowAppTitles ? item.MainWindowTitle : null
      })),
      screen: {
        displayCount: screenItems.length || null,
        dimensions: primary ? { width: Number(primary.Width), height: Number(primary.Height) } : null,
        activeApp: null,
        activeWindowTitle: null,
        ocrText: null,
        screenshotHash: null
      },
      osEvents: eventItems.slice(0, this.osEventProvider.maxEvents).map((item, index) => ({
        eventId: `win_event_${item.Id ?? index + 1}`,
        type: item.LevelDisplayName ?? 'windows-event',
        source: item.ProviderName ?? item.Source ?? 'windows',
        timestamp: item.TimeCreated ?? null,
        detail: item.Message ?? item.detail ?? null
      }))
    };
  }
}

export function createWindowsDesktopContextProviderPack(options = {}) {
  return new WindowsDesktopContextProvider(options);
}

export class DesktopContextCollector {
  constructor({ provider = null, clock = () => new Date(), maxOpenApps = 12, maxOsEvents = 16 } = {}) {
    this.provider = provider;
    this.clock = clock;
    this.maxOpenApps = maxOpenApps;
    this.maxOsEvents = maxOsEvents;
    this.telemetryEvents = [];
    this.soakReports = [];
  }

  collect({ taskRequest, approval = {} } = {}) {
    const startedAtMs = Date.now();
    const gates = normalizeDesktopApproval(approval);
    const base = {
      available: Boolean(this.provider),
      providerId: this.provider?.providerId ?? this.provider?.name ?? null,
      providerVersion: this.provider?.providerVersion ?? null,
      providerVersions: this.provider?.providerVersions ?? [],
      providerContract: this.provider?.providerContract ?? null,
      collectedAt: this.clock().toISOString(),
      collectionMode: this.provider ? (gates.anyContentAllowed ? 'approved-redacted-content' : 'metadata-only') : 'disabled',
      contentRead: Boolean(this.provider && gates.anyContentAllowed),
      rawContentStored: false,
      approval: {
        required: Boolean(this.provider),
        approved: gates.anyContentAllowed,
        allowContent: gates.allowContent,
        allowAppTitles: gates.allowAppTitles,
        allowScreenOcr: gates.allowScreenOcr,
        allowOsEventDetails: gates.allowOsEventDetails,
        approvalId: gates.approvalId,
        approvedBy: gates.approvedBy,
        approvedAt: gates.approvedAt,
        scopes: gates.scopes,
        reason: this.provider
          ? (gates.anyContentAllowed ? 'desktop-context-approved' : 'desktop-context-approval-required')
          : 'desktop-context-provider-not-configured'
      },
      providerRequest: {
        allowContent: gates.anyContentAllowed,
        allowAppTitles: gates.allowAppTitles,
        allowScreenOcr: gates.allowScreenOcr,
        allowOsEventDetails: gates.allowOsEventDetails
      },
      permissionUx: createDesktopContextPermissionUx({ providerConfigured: Boolean(this.provider), gates }),
      openApps: [],
      screen: {
        available: false,
        contentRead: false
      },
      osEvents: [],
      redaction: {
        strategy: 'approval-gated-desktop-context',
        titleFieldsRedacted: 0,
        textFieldsRedacted: 0,
        sensitiveFindings: [],
        sensitiveFindingCount: 0
      }
    };

    if (!this.provider) {
      return this.finalizeCollection(base, startedAtMs, gates, 'provider-not-configured');
    }

    let raw;
    try {
      raw = this.readProvider({
        taskRequest,
        allowContent: gates.anyContentAllowed,
        allowAppTitles: gates.allowAppTitles,
        allowScreenOcr: gates.allowScreenOcr,
        allowOsEventDetails: gates.allowOsEventDetails,
        approval: base.approval,
        mode: base.collectionMode,
        createdAt: this.clock().toISOString()
      });
    } catch (error) {
      return this.finalizeCollection({
        ...base,
        available: false,
        collectionMode: 'provider-error',
        contentRead: false,
        error: {
          code: 'A_DESKTOP_CONTEXT_PROVIDER_FAILED',
          message: error.message
        }
      }, startedAtMs, gates, 'provider-error');
    }

    if (!raw || typeof raw !== 'object' || typeof raw.then === 'function') {
      return this.finalizeCollection({
        ...base,
        available: false,
        collectionMode: typeof raw?.then === 'function' ? 'provider-async-unsupported' : 'provider-empty',
        contentRead: false
      }, startedAtMs, gates, typeof raw?.then === 'function' ? 'provider-async-unsupported' : 'provider-empty');
    }

    const redaction = {
      strategy: 'approval-gated-desktop-context',
      titleFieldsRedacted: 0,
      textFieldsRedacted: 0,
      sensitiveFindings: []
    };
    const providerId = raw.providerId ?? base.providerId;
    const providerVersion = raw.providerVersion ?? base.providerVersion;
    const providerVersions = raw.providerVersions ?? base.providerVersions ?? [];
    const providerContract = raw.providerContract ?? base.providerContract ?? null;
    const adapterTelemetry = sanitizeAdapterTelemetry(raw.adapterTelemetry ?? raw.adapters ?? []);
    const openApps = this.sanitizeOpenApps(raw.openApps ?? raw.apps ?? [], gates, redaction);
    const screen = this.sanitizeScreen(raw.screen ?? raw.activeScreen ?? null, gates, redaction);
    const osEvents = this.sanitizeOsEvents(raw.osEvents ?? raw.events ?? [], gates, redaction);
    const uniqueFindings = [...new Set(redaction.sensitiveFindings)];

    return this.finalizeCollection({
      ...base,
      providerId,
      providerVersion,
      providerVersions,
      providerContract,
      adapterTelemetry,
      permissionUx: raw.permissionUx ?? base.permissionUx,
      openApps,
      screen,
      osEvents,
      redaction: {
        ...redaction,
        sensitiveFindings: uniqueFindings,
        sensitiveFindingCount: uniqueFindings.length
      }
    }, startedAtMs, gates, 'collected');
  }

  finalizeCollection(result, startedAtMs, gates, providerStatus) {
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    const telemetry = {
      telemetryVersion: 'a-desktop-context-telemetry-v1',
      providerId: result.providerId ?? null,
      providerVersion: result.providerVersion ?? null,
      providerContractVersion: result.providerContract?.contractVersion ?? null,
      providerStatus,
      latencyMs,
      collectionMode: result.collectionMode,
      contentRead: result.contentRead,
      rawContentStored: result.rawContentStored === true ? true : false,
      approvalRequired: result.approval?.required === true,
      approved: result.approval?.approved === true,
      requestedScopes: {
        allowContent: gates.allowContent,
        allowAppTitles: gates.allowAppTitles,
        allowScreenOcr: gates.allowScreenOcr,
        allowOsEventDetails: gates.allowOsEventDetails
      },
      redactionCounts: {
        titleFieldsRedacted: result.redaction?.titleFieldsRedacted ?? 0,
        textFieldsRedacted: result.redaction?.textFieldsRedacted ?? 0,
        sensitiveFindingCount: result.redaction?.sensitiveFindingCount ?? 0
      },
      permissionUxState: result.permissionUx?.state ?? null,
      adapterTelemetry: sanitizeAdapterTelemetry(result.adapterTelemetry)
    };
    this.telemetryEvents.unshift({
      ...telemetry,
      at: this.clock().toISOString()
    });
    return {
      ...result,
      telemetry
    };
  }

  telemetryReport({ limit = 20 } = {}) {
    const events = this.telemetryEvents.slice(0, limit);
    const latencies = events.map((event) => event.latencyMs).filter((value) => Number.isFinite(value));
    return {
      reportVersion: 'a-desktop-context-telemetry-report-v1',
      generatedAt: this.clock().toISOString(),
      providerId: this.provider?.providerId ?? this.provider?.name ?? null,
      totalCollections: this.telemetryEvents.length,
      returnedCollections: events.length,
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      p95LatencyMs: percentile(latencies, 95),
      providerStatusCounts: countBy(events.map((event) => event.providerStatus)),
      adapterStatusCounts: countBy(events.flatMap((event) => (event.adapterTelemetry ?? []).map((item) => item.status))),
      adapterVersionCounts: countBy(events.flatMap((event) => (event.adapterTelemetry ?? []).map((item) => item.providerVersion))),
      permissionUxStates: countBy(events.map((event) => event.permissionUxState)),
      collectionModes: countBy(events.map((event) => event.collectionMode)),
      rawContentStored: events.some((event) => event.rawContentStored === true),
      latest: events[0] ?? null,
      events
    };
  }

  providerContractStatus() {
    return {
      statusVersion: 'a-desktop-context-provider-contract-status-v1',
      generatedAt: this.clock().toISOString(),
      providerConfigured: Boolean(this.provider),
      providerId: this.provider?.providerId ?? this.provider?.name ?? null,
      providerVersion: this.provider?.providerVersion ?? null,
      providerVersions: this.provider?.providerVersions ?? [],
      providerContract: this.provider?.providerContract ?? null,
      permissionUxVersion: 'a-desktop-context-permission-ux-v1',
      telemetryVersion: 'a-desktop-context-telemetry-v1',
      rawContentStored: false
    };
  }

  runProviderSoak({
    cycles = 6,
    includeFailureProbe = true,
    commandText = 'desktop context provider soak',
    approvals = null
  } = {}) {
    const taskRequest = {
      taskId: stableId('task', commandText, this.clock().toISOString()),
      source: { type: 'api', module: 'A_CORE', inputMode: 'text' },
      command: { rawText: commandText, locale: 'ko-KR' },
      metadata: {}
    };
    const approvalPlan = approvals ?? [
      {},
      {
        approved: true,
        allowContent: true,
        approvalId: 'desktop_context_soak_approval',
        approvedBy: 'provider_soak',
        approvedAt: this.clock().toISOString(),
        scopes: [desktopContentScope]
      }
    ];
    const samples = [];
    for (let index = 0; index < cycles; index += 1) {
      const sample = this.collect({
        taskRequest,
        approval: approvalPlan[index % approvalPlan.length]
      });
      samples.push({
        sampleId: `desktop_context_soak_${index + 1}`,
        providerStatus: sample.telemetry.providerStatus,
        collectionMode: sample.collectionMode,
        permissionUxState: sample.permissionUx?.state ?? null,
        latencyMs: sample.telemetry.latencyMs,
        adapterStatuses: sample.telemetry.adapterTelemetry.map((item) => ({
          providerVersion: item.providerVersion,
          status: item.status,
          latencyMs: item.latencyMs,
          nativeProbe: item.nativeProbe
        })),
        rawContentStored: sample.rawContentStored
      });
    }

    let expectedFailure = null;
    if (includeFailureProbe) {
      const failureCollector = new DesktopContextCollector({
        clock: this.clock,
        provider: {
          providerId: 'a-desktop-context-failure-probe-v1',
          collectDesktopContext() {
            throw new Error('injected desktop context provider failure');
          }
        }
      });
      const failureSample = failureCollector.collect({ taskRequest, approval: approvalPlan[1] ?? {} });
      expectedFailure = {
        providerStatus: failureSample.telemetry.providerStatus,
        collectionMode: failureSample.collectionMode,
        errorCode: failureSample.error?.code ?? null,
        rawContentStored: failureSample.rawContentStored
      };
      samples.push({
        sampleId: 'desktop_context_expected_failure',
        providerStatus: failureSample.telemetry.providerStatus,
        collectionMode: failureSample.collectionMode,
        permissionUxState: failureSample.permissionUx?.state ?? null,
        latencyMs: failureSample.telemetry.latencyMs,
        adapterStatuses: [],
        rawContentStored: failureSample.rawContentStored,
        expectedFailure: true
      });
    }

    const latencies = samples.map((sample) => sample.latencyMs).filter((value) => Number.isFinite(value));
    const latencyBudgetSamples = samples.filter((sample) => isDesktopContextLatencyBudgetSample(sample));
    const latencyBudgetValues = latencyBudgetSamples.map((sample) => sample.latencyMs).filter((value) => Number.isFinite(value));
    const baseReport = {
      reportVersion: 'a-desktop-context-provider-soak-v1',
      generatedAt: this.clock().toISOString(),
      status: samples.every((sample) => sample.rawContentStored === false) && (!includeFailureProbe || expectedFailure?.providerStatus === 'provider-error') ? 'passed' : 'failed',
      providerContract: this.providerContractStatus(),
      cyclesRequested: cycles,
      sampleCount: samples.length,
      providerStatusCounts: countBy(samples.map((sample) => sample.providerStatus)),
      adapterStatusCounts: countBy(samples.flatMap((sample) => sample.adapterStatuses.map((item) => item.status))),
      permissionUxStates: countBy(samples.map((sample) => sample.permissionUxState)),
      latency: {
        averageMs: average(latencies),
        p95Ms: percentile(latencies, 95),
        maxMs: latencies.length ? Math.max(...latencies) : null,
        budgetAverageMs: average(latencyBudgetValues),
        budgetP95Ms: percentile(latencyBudgetValues, 95),
        budgetSampleCount: latencyBudgetSamples.length,
        outlierSampleCount: samples.length - latencyBudgetSamples.length,
        budgetPolicy: 'successful-provider-samples-without-expected-failure-or-adapter-provider-error'
      },
      failureTelemetry: {
        failureCount: samples.filter((sample) => sample.providerStatus === 'provider-error').length,
        expectedFailureCaptured: expectedFailure?.providerStatus === 'provider-error',
        expectedFailure
      },
      rawContentStored: samples.some((sample) => sample.rawContentStored === true),
      samples
    };
    const releaseDossier = createDesktopContextProviderReleaseDossier({ report: baseReport });
    const productGate = createDesktopContextProviderProductGate({ report: baseReport, releaseDossier });
    const report = {
      ...baseReport,
      releaseDossier,
      productGate
    };
    this.soakReports.unshift(report);
    return report;
  }

  readProvider(request) {
    if (typeof this.provider === 'function') {
      return this.provider(request);
    }
    if (typeof this.provider.collectDesktopContext === 'function') {
      return this.provider.collectDesktopContext(request);
    }
    if (typeof this.provider.collect === 'function') {
      return this.provider.collect(request);
    }
    if (typeof this.provider.snapshot === 'function') {
      return this.provider.snapshot(request);
    }
    return this.provider;
  }

  sanitizeOpenApps(openApps, gates, redaction) {
    return (Array.isArray(openApps) ? openApps : [])
      .slice(0, this.maxOpenApps)
      .map((app, index) => {
        const title = pickString(app.title, app.windowTitle, app.name);
        const sanitized = {
          appId: pickString(app.appId, app.id, app.bundleId) ?? `desktop_app_${index + 1}`,
          executable: basenameLike(app.executable ?? app.processName ?? app.path),
          pid: Number.isInteger(app.pid) ? app.pid : null,
          active: Boolean(app.active),
          title: title ? '[redacted-title]' : null,
          titleHash: title ? sha256(title) : null
        };
        if (title && gates.allowAppTitles) {
          const result = redactSensitiveText(title);
          sanitized.title = compactText(result.text, 120);
          redaction.sensitiveFindings.push(...result.findings);
          if (result.findings.length > 0) {
            redaction.textFieldsRedacted += 1;
          }
        } else if (title) {
          redaction.titleFieldsRedacted += 1;
        }
        return sanitized;
      });
  }

  sanitizeScreen(screen, gates, redaction) {
    if (!screen || typeof screen !== 'object') {
      return { available: false, contentRead: false };
    }
    const title = pickString(screen.activeWindowTitle, screen.windowTitle, screen.title);
    const ocrText = pickString(screen.ocrText, screen.ocrPreview, screen.text);
    const result = {
      available: true,
      contentRead: gates.allowScreenOcr,
      displayCount: Number.isInteger(screen.displayCount) ? screen.displayCount : null,
      dimensions: screen.dimensions ?? null,
      screenshotHash: screen.screenshotHash ?? null,
      activeApp: basenameLike(screen.activeApp ?? screen.appName ?? screen.processName),
      activeWindowTitle: title ? '[redacted-title]' : null,
      activeWindowTitleHash: title ? sha256(title) : null,
      ocrPreview: ocrText ? '[not-collected]' : null,
      ocrTextHash: ocrText && gates.allowScreenOcr ? sha256(ocrText) : null,
      redacted: true
    };
    if (title && gates.allowAppTitles) {
      const titleResult = redactSensitiveText(title);
      result.activeWindowTitle = compactText(titleResult.text, 120);
      redaction.sensitiveFindings.push(...titleResult.findings);
      if (titleResult.findings.length > 0) {
        redaction.textFieldsRedacted += 1;
      }
    } else if (title) {
      redaction.titleFieldsRedacted += 1;
    }
    if (ocrText && gates.allowScreenOcr) {
      const textResult = redactSensitiveText(ocrText);
      result.ocrPreview = compactText(textResult.text, 240);
      redaction.sensitiveFindings.push(...textResult.findings);
      if (textResult.findings.length > 0) {
        redaction.textFieldsRedacted += 1;
      }
    }
    return result;
  }

  sanitizeOsEvents(osEvents, gates, redaction) {
    return (Array.isArray(osEvents) ? osEvents : [])
      .slice(0, this.maxOsEvents)
      .map((event, index) => {
        const detail = pickString(event.detail, event.text, event.message, event.title);
        const item = {
          eventId: pickString(event.eventId, event.id) ?? `desktop_event_${index + 1}`,
          type: pickString(event.type, event.kind) ?? 'unknown',
          source: basenameLike(event.source ?? event.processName ?? event.app),
          occurredAt: event.occurredAt ?? event.timestamp ?? null,
          detailPreview: detail ? '[redacted]' : null,
          detailHash: detail && gates.allowOsEventDetails ? sha256(detail) : null
        };
        if (detail && gates.allowOsEventDetails) {
          const result = redactSensitiveText(detail);
          item.detailPreview = compactText(result.text, 160);
          redaction.sensitiveFindings.push(...result.findings);
          if (result.findings.length > 0) {
            redaction.textFieldsRedacted += 1;
          }
        } else if (detail) {
          redaction.textFieldsRedacted += 1;
        }
        return item;
      });
  }
}

export class ReadOnlyContextCollector {
  constructor({ maxRecentFiles = 8, clock = () => new Date(), desktopCollector = null } = {}) {
    this.maxRecentFiles = maxRecentFiles;
    this.clock = clock;
    this.desktopCollector = desktopCollector ?? new DesktopContextCollector({ clock });
  }

  collect({ currentDirectory, taskRequest, environment = {}, desktopContextApproval = null }) {
    const directory = resolve(currentDirectory);
    const recentFiles = this.recentFiles(directory);
    const sensitiveNameCount = recentFiles.filter((item) => item.sensitiveNameHint).length;
    const desktop = this.desktopCollector.collect({
      taskRequest,
      approval: desktopContextApproval ?? environment?.desktopContextApproval ?? taskRequest.metadata?.desktopContextApproval ?? {}
    });
    return {
      currentDirectory: directory,
      recentFiles,
      environment: {
        timezone: taskRequest.context?.userTimezone ?? 'Asia/Seoul',
        locale: taskRequest.command.locale,
        system: {
          platform: platform(),
          release: release(),
          arch: arch(),
          nodeVersion: process.version
        },
        workspace: {
          currentDirectory: directory,
          readable: true,
          scannedAt: this.clock().toISOString(),
          scanMode: 'metadata-only',
          contentRead: false,
          recentFileCount: recentFiles.length,
          sensitiveNameCount
        },
        commandContext: {
          sourceType: taskRequest.source.type,
          sourceModule: taskRequest.source.module,
          inputMode: taskRequest.source.inputMode,
          attachmentCount: taskRequest.attachments?.length ?? 0
        },
        redaction: {
          strategy: 'mask-sensitive-fields-and-never-read-file-content-or-ungated-desktop-content',
          sensitiveNameCount,
          externalEnvironmentMasked: true,
          desktopContentGated: true,
          desktopSensitiveFindingCount: desktop.redaction?.sensitiveFindingCount ?? 0
        },
        desktop,
        provided: maskSensitive(withoutDesktopApproval(environment))
      }
    };
  }

  desktopTelemetryReport(options = {}) {
    return this.desktopCollector?.telemetryReport?.(options) ?? null;
  }

  desktopProviderContractStatus() {
    return this.desktopCollector?.providerContractStatus?.() ?? null;
  }

  runDesktopProviderSoak(options = {}) {
    return this.desktopCollector?.runProviderSoak?.(options) ?? null;
  }

  recentFiles(directory) {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const path = resolve(directory, entry.name);
          const stats = statSync(path);
          return {
            name: this.safeDisplayName(entry.name),
            path,
            extension: extname(entry.name).toLowerCase(),
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            type: 'file',
            sensitiveNameHint: sensitiveNamePattern.test(entry.name)
          };
        })
        .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
        .slice(0, this.maxRecentFiles);
    } catch (error) {
      return [];
    }
  }

  safeDisplayName(name) {
    return sensitiveNamePattern.test(name) ? '[sensitive-filename]' : name;
  }
}

export function createDesktopContextProviderReleaseDossier({ report } = {}) {
  const artifactManifest = createDesktopContextProviderReleaseArtifactManifest({ report });
  const operationalHandoffManifest = createDesktopContextProviderOperationalHandoffManifest({
    report,
    artifactManifest
  });
  const ciNightlyGatePlan = createDesktopContextProviderCiNightlyGatePlan({
    report,
    operationalHandoffManifest
  });
  const externalWormPromotionPackage = createDesktopContextProviderExternalWormPromotionPackage({
    artifactManifest,
    ciNightlyGatePlan,
    operationalHandoffManifest
  });
  const status = report?.status === 'passed'
    && report?.rawContentStored === false
    && report?.failureTelemetry?.expectedFailureCaptured === true
    && report?.providerContract?.permissionUxVersion === 'a-desktop-context-permission-ux-v1'
    && artifactManifest.rawLeakCheck.rawLeakDetected === false
    && operationalHandoffManifest.status === 'ready'
    && externalWormPromotionPackage.status === 'ready'
    ? 'passed'
    : 'failed';
  return {
    dossierVersion: 'a-desktop-context-provider-release-dossier-v1',
    generatedAt: new Date().toISOString(),
    status,
    reportVersion: report?.reportVersion ?? null,
    providerId: report?.providerContract?.providerId ?? null,
    providerVersion: report?.providerContract?.providerVersion ?? null,
    sampleCount: report?.sampleCount ?? 0,
    expectedFailureCaptured: report?.failureTelemetry?.expectedFailureCaptured === true,
    permissionUxStates: report?.permissionUxStates ?? {},
    p95LatencyMs: report?.latency?.p95Ms ?? null,
    rawContentStored: false,
    rawWindowTitlesStored: false,
    rawScreenOcrTextStored: false,
    rawOsEventDetailsStored: false,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    recommendedReleaseAction: status === 'passed'
      ? 'attach_desktop_context_provider_soak_permission_ux_operational_handoff_and_worm_promotion_package'
      : 'block_desktop_context_release_until_provider_soak_passes'
  };
}

export function createDesktopContextProviderReleaseArtifactManifest({ report } = {}) {
  const providerContract = report?.providerContract ?? {};
  const adapters = providerContract.providerContract?.adapters ?? [];
  const sampleArtifacts = (report?.samples ?? []).map((sample) => ({
    sampleId: sample.sampleId,
    providerStatus: sample.providerStatus,
    collectionMode: sample.collectionMode,
    permissionUxState: sample.permissionUxState,
    rawContentStored: sample.rawContentStored === true,
    sampleHash: sha256(JSON.stringify({
      sampleId: sample.sampleId,
      providerStatus: sample.providerStatus,
      collectionMode: sample.collectionMode,
      permissionUxState: sample.permissionUxState,
      rawContentStored: sample.rawContentStored === true,
      adapterStatuses: sample.adapterStatuses ?? []
    }))
  }));
  const providerContractManifest = {
    manifestVersion: 'a-desktop-context-provider-contract-manifest-v1',
    providerConfigured: providerContract.providerConfigured === true,
    providerId: providerContract.providerId ?? null,
    providerVersion: providerContract.providerVersion ?? null,
    providerContractVersion: providerContract.providerContract?.contractVersion ?? null,
    permissionUxVersion: providerContract.permissionUxVersion ?? null,
    adapterCount: adapters.length,
    adapterContractHashes: adapters.map((adapter) => ({
      providerVersion: adapter.providerVersion,
      purpose: adapter.purpose,
      adapterHash: sha256(JSON.stringify({
        providerVersion: adapter.providerVersion,
        purpose: adapter.purpose,
        commandConfigured: adapter.commandConfigured === true,
        nativeProbe: adapter.nativeProbe === true
      }))
    }))
  };
  const manifestCore = {
    artifactManifestVersion: 'a-desktop-context-provider-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    reportVersion: report?.reportVersion ?? null,
    providerContractManifest,
    soakTelemetryHash: sha256(JSON.stringify({
      reportVersion: report?.reportVersion ?? null,
      status: report?.status ?? null,
      sampleCount: report?.sampleCount ?? 0,
      providerStatusCounts: report?.providerStatusCounts ?? {},
      adapterStatusCounts: report?.adapterStatusCounts ?? {},
      permissionUxStates: report?.permissionUxStates ?? {},
      latency: report?.latency ?? {}
    })),
    failureTelemetryHash: sha256(JSON.stringify(report?.failureTelemetry ?? null)),
    sampleArtifacts,
    rawDesktopContentStored: false,
    rawWindowTitlesStored: false,
    rawScreenOcrTextStored: false,
    rawOsEventDetailsStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-desktop-context-provider-raw-leak-check-v1',
      checkedSampleCount: sampleArtifacts.length,
      checkedAdapterCount: adapters.length,
      rawLeakDetected: serializedContextManifestContainsRawDesktopContent(manifestCore)
    }
  };
}

export function createDesktopContextProviderCiNightlyGatePlan({
  report,
  operationalHandoffManifest
} = {}) {
  return {
    planVersion: 'a-desktop-context-provider-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run context:provider-soak',
    requiredForPr: true,
    requiredForNightly: true,
    requiredCycles: report?.cyclesRequested ?? 6,
    requiredChecks: [
      'desktop_context_provider_soak_passed',
      'desktop_context_permission_ux_present',
      'desktop_context_raw_content_not_stored',
      'desktop_context_expected_failure_captured',
      'desktop_context_release_artifact_manifest_ready',
      'desktop_context_operational_handoff_ready'
    ],
    thresholds: {
      maxP95LatencyMs: 2500
    },
    artifactOutputs: [
      'dist/context-provider-soak-report.json',
      'dist/context-provider-soak-report.md',
      'dist/context-provider-soak-report.csv'
    ],
    rawDesktopContentStored: false,
    operationalHandoffHash: sha256(JSON.stringify({
      manifestVersion: operationalHandoffManifest?.manifestVersion ?? null,
      status: operationalHandoffManifest?.status ?? null,
      healthHandshakeVersion: operationalHandoffManifest?.healthHandshakeVersion ?? null
    })),
    planHash: sha256(JSON.stringify({
      reportVersion: report?.reportVersion ?? null,
      providerId: report?.providerContract?.providerId ?? null,
      cyclesRequested: report?.cyclesRequested ?? 0
    }))
  };
}

export function createDesktopContextProviderOperationalHandoffManifest({
  report,
  artifactManifest
} = {}) {
  const providerContract = report?.providerContract ?? {};
  const adapters = providerContract.providerContract?.adapters ?? [];
  const permissionUxStates = report?.permissionUxStates ?? {};
  const manifestCore = {
    manifestVersion: 'a-desktop-context-provider-operational-handoff-manifest-v1',
    healthHandshakeVersion: 'a-desktop-context-provider-health-handshake-v1',
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    provider: {
      providerId: providerContract.providerId ?? null,
      providerVersion: providerContract.providerVersion ?? null,
      providerConfigured: providerContract.providerConfigured === true,
      providerContractVersion: providerContract.providerContract?.contractVersion ?? null,
      permissionUxVersion: providerContract.permissionUxVersion ?? null
    },
    healthHandshake: {
      reportVersion: report?.reportVersion ?? null,
      reportStatus: report?.status ?? 'missing',
      sampleCount: report?.sampleCount ?? 0,
      providerStatusCounts: report?.providerStatusCounts ?? {},
      adapterStatusCounts: report?.adapterStatusCounts ?? {},
      expectedFailureCaptured: report?.failureTelemetry?.expectedFailureCaptured === true,
      p95LatencyMs: report?.latency?.p95Ms ?? null
    },
    permissionUxHealth: {
      approvalRequiredSeen: Number(permissionUxStates['approval-required'] ?? 0) > 0,
      approvedSeen: Number(permissionUxStates.approved ?? 0) > 0,
      states: permissionUxStates
    },
    adapterContracts: adapters.map((adapter) => ({
      providerVersion: adapter.providerVersion,
      purpose: adapter.purpose,
      adapterHash: sha256(JSON.stringify({
        providerVersion: adapter.providerVersion,
        purpose: adapter.purpose,
        commandConfigured: adapter.commandConfigured === true,
        nativeProbe: adapter.nativeProbe === true
      }))
    })),
    fallbackPolicy: {
      policyVersion: 'a-desktop-context-provider-fallback-policy-v1',
      primaryFlow: 'approval_gated_windows_context_provider',
      fallbackFlows: [
        'metadata_only_context_snapshot',
        'manual_context_summary_prompt',
        'skip_desktop_context_and_require_user_confirmation'
      ],
      timeoutMs: report?.timeoutMs ?? 1200,
      operatorEscalation: 'core_runtime_desktop_context_diagnostics'
    },
    artifactManifestHash: sha256(JSON.stringify({
      artifactManifestVersion: artifactManifest?.artifactManifestVersion ?? null,
      rawLeakDetected: artifactManifest?.rawLeakCheck?.rawLeakDetected ?? true,
      sampleArtifactCount: artifactManifest?.sampleArtifacts?.length ?? 0
    })),
    rawDesktopContentStored: false,
    rawWindowTitlesStored: false,
    rawScreenOcrTextStored: false,
    rawOsEventDetailsStored: false,
    providerCommandStored: false
  };
  const rawLeakDetected = serializedContextManifestContainsRawDesktopContent(manifestCore);
  const ready = report?.status === 'passed'
    && report?.rawContentStored === false
    && report?.failureTelemetry?.expectedFailureCaptured === true
    && providerContract.permissionUxVersion === 'a-desktop-context-permission-ux-v1'
    && artifactManifest?.rawLeakCheck?.rawLeakDetected === false
    && rawLeakDetected === false;
  return {
    ...manifestCore,
    status: ready ? 'ready' : 'blocked',
    rawLeakCheck: {
      checkVersion: 'a-desktop-context-provider-operational-raw-leak-check-v1',
      checkedAdapterCount: adapters.length,
      checkedSampleCount: report?.sampleCount ?? 0,
      rawLeakDetected
    }
  };
}

export function createDesktopContextProviderExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  operationalHandoffManifest
} = {}) {
  return {
    packageVersion: 'a-desktop-context-provider-worm-promotion-package-v1',
    providerContractVersion: 'a-desktop-context-provider-worm-provider-contract-v1',
    status: artifactManifest?.artifactManifestVersion === 'a-desktop-context-provider-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck?.rawLeakDetected === false
      && ciNightlyGatePlan?.planVersion === 'a-desktop-context-provider-ci-nightly-gate-plan-v1'
      && operationalHandoffManifest?.status === 'ready'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256(JSON.stringify(artifactManifest ?? null)),
    ciNightlyGatePlanHash: sha256(JSON.stringify(ciNightlyGatePlan ?? null)),
    operationalHandoffHash: sha256(JSON.stringify(operationalHandoffManifest ?? null)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawDesktopContentStored: false,
    rawWindowTitlesStored: false,
    rawScreenOcrTextStored: false,
    rawOsEventDetailsStored: false
  };
}

function serializedContextManifestContainsRawDesktopContent(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"(?:windowTitle|ocrText|screenText|eventDetail|detailPreview|openApps|osEvents)"\s*:/i.test(serialized);
}

export function createDesktopContextProviderProductGate({
  report,
  releaseDossier = createDesktopContextProviderReleaseDossier({ report }),
  maxP95LatencyMs = 2500
} = {}) {
  const latencyForGate = Number.isFinite(report?.latency?.budgetP95Ms)
    ? Number(report.latency.budgetP95Ms)
    : Number(report?.latency?.p95Ms);
  const checks = [
    {
      checkId: 'desktop_context_provider_soak_passed',
      passed: report?.reportVersion === 'a-desktop-context-provider-soak-v1' && report?.status === 'passed'
    },
    {
      checkId: 'desktop_context_permission_ux_present',
      passed: report?.providerContract?.permissionUxVersion === 'a-desktop-context-permission-ux-v1'
        && Object.keys(report?.permissionUxStates ?? {}).length >= 1
    },
    {
      checkId: 'desktop_context_raw_content_not_stored',
      passed: report?.rawContentStored === false
        && (report?.samples ?? []).every((sample) => sample.rawContentStored === false)
    },
    {
      checkId: 'desktop_context_expected_failure_captured',
      passed: report?.failureTelemetry?.expectedFailureCaptured === true
    },
    {
      checkId: 'desktop_context_latency_budget_met',
      passed: !Number.isFinite(latencyForGate) || latencyForGate <= maxP95LatencyMs
    },
    {
      checkId: 'desktop_context_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'a-desktop-context-provider-release-dossier-v1'
        && releaseDossier.status === 'passed'
    },
    {
      checkId: 'desktop_context_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-desktop-context-provider-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
    },
    {
      checkId: 'desktop_context_ci_nightly_gate_plan_ready',
      passed: releaseDossier.ciNightlyGatePlan?.planVersion === 'a-desktop-context-provider-ci-nightly-gate-plan-v1'
        && releaseDossier.ciNightlyGatePlan?.requiredForPr === true
        && releaseDossier.ciNightlyGatePlan?.requiredForNightly === true
    },
    {
      checkId: 'desktop_context_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'a-desktop-context-provider-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'a-desktop-context-provider-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'a-desktop-context-provider-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
        && releaseDossier.operationalHandoffManifest?.rawDesktopContentStored === false
        && releaseDossier.operationalHandoffManifest?.rawWindowTitlesStored === false
        && releaseDossier.operationalHandoffManifest?.rawScreenOcrTextStored === false
        && releaseDossier.operationalHandoffManifest?.rawOsEventDetailsStored === false
    },
    {
      checkId: 'desktop_context_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-desktop-context-provider-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-desktop-context-provider-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'a-desktop-context-provider-product-gate-v1',
    generatedAt: new Date().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    thresholds: {
      maxP95LatencyMs
    },
    checks,
    releaseDossier
  };
}

export class ContextSnapshotBuilder {
  constructor({
    cwd = () => process.cwd(),
    clock = () => new Date(),
    collector = null,
    desktopContextProvider = null,
    desktopContextCollector = null
  } = {}) {
    this.cwd = cwd;
    this.clock = clock;
    this.desktopContextCollector = desktopContextCollector ?? new DesktopContextCollector({ provider: desktopContextProvider, clock });
    this.collector = collector ?? new ReadOnlyContextCollector({ clock, desktopCollector: this.desktopContextCollector });
  }

  build(taskRequest, { memoryContext = [], environment = {}, desktopContextApproval = null } = {}) {
    const collected = this.collector.collect({
      currentDirectory: this.cwd(),
      taskRequest,
      environment,
      desktopContextApproval
    });
    const desktopMode = collected.environment.desktop?.collectionMode ?? 'disabled';
    return createContextSnapshot({
      snapshotId: stableId('ctx', taskRequest.taskId, taskRequest.createdAt),
      taskId: taskRequest.taskId,
      currentDirectory: collected.currentDirectory,
      createdAt: this.clock().toISOString(),
      recentFiles: collected.recentFiles,
      ...projectMemoryContext(memoryContext),
      workflow: {
        entrySource: taskRequest.source.type,
        inputMode: taskRequest.source.inputMode,
        contextCollection: desktopMode === 'disabled' ? 'read-only-metadata' : `read-only-metadata+desktop-${desktopMode}`,
        desktopContextCollection: desktopMode
      },
      environment: collected.environment
    });
  }

  desktopTelemetryReport(options = {}) {
    return this.desktopContextCollector?.telemetryReport?.(options)
      ?? this.collector?.desktopTelemetryReport?.(options)
      ?? null;
  }

  desktopProviderContractStatus() {
    return this.desktopContextCollector?.providerContractStatus?.() ?? null;
  }

  runDesktopProviderSoak(options = {}) {
    return this.desktopContextCollector?.runProviderSoak?.(options) ?? null;
  }
}

function countBy(values) {
  return values.reduce((counts, value) => {
    const key = value ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
