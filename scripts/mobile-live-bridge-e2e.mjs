import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createBridgeServer } from '../apps/bridge/src/main.mjs';
import { listAndroidDevices, resolveAdbCommand } from './mobile-device-smoke.mjs';

const execFileAsync = promisify(execFile);
const androidPackageName = 'local.eureka.jarvis';
const defaultArtifactDir = 'dist/mobile-live-bridge-e2e';
const defaultPort = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSerial(serial) {
  return String(serial).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function isUnpairedPairingScreen(xml) {
  const pairingScreenVisible = xml.includes('screen-content-PairingScreen');
  const summaryShowsUnpaired = xml.includes('text="paired"') && xml.includes('text="no"');
  const detailShowsUnpaired = xml.includes('text="Live Bridge"')
    && xml.includes('text="not connected"')
    && xml.includes('text="Token"')
    && xml.includes('text="none"');
  return pairingScreenVisible && (summaryShowsUnpaired || detailShowsUnpaired);
}

async function adb(args, options = {}) {
  const adbResolution = options.adbResolution ?? await resolveAdbCommand();
  return execFileAsync(adbResolution.command, args, {
    windowsHide: true,
    timeout: options.timeout ?? 9000,
    maxBuffer: options.maxBuffer ?? 12 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8'
  });
}

async function shell(serial, command, options = {}) {
  try {
    const { stdout } = await adb(['-s', serial, 'shell', command], options);
    return String(stdout).trim();
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const details = [error.message, stdout && `stdout: ${stdout}`, stderr && `stderr: ${stderr}`]
      .filter(Boolean)
      .join('\n');
    throw new Error(details);
  }
}

async function collapseSystemOverlays(serial) {
  await shell(serial, 'cmd statusbar collapse', { timeout: 5000 }).catch(() => '');
  await shell(serial, 'input keyevent KEYCODE_ESCAPE', { timeout: 5000 }).catch(() => '');
}

async function readUiXml(serial) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const dumpOutput = await shell(serial, 'uiautomator dump /sdcard/jarvis-live-e2e-window.xml', { timeout: 30000 });
      if (/ERROR:|null root node/i.test(dumpOutput)) throw new Error(dumpOutput);
      const { stdout } = await adb(['-s', serial, 'exec-out', 'cat', '/sdcard/jarvis-live-e2e-window.xml'], {
        timeout: 12000,
        maxBuffer: 12 * 1024 * 1024
      });
      if (String(stdout).includes('<hierarchy')) return stdout;
      lastError = new Error('uiautomator dump did not contain a hierarchy document');
    } catch (error) {
      lastError = error;
    }
    await delay(700 + attempt * 300);
  }
  throw lastError ?? new Error('uiautomator dump failed');
}

async function captureScreenshot(serial, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const { stdout } = await adb(
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    { encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 * 1024 }
  );
  const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  await writeFile(outputPath, png);
  return {
    outputPath,
    bytes: png.length,
    hasPngHeader: png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
  };
}

function parseBounds(value = '') {
  const match = value.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2)
  };
}

function parseNodes(xml) {
  return [...xml.matchAll(/<node\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const attrs = {};
    for (const attr of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
    }
    return {
      tag,
      attrs,
      bounds: parseBounds(attrs.bounds)
    };
  });
}

function resourceIdMatches(actual, expected) {
  if (!actual) return false;
  return actual === expected || actual.endsWith(`/${expected}`) || actual.endsWith(`:id/${expected}`);
}

function hasDataRowValue(xml, label, value) {
  const normalized = String(value);
  return xml.includes(`text="${label}"`)
    && xml.includes(`text="${normalized}"`)
    && !xml.includes(`text="not ${normalized}"`);
}

function extractPairingCodeFromXml(xml = '') {
  const issued = String(xml).match(/D Bridge pairing code 발급:\s*(\d{6,12})/);
  if (issued) return issued[1];
  const panel = String(xml).match(/페어링 코드\s*(\d{6,12})/);
  return panel?.[1] ?? null;
}

function findNodeByResourceId(xml, resourceId) {
  return parseNodes(xml).find((node) => node.bounds && resourceIdMatches(node.attrs['resource-id'], resourceId)) ?? null;
}

function findNodeByResourcePrefix(xml, resourcePrefix) {
  return parseNodes(xml).find((node) => {
    const resourceId = node.attrs['resource-id'] ?? '';
    return node.bounds && (resourceId.startsWith(resourcePrefix) || resourceId.includes(`/${resourcePrefix}`) || resourceId.includes(`:id/${resourcePrefix}`));
  }) ?? null;
}

