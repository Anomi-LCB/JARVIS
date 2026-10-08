import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { listAndroidDevices, resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);
const runnerPackage = 'local.eureka.jarvis.wearablefield';

export async function runWearableNonAcousticAudit({
  serial = process.env.JARVIS_WEARABLE_DEVICE_SERIAL ?? '',
  durationMs = 60_000,
  sampleIntervalMs = 5_000,
  jsonPath = 'dist/wearable-non-acoustic-audit.json',
  markdownPath = 'dist/wearable-non-acoustic-audit.md',
  fetchImpl = globalThis.fetch,
  clock = () => new Date()
} = {}) {
  const generatedAt = clock().toISOString();
  const report = {
    reportVersion: 'jarvis-wearable-non-acoustic-audit-v1',
    generatedAt,
    status: 'running',
    scope: {
      physicalDevice: true,
      acousticInput: false,
      subjectiveWearability: false,
      fullPhysicalGateSatisfied: false
    },
    checks: [],
    pendingChecks: [
      'microphone-signal-with-human-speech',
      'wake-and-command-recognition',
      'indoor-readability-confirmation',
      'outdoor-readability-confirmation',
      'motion-comfort-confirmation',
      'extended-use-thermal-battery-confirmation'
    ],
    privacy: {
      rawDeviceSerialStored: false,
      rawAudioStored: false,
      rawTranscriptStored: false,
      screenshotsStored: false,
      bridgeTokensStored: false
    }
  };

  try {
    const probe = await listAndroidDevices();
    const device = selectTarget(probe.devices, serial);
    const adb = await resolveAdbCommand();
    const fingerprint = shortHash(device.serial);
    const [model, displayText, initialFocusText, reverseText, batteryText, thermalText, runnerReport] = await Promise.all([
      adbShell(adb.command, device.serial, ['getprop', 'ro.product.model']),
      adbShell(adb.command, device.serial, ['wm', 'size']),
      adbShell(adb.command, device.serial, ['dumpsys', 'window']),
      adbExec(adb.command, ['-s', device.serial, 'reverse', '--list']).then((result) => result.stdout),
      adbShell(adb.command, device.serial, ['dumpsys', 'battery']),
      adbShell(adb.command, device.serial, ['dumpsys', 'thermalservice']),
      readJson('dist/wearable-field-runner-report.json')
    ]);
    const display = parseDisplaySize(displayText);
    const batteryBefore = parseBatteryState(batteryText);
    const thermalBefore = parseThermalState(thermalText);
    let focusText = initialFocusText;
    let focusRecovered = false;
    if (!focusText.includes(runnerPackage)) {
      await adbExec(adb.command, ['-s', device.serial, 'shell', 'input', 'keyevent', '224']).catch(() => null);
      await adbExec(adb.command, [
        '-s', device.serial,
        'shell', 'am', 'start', '-W',
        '-n', `${runnerPackage}/.FieldLabActivity`,
        '--es', 'url', 'http://127.0.0.1:4176/field-calibration.html'
      ]);
      await delay(1_500);
      focusText = await adbShell(adb.command, device.serial, ['dumpsys', 'window']);
      focusRecovered = focusText.includes(runnerPackage);
    }
    report.device = {
      fingerprint,
      model: clean(model),
      physical: !/emulator|sdk_gphone/i.test(`${model} ${device.serial}`),
      display
    };
    report.power = { before: { battery: batteryBefore, thermal: thermalBefore }, after: null };
    add(report, 'physical-device-ready', report.device.physical === true, report.device.model);
    add(report, 'runner-evidence-current', runnerReport?.status === 'passed'
      && runnerReport?.device?.fingerprint === fingerprint, runnerReport?.status ?? 'missing');
    report.recovery = { appFocusRelaunchAttempted: initialFocusText.includes(runnerPackage) === false, appFocusRecovered: focusRecovered };
    add(report, 'runner-app-focused', focusText.includes(runnerPackage), focusRecovered ? 'focused-after-relaunch' : focusText.includes(runnerPackage) ? 'focused' : 'not-focused');
    add(report, 'display-geometry-ready', display.width >= 320 && display.height >= 400, `${display.width}x${display.height}`);
    add(report, 'hud-reverse-ready', reverseText.includes('tcp:4176 tcp:4176'), 'tcp:4176');
    add(report, 'bridge-reverse-ready', reverseText.includes('tcp:17777 tcp:17777'), 'tcp:17777');
    add(report, 'battery-baseline-ready', batteryBefore.present && batteryBefore.level >= 20 && batteryBefore.temperatureC <= 45,
      `${batteryBefore.level}%/${batteryBefore.temperatureC}C`);
    add(report, 'thermal-baseline-ready', thermalBefore.halReady && thermalBefore.status <= 2,
      `status-${thermalBefore.status}`);

    const samples = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt < Math.max(1_000, durationMs)) {
      const started = Date.now();
      const [field, bridge] = await Promise.all([
        probeUrl(fetchImpl, 'http://127.0.0.1:4176/field-calibration.html', 'jarvis-wearable-field-lab'),
        probeUrl(fetchImpl, 'http://127.0.0.1:17777/health', 'D_BRIDGE')
      ]);
      samples.push({
        elapsedMs: Date.now() - startedAt,
        latencyMs: Date.now() - started,
        fieldReady: field.ready,
        bridgeReady: bridge.ready
      });
      if (Date.now() - startedAt >= durationMs) break;
      await delay(Math.min(sampleIntervalMs, Math.max(0, durationMs - (Date.now() - startedAt))));
    }
    const successSamples = samples.filter((sample) => sample.fieldReady && sample.bridgeReady);
    const latencies = successSamples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    report.soak = {
      requestedDurationMs: durationMs,
      sampleCount: samples.length,
      successCount: successSamples.length,
      availability: samples.length > 0 ? successSamples.length / samples.length : 0,
      p95Ms: percentile(latencies, 0.95),
      contentBodiesStored: false
    };
    add(report, 'non-acoustic-soak-ready', report.soak.sampleCount >= 2
      && report.soak.availability === 1
      && report.soak.p95Ms <= 1_200, `${report.soak.successCount}/${report.soak.sampleCount}`);

    const [batteryAfterText, thermalAfterText] = await Promise.all([
      adbShell(adb.command, device.serial, ['dumpsys', 'battery']),
      adbShell(adb.command, device.serial, ['dumpsys', 'thermalservice'])
    ]);
    const batteryAfter = parseBatteryState(batteryAfterText);
    const thermalAfter = parseThermalState(thermalAfterText);
    report.power.after = { battery: batteryAfter, thermal: thermalAfter };
    add(report, 'power-after-soak-ready', batteryAfter.present
      && batteryAfter.temperatureC <= 45
      && thermalAfter.halReady
      && thermalAfter.status <= 2,
    `${batteryAfter.level}%/${batteryAfter.temperatureC}C/status-${thermalAfter.status}`);
    add(report, 'privacy-contract-ready', Object.values(report.privacy).every((value) => value === false), 'no-sensitive-payloads');
    report.status = report.checks.every((check) => check.passed) ? 'passed-non-acoustic' : 'blocked';
    report.nextAction = report.status === 'passed-non-acoustic'
      ? 'Complete the human acoustic and subjective field checks; this report does not satisfy the full wearable physical gate.'
      : 'Resolve failed non-acoustic checks before attempting the acoustic field gate.';
  } catch (error) {
    report.status = 'blocked';
    report.failure = { code: normalizeError(error), fingerprint: shortHash(error?.stack ?? error) };
    report.nextAction = 'Restore the field server, bridge, ADB target, and field runner before retrying.';
  }

  await writeReport(report, { jsonPath, markdownPath });
  return report;
}