function findSystemWaitNode(xml) {
  return parseNodes(xml).find((node) => (
    node.bounds
    && (
      resourceIdMatches(node.attrs['resource-id'], 'android:id/aerr_wait')
      || node.attrs.text === 'Wait'
    )
  )) ?? null;
}

async function dumpXml(serial, artifactDir, name) {
  let xml = await readUiXml(serial);
  const waitNode = findSystemWaitNode(xml);
  if (waitNode?.bounds) {
    const dialogPath = join(artifactDir, `${sanitizeSerial(serial)}-${name}-system-dialog.xml`);
    await writeFile(dialogPath, xml, 'utf8');
    await tapAt(serial, waitNode.bounds).catch(() => '');
    await delay(1500);
    xml = await readUiXml(serial);
  }
  const outputPath = join(artifactDir, `${sanitizeSerial(serial)}-${name}.xml`);
  await writeFile(outputPath, xml, 'utf8');
  return { xml, outputPath };
}

async function scroll(serial, direction = 'down') {
  if (direction === 'up') {
    await shell(serial, 'input touchscreen swipe 540 520 540 1680 450').catch(async () => {
      await shell(serial, 'input swipe 540 520 540 1680 450').catch(() => '');
    });
  } else {
    await shell(serial, 'input touchscreen swipe 540 1680 540 520 450').catch(async () => {
      await shell(serial, 'input swipe 540 1680 540 520 450').catch(() => '');
    });
  }
  await delay(450);
}

async function scrollToTop(serial) {
  for (let index = 0; index < 3; index += 1) {
    await scroll(serial, 'up');
  }
}

async function tapNode(serial, artifactDir, { resourceId, resourcePrefix, label, maxScrolls = 8 }) {
  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const { xml, outputPath } = await dumpXml(serial, artifactDir, `tap-${label}-attempt-${attempt}`);
    const node = resourceId
      ? findNodeByResourceId(xml, resourceId)
      : findNodeByResourcePrefix(xml, resourcePrefix);
    if (node?.bounds) {
      await tapAt(serial, node.bounds);
      await delay(900);
      return {
        tapped: true,
        label,
        resourceId: node.attrs['resource-id'],
        text: node.attrs.text ?? null,
        bounds: node.bounds,
        outputPath
      };
    }
    await scroll(serial, 'down');
  }
  throw new Error(`UI node not found for ${label}`);
}

async function tapAt(serial, bounds) {
  try {
    await shell(serial, `input touchscreen tap ${bounds.centerX} ${bounds.centerY}`);
  } catch {
    await shell(serial, `input tap ${bounds.centerX} ${bounds.centerY}`);
  }
}

async function waitForXml(serial, artifactDir, label, predicate, { timeoutMs = 12_000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await dumpXml(serial, artifactDir, `wait-${label}-${Date.now()}`);
    if (predicate(latest.xml)) {
      return {
        matched: true,
        label,
        outputPath: latest.outputPath
      };
    }
    await delay(intervalMs);
  }
  return {
    matched: false,
    label,
    outputPath: latest?.outputPath ?? null
  };
}

async function waitForRuntime(label, predicate, { timeoutMs = 10_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return { matched: true, label, value };
    await delay(intervalMs);
  }
  return { matched: false, label, value: predicate() };
}

function runtimeSnapshot(bridgeRuntime) {
  const tasks = [...bridgeRuntime.coreFacade.tasks.values()].map((task) => ({
    taskId: task.taskId,
    status: task.status,
    approvalId: task.approvalCard?.approvalId ?? null,
    riskTier: task.approvalCard?.riskTier ?? null
  }));
  return {
    health: bridgeRuntime.health(),
    devices: bridgeRuntime.registry.list(),
    cache: bridgeRuntime.stateCache.snapshot(),
    tasks,
    events: bridgeRuntime.eventRelay.status()
  };
}

async function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

async function openDeepLink(serial, packageName, url) {
  const output = await shell(
    serial,
    `am start -W -a android.intent.action.VIEW -d "${url}" ${packageName}`,
    { timeout: 45000 }
  );
  await delay(900);
  return {
    url,
    output,
    success: /Status:\s*ok|Complete|Warning: Activity not started/i.test(output) && !/Error:/i.test(output)
  };
}

async function close(server, { timeoutMs = 5000 } = {}) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close((error) => finish(error));
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 250).unref?.();
  });
}

async function launchApp(serial, packageName, { clearData = false, launchWaitMs = 5000 } = {}) {
  await shell(serial, `am force-stop ${packageName}`).catch(() => '');
  await collapseSystemOverlays(serial);
  if (clearData) {
    await shell(serial, `pm clear ${packageName}`, { timeout: 30000 });
  }
  try {
    const output = await shell(serial, `am start -W -n ${packageName}/.MainActivity`, { timeout: 45000 });
    await delay(launchWaitMs);
    await collapseSystemOverlays(serial);
    return {
      output,
      method: 'am-start-wait',
      success: /Status:\s*ok|Complete/i.test(output) && !/Error:/i.test(output)
    };
  } catch (error) {
    const explicitError = error.code ?? error.message;
    const monkeyOutput = await shell(serial, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 }).catch((fallbackError) => String(fallbackError.code ?? fallbackError.message));
    await delay(launchWaitMs);
    await collapseSystemOverlays(serial);
    const focused = await shell(serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"', { timeout: 10000 }).catch(() => '');
    return {
      output: error.stdout ? String(error.stdout).trim() : '',
      method: 'monkey-launcher-fallback',
      explicitError,
      monkeyOutput,
      focused,
      success: String(monkeyOutput).includes('Events injected: 1') || String(focused).includes(packageName)
    };
  }
}

async function runStep(report, id, fn) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    const result = await fn();
    const step = {
      id,
      status: 'passed',
      startedAt,
      durationMs: Date.now() - startedMs,
      ...result
    };
    report.steps.push(step);
    return step;
  } catch (error) {
    const step = {
      id,
      status: 'failed',
      startedAt,
      durationMs: Date.now() - startedMs,
      error: error.code ?? error.message
    };
    report.steps.push(step);
    throw error;
  }
}