export function parseBatteryState(value) {
  const text = String(value ?? '');
  return {
    present: field(text, 'present') === 'true',
    level: numberField(text, 'level'),
    healthCode: numberField(text, 'health'),
    statusCode: numberField(text, 'status'),
    usbPowered: field(text, 'USB powered') === 'true',
    temperatureC: round(numberField(text, 'temperature') / 10, 1)
  };
}

export function parseThermalState(value) {
  const text = String(value ?? '');
  return {
    status: numberMatch(text, /Thermal Status:\s*(-?\d+)/i),
    halReady: /HAL Ready:\s*true/i.test(text),
    halConnected: /ThermalHAL[^\n]*connected:\s*yes/i.test(text)
  };
}

export function parseDisplaySize(value) {
  const match = String(value ?? '').match(/(\d+)x(\d+)/i);
  return { width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0) };
}

function selectTarget(devices, requestedSerial) {
  const ready = (devices ?? []).filter((device) => device.state === 'device');
  const requested = clean(requestedSerial);
  if (requested) {
    const match = ready.find((device) => device.serial === requested);
    if (!match) throw new Error('requested-wearable-device-not-ready');
    return match;
  }
  if (ready.length === 0) throw new Error('no-ready-wearable-device');
  if (ready.length > 1) throw new Error('multiple-ready-devices-require-serial');
  return ready[0];
}

async function probeUrl(fetchImpl, url, marker) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
    const body = await response.text();
    return { ready: response.ok && body.includes(marker) };
  } catch {
    return { ready: false };
  }
}

async function adbExec(adb, args) {
  return await execFileAsync(adb, args, {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8'
  });
}

async function adbShell(adb, serial, args) {
  const result = await adbExec(adb, ['-s', serial, 'shell', ...args]);
  return String(result.stdout ?? '').trim();
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch {
    return null;
  }
}

function add(report, checkId, passed, detail) {
  report.checks.push({ checkId, passed: passed === true, detail: clean(detail), severity: 'blocking-non-acoustic' });
}

async function writeReport(report, { jsonPath, markdownPath }) {
  const json = resolve(jsonPath);
  const markdown = resolve(markdownPath);
  await Promise.all([mkdir(dirname(json), { recursive: true }), mkdir(dirname(markdown), { recursive: true })]);
  await Promise.all([
    writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdown, renderMarkdown(report), 'utf8')
  ]);
}

function renderMarkdown(report) {
  const rows = report.checks.map((check) => `| ${check.passed ? '통과' : '차단'} | ${check.checkId} | ${check.detail} |`).join('\n');
  return `# JARVIS 안경 비음향 현장 감사\n\n- 판정: **${report.status}**\n- 전체 물리 게이트 충족: **아니오**\n- 음향 입력 포함: **아니오**\n\n| 결과 | 검사 | 증거 |\n| --- | --- | --- |\n${rows}\n\n## 남은 물리 검사\n\n${report.pendingChecks.map((item) => `- ${item}`).join('\n')}\n\n${report.nextAction}\n`;
}

function field(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clean(text.match(new RegExp(`^\\s*${escaped}:\\s*(.+)$`, 'im'))?.[1]).toLowerCase();
}

function numberField(text, name) {
  const value = Number.parseInt(field(text, name), 10);
  return Number.isFinite(value) ? value : 0;
}

function numberMatch(text, pattern) {
  const value = Number.parseInt(String(text ?? '').match(pattern)?.[1] ?? '', 10);
  return Number.isFinite(value) ? value : 99;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160);
}

function normalizeError(error) {
  return clean(error?.message ?? error ?? 'wearable-non-acoustic-audit-failed')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-') || 'wearable-non-acoustic-audit-failed';
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--serial') options.serial = argv[++index];
    else if (argv[index] === '--duration-ms') options.durationMs = Number(argv[++index]);
    else if (argv[index] === '--sample-interval-ms') options.sampleIntervalMs = Number(argv[++index]);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runWearableNonAcousticAudit(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    status: report.status,
    passedChecks: report.checks.filter((check) => check.passed).length,
    totalChecks: report.checks.length,
    pendingPhysicalChecks: report.pendingChecks.length,
    reportPath: resolve('dist/wearable-non-acoustic-audit.md')
  }, null, 2));
  if (report.status !== 'passed-non-acoustic') process.exitCode = 1;
}