export async function runMobileLiveBridgeE2E({
  artifactDir = defaultArtifactDir,
  packageName = androidPackageName,
  port = Number(process.env.JARVIS_MOBILE_E2E_PORT ?? defaultPort),
  host = process.env.JARVIS_MOBILE_E2E_HOST ?? '0.0.0.0'
} = {}) {
  await mkdir(artifactDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'running',
    packageName,
    bridge: {
      host,
      port,
      emulatorUrl: `http://10.0.2.2:${port}`,
      localUrl: `http://127.0.0.1:${port}`
    },
    steps: [],
    artifacts: {
      directory: artifactDir
    },
    runtime: null,
    actualDeviceVerified: false,
    liveBridgeVerified: false,
    secureStoreRestoreVerified: false,
    deviceRevokeVerified: false,
    secureStoreCleanupVerified: false
  };

  const { bridgeRuntime } = createAgRuntime({
    auditRoot: join(artifactDir, 'audit'),
    outputPath: join('workspace', 'mobile-live-e2e-output.txt')
  });
  const server = createBridgeServer(bridgeRuntime);

  try {
    await runStep(report, 'bridge.listen', async () => {
      const address = await listen(server, { host, port });
      report.bridge.port = address.port;
      report.bridge.emulatorUrl = `http://10.0.2.2:${address.port}`;
      report.bridge.localUrl = `http://127.0.0.1:${address.port}`;
      return { address };
    });

    const probe = await runStep(report, 'adb.ready-device', async () => {
      const deviceProbe = await listAndroidDevices();
      const device = deviceProbe.devices.find((item) => item.state === 'device');
      if (!deviceProbe.available) throw new Error('adb-not-available');
      if (!device) throw new Error('no-ready-android-device');
      return { adb: deviceProbe.adb, device };
    });
    const serial = probe.device.serial;
    report.device = { serial };

    await runStep(report, 'app.installed', async () => {
      const installedPath = await shell(serial, `pm path ${packageName}`).catch(() => '');
      if (!installedPath.includes(packageName)) throw new Error(`${packageName} is not installed`);
      return { installedPath };
    });

    await runStep(report, 'app.launch-clean', async () => {
      const launch = await launchApp(serial, packageName, { clearData: true, launchWaitMs: 7000 });
      if (!launch.success) throw new Error(`launch failed: ${launch.output}`);
      await scrollToTop(serial);
      const screen = await waitForXml(
        serial,
        artifactDir,
        'pairing-screen',
        (xml) => xml.includes('screen-content-PairingScreen'),
        { timeoutMs: 90_000, intervalMs: 1500 }
      );
      if (!screen.matched) throw new Error('PairingScreen not visible after launch');
      return { launch, screen };
    });

    await runStep(report, 'ui.bridge-url-configure', async () => {
      const activation = await openDeepLink(
        serial,
        packageName,
        `jarvis://pair?bridge=${encodeURIComponent(report.bridge.emulatorUrl)}`
      );
      const screen = await waitForXml(serial, artifactDir, 'bridge-url-configured', (xml) => (
        xml.includes(report.bridge.emulatorUrl)
        && xml.includes('screen-content-PairingScreen')
      ), { timeoutMs: 14_000 });
      if (!screen.matched) throw new Error('Mobile app did not load the E2E bridge URL');
      return { activation, screen, bridgeUrl: report.bridge.emulatorUrl };
    });

    await runStep(report, 'ui.health', async () => {
      const activation = await openDeepLink(serial, packageName, 'jarvis://bridge/health');
      const screen = await waitForXml(serial, artifactDir, 'bridge-health-success', (xml) => (
        (
          xml.includes('D Bridge /health 연결 성공')
          || xml.includes('Last response: ok')
          || hasDataRowValue(xml, 'Live Bridge', 'connected')
        )
        && !xml.includes('text="확인 중"')
        && !xml.includes('content-desc="확인 중"')
        && !xml.includes('Network request failed')
      ), { timeoutMs: 34_000 });
      if (!screen.matched) throw new Error('mobile app did not show successful D Bridge /health response');
      const runtime = await waitForRuntime('bridge health connected', () => bridgeRuntime.health().status === 'ok');
      if (!runtime.matched) throw new Error('bridge runtime did not report ok health');
      return { activation, screen, runtime };
    });

    await runStep(report, 'ui.pairing-start', async () => {
      const activation = await tapNode(serial, artifactDir, {
        resourceId: 'pairing-start-button',
        label: 'pairing-start',
        maxScrolls: 2
      });
      const screen = await waitForXml(serial, artifactDir, 'pairing-start-success', (xml) => (
        xml.includes('D Bridge pairing code 발급')
        && /^\d{6,12}$/.test(extractPairingCodeFromXml(xml) ?? '')
        && !xml.includes('pairing/start 실패')
        && !xml.includes('Network request failed')
      ), { timeoutMs: 70_000, intervalMs: 900 });
      if (!screen.matched) throw new Error('Pairing start response was not visible in mobile UI');
      const xml = await readFile(screen.outputPath, 'utf8');
      const pairingCode = extractPairingCodeFromXml(xml);
      const runtime = await waitForRuntime(
        'pairing code active',
        () => bridgeRuntime.pairing.activeCode?.pairingCode === pairingCode,
        { timeoutMs: 5000, intervalMs: 250 }
      );
      return {
        activation,
        screen,
        runtime,
        activeCode: {
          pairingCode,
          expiresAt: bridgeRuntime.pairing.activeCode?.expiresAt ?? null
        }
      };
    });

    await runStep(report, 'ui.pairing-confirm', async () => {
      const activation = await tapNode(serial, artifactDir, {
        resourceId: 'pairing-confirm-button',
        label: 'pairing-confirm',
        maxScrolls: 2
      });
      const runtime = await waitForRuntime(
        'device paired',
        () => bridgeRuntime.registry.list().some((device) => device.status === 'active'),
        { timeoutMs: 60_000, intervalMs: 500 }
      );
      if (!runtime.matched) throw new Error('device was not registered after pairing confirm');
      const screen = await waitForXml(serial, artifactDir, 'command-screen-after-pairing', (xml) => xml.includes('screen-content-CommandScreen'));
      if (!screen.matched) throw new Error('CommandScreen not visible after pairing');
      return { activation, pairedDevices: bridgeRuntime.registry.list(), screen };
    });

    await runStep(report, 'ui.task-create', async () => {
      const activation = await openDeepLink(serial, packageName, 'jarvis://task/create');
      const runtime = await waitForRuntime('task cached', () => bridgeRuntime.stateCache.snapshot().tasks.length > 0);
      if (!runtime.matched) throw new Error('task was not created through D Bridge');
      const screen = await waitForXml(serial, artifactDir, 'approval-queue-after-task', (xml) => xml.includes('screen-content-ApprovalQueueScreen'));
      if (!screen.matched) throw new Error('ApprovalQueueScreen not visible after task create');
      return { activation, taskCount: bridgeRuntime.stateCache.snapshot().tasks.length, screen };
    });

    await runStep(report, 'ui.approvals-refresh', async () => {
      const activation = await openDeepLink(serial, packageName, 'jarvis://approvals/refresh');
      const approval = await waitForRuntime('approval cached', () => {
        const first = [...bridgeRuntime.coreFacade.tasks.values()][0]?.approvalCard;
        return first?.approvalId ? first : null;
      });
      if (!approval.matched) throw new Error('live approval was not available in runtime');
      const row = await waitForXml(serial, artifactDir, 'live-approval-row', (xml) => Boolean(findNodeByResourcePrefix(xml, 'approval-row-')));
      if (!row.matched) throw new Error('live approval row was not rendered');
      return { activation, approval: approval.value, row };
    });

    await runStep(report, 'ui.approval-open', async () => {
      const approvalId = [...bridgeRuntime.coreFacade.tasks.values()][0]?.approvalCard?.approvalId;
      const activation = await openDeepLink(serial, packageName, `jarvis://approval/open?approvalId=${encodeURIComponent(approvalId ?? '')}`);
      const screen = await waitForXml(serial, artifactDir, 'approval-detail', (xml) => xml.includes('screen-content-ApprovalDetailScreen'));
      if (!screen.matched) throw new Error('ApprovalDetailScreen not visible');
      return { activation, screen };
    });

    await runStep(report, 'ui.approval-decision', async () => {
      const activation = await openDeepLink(serial, packageName, 'jarvis://approval/approve');
      const runtime = await waitForRuntime('task approved', () => {
        const task = [...bridgeRuntime.coreFacade.tasks.values()].find((item) => item.status === 'APPROVED');
        return task ? { taskId: task.taskId, status: task.status, approvalId: task.approvalCard.approvalId } : null;
      });
      if (!runtime.matched) throw new Error('ApprovalDecision did not approve a live task');
      const screen = await waitForXml(serial, artifactDir, 'task-status-after-approval', (xml) => xml.includes('screen-content-TaskStatusScreen'));
      if (!screen.matched) throw new Error('TaskStatusScreen not visible after approval decision');
      return { activation, runtime: runtime.value, screen };
    });

    await runStep(report, 'secure-store.restore-after-relaunch', async () => {
      const launch = await launchApp(serial, packageName, { clearData: false });
      if (!launch.success) throw new Error(`relaunch failed: ${launch.output}`);
      await scrollToTop(serial);
      const screen = await waitForXml(serial, artifactDir, 'secure-store-restored', (xml) => (
        xml.includes('paired') && xml.includes('yes') && xml.includes('screen-content-PairingScreen')
      ), { timeoutMs: 14_000 });
      if (!screen.matched) throw new Error('SecureStore token restore was not visible after relaunch');
      return { launch, screen };
    });

    await runStep(report, 'ui.device-revoke-disconnect', async () => {
      await scrollToTop(serial);
      const settingsTap = await openDeepLink(serial, packageName, 'jarvis://route/SettingsScreen');
      const settingsScreen = await waitForXml(serial, artifactDir, 'settings-screen-for-revoke', (xml) => xml.includes('screen-content-SettingsScreen'));
      if (!settingsScreen.matched) throw new Error('SettingsScreen not visible before disconnect');
      const disconnectTap = await openDeepLink(serial, packageName, 'jarvis://device/disconnect');
      const revoked = await waitForRuntime('device revoked', () => bridgeRuntime.registry.list().every((device) => device.status !== 'active'));
      if (!revoked.matched) throw new Error('device was not revoked in D Bridge runtime');
      const pairingScreen = await waitForXml(serial, artifactDir, 'pairing-after-disconnect', isUnpairedPairingScreen, { timeoutMs: 14_000 });
      if (!pairingScreen.matched) throw new Error('PairingScreen did not show unpaired state after disconnect');
      return { settingsTap, disconnectTap, pairingScreen, devices: bridgeRuntime.registry.list() };
    });

    await runStep(report, 'secure-store.cleanup-after-relaunch', async () => {
      const launch = await launchApp(serial, packageName, { clearData: false });
      if (!launch.success) throw new Error(`cleanup relaunch failed: ${launch.output}`);
      await scrollToTop(serial);
      const screen = await waitForXml(serial, artifactDir, 'secure-store-cleaned', isUnpairedPairingScreen, { timeoutMs: 14_000 });
      if (!screen.matched) throw new Error('SecureStore token cleanup was not visible after relaunch');
      return { launch, screen };
    });

    const serialSafe = sanitizeSerial(serial);
    const screenshot = await captureScreenshot(serial, join(artifactDir, `${serialSafe}-final.png`)).catch((error) => ({
      outputPath: join(artifactDir, `${serialSafe}-final.png`),
      bytes: 0,
      hasPngHeader: false,
      error: error.code ?? error.message
    }));
    report.runtime = runtimeSnapshot(bridgeRuntime);
    report.artifacts.finalScreenshot = screenshot;
    report.actualDeviceVerified = true;
    report.liveBridgeVerified = report.steps.some((step) => step.id === 'ui.pairing-confirm' && step.status === 'passed')
      && report.steps.some((step) => step.id === 'ui.task-create' && step.status === 'passed')
      && report.steps.some((step) => step.id === 'ui.approval-decision' && step.status === 'passed');
    report.secureStoreRestoreVerified = report.steps.some((step) => step.id === 'secure-store.restore-after-relaunch' && step.status === 'passed');
    report.deviceRevokeVerified = report.steps.some((step) => step.id === 'ui.device-revoke-disconnect' && step.status === 'passed')
      && report.runtime.health.pairedDevices === 0;
    report.secureStoreCleanupVerified = report.steps.some((step) => step.id === 'secure-store.cleanup-after-relaunch' && step.status === 'passed');
    report.status = report.liveBridgeVerified
      && report.secureStoreRestoreVerified
      && report.deviceRevokeVerified
      && report.secureStoreCleanupVerified
      ? 'passed'
      : 'product-readiness-blocked';
    report.reason = report.status === 'passed' ? null : 'live-bridge-securestore-or-revoke-contract-not-verified';
    return report;
  } catch (error) {
    report.status = report.steps.some((step) => step.id === 'adb.ready-device' && step.status === 'passed')
      ? 'failed'
      : 'blocked';
    report.reason = error.code ?? error.message;
    report.runtime = runtimeSnapshot(bridgeRuntime);
    return report;
  } finally {
    await close(server);
  }
}

export function renderMobileLiveBridgeE2EMarkdown(report) {
  const lines = [
    '# JARVIS Mobile Live Bridge E2E',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Reason: ${report.reason ?? 'none'}`,
    `Device: ${report.device?.serial ?? 'none'}`,
    `Bridge: ${report.bridge.localUrl} / emulator ${report.bridge.emulatorUrl}`,
    `Live bridge verified: ${report.liveBridgeVerified}`,
    `SecureStore restore verified: ${report.secureStoreRestoreVerified}`,
    `Device revoke verified: ${report.deviceRevokeVerified}`,
    `SecureStore cleanup verified: ${report.secureStoreCleanupVerified}`,
    '',
    '## Steps'
  ];
  for (const step of report.steps) {
    lines.push(`- ${step.id}: ${step.status} (${step.durationMs}ms)`);
  }
  lines.push('', '## Runtime');
  lines.push(`- pairedDevices: ${report.runtime?.health?.pairedDevices ?? 0}`);
  lines.push(`- cachedTasks: ${report.runtime?.cache?.tasks?.length ?? 0}`);
  lines.push(`- approvedTasks: ${(report.runtime?.tasks ?? []).filter((task) => task.status === 'APPROVED').length}`);
  lines.push(`- eventCount: ${report.runtime?.events?.eventCount ?? 0}`);
  return `${lines.join('\n')}\n`;
}

export async function writeMobileLiveBridgeE2EArtifacts(report, {
  jsonPath = 'dist/mobile-live-bridge-e2e-report.json',
  markdownPath = 'dist/mobile-live-bridge-e2e-report.md'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderMobileLiveBridgeE2EMarkdown(report), 'utf8');
  return { jsonPath, markdownPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMobileLiveBridgeE2E();
  const artifacts = await writeMobileLiveBridgeE2EArtifacts(report);
  console.log('# JARVIS Mobile Live Bridge E2E');
  console.log(`Status: ${report.status}`);
  console.log(`Reason: ${report.reason ?? 'none'}`);
  console.log(`Live bridge verified: ${report.liveBridgeVerified}`);
  console.log(`SecureStore restore verified: ${report.secureStoreRestoreVerified}`);
  console.log(`Device revoke verified: ${report.deviceRevokeVerified}`);
  console.log(`SecureStore cleanup verified: ${report.secureStoreCleanupVerified}`);
  console.log(`Reports: ${artifacts.jsonPath}, ${artifacts.markdownPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
