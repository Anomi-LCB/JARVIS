import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createWearableApprovalState,
  createWearableBridgeSyncPlan,
  createWearableHudDeviceProfile,
  createWearableHudFrame,
  createWearableHudProductGate,
  createWearableHudReleaseDossier,
  createWearableVoiceIntent,
  renderWearableHudHtml,
  renderWearableHudText,
  wearableHudAdapterVersion
} from '../apps/wearable-hud/src/index.js';
import { writeWearableHudFieldKit } from './wearable-hud-field-kit.mjs';
import { runWearablePhysicalFieldGate } from './wearable-physical-field-gate.mjs';

const defaultJsonPath = 'dist/wearable-hud-verification-report.json';
const defaultMarkdownPath = 'dist/wearable-hud-verification-report.md';
const defaultHtmlPath = 'dist/wearable-hud-preview.html';

function workspacePath(workspaceRoot, path) {
  return resolve(workspaceRoot, path);
}

function check(id, passed, detail = {}, severity = 'blocking') {
  return {
    id,
    passed: Boolean(passed),
    severity,
    detail
  };
}

export async function runWearableHudVerification({
  workspaceRoot = process.cwd(),
  jsonPath = workspacePath(workspaceRoot, defaultJsonPath),
  markdownPath = workspacePath(workspaceRoot, defaultMarkdownPath),
  htmlPath = workspacePath(workspaceRoot, defaultHtmlPath)
} = {}) {
  const deviceProfile = createWearableHudDeviceProfile({
    deviceId: 'jarvis-glasses-field-001',
    modelName: 'jarvis-green-mono-ai-glasses'
  });
  const voiceIntent = createWearableVoiceIntent({
    transcript: '자비스, 오늘 회의 메모를 보고서로 만들어줘 token=super-secret-1234'
  });
  const approvalState = createWearableApprovalState({
    card: {
      approvalId: 'appr_glasses_high',
      taskId: 'task_glasses',
      riskTier: 3,
      summary: 'C:\\Users\\user\\secret\\contract.xlsx 파일 12개 이동 승인'
    },
    safety: {
      requiresPcConfirmation: true,
      affectedItemCount: 12,
      rollbackAvailable: true
    },
    session: {
      locked: false
    }
  });
  const frame = createWearableHudFrame({
    deviceProfile,
    mode: 'approval',
    connection: { connected: true },
    approval: approvalState,
    voiceIntent
  });
  const bridgeSyncPlan = createWearableBridgeSyncPlan({
    taskId: 'task_glasses',
    eventCursor: 'evt_1'
  });
  const html = renderWearableHudHtml(frame);
  const text = renderWearableHudText(frame);
  const productGate = createWearableHudProductGate({
    frame,
    voiceIntent,
    approvalState,
    bridgeSyncPlan,
    html
  });
  const fieldKit = await writeWearableHudFieldKit({
    workspaceRoot,
    bridgeUrl: bridgeSyncPlan.bridgeUrl
  });
  const physicalField = await runWearablePhysicalFieldGate({ workspaceRoot });
  const releaseDossier = createWearableHudReleaseDossier({
    frame,
    voiceIntent,
    approvalState,
    bridgeSyncPlan,
    checks: productGate.checks
  });

  const checks = [
    check('adapter:version', wearableHudAdapterVersion === 'c-d-wearable-hud-adapter-v1', {
      version: wearableHudAdapterVersion
    }),
    check('voice:wake-and-redaction', voiceIntent.activationDetected === true
      && voiceIntent.privacy.rawTranscriptStored === false
      && voiceIntent.privacy.redactionTypes.includes('token')
      && !voiceIntent.redactedPreview.includes('super-secret'), {
      activationDetected: voiceIntent.activationDetected,
      redactionTypes: voiceIntent.privacy.redactionTypes
    }),
    check('approval:high-risk-pc-handoff', approvalState.riskTier === 3
      && approvalState.actions.approve.enabled === false
      && approvalState.actions.pcHandoff.enabled === true, {
      riskTier: approvalState.riskTier,
      approveEnabled: approvalState.actions.approve.enabled,
      pcHandoffEnabled: approvalState.actions.pcHandoff.enabled
    }),
    check('frame:green-mono-contract', frame.display.palette === 'monochrome-green'
      && frame.lines.length <= frame.limits.maxLines
      && frame.lines.every((line) => line.text.length <= frame.limits.maxCharsPerLine), {
      palette: frame.display.palette,
      lineCount: frame.lines.length,
      maxCharsPerLine: frame.limits.maxCharsPerLine
    }),
    check('frame:operator-action-contract', frame.layoutContract.operatorFirst === true
      && frame.layoutContract.hidesImplementationModules === true
      && frame.actions.length >= 3
      && frame.actions.some((item) => /PC 확인|승인|녹음|캡처/.test(item.label))
      && frame.context.length >= 2
      && !html.includes('A-코어')
      && !html.includes('B-로컬')
      && !html.includes('D-브릿지'), {
      actionCount: frame.actions.length,
      contextCount: frame.context.length,
      operatorFirst: frame.layoutContract.operatorFirst
    }),
    check('bridge:sync-plan-safe', bridgeSyncPlan.endpoints.some((item) => item.path === '/approvals')
      && bridgeSyncPlan.endpoints.some((item) => item.id === 'events')
      && bridgeSyncPlan.endpoints.some((item) => item.id === 'task-status')
      && bridgeSyncPlan.privacy.rawBridgeTokenStored === false, {
      endpointCount: bridgeSyncPlan.endpoints.length,
      rawBridgeTokenStored: bridgeSyncPlan.privacy.rawBridgeTokenStored
    }),
    check('view:html-safe', html.includes('jarvis-wearable-hud-root')
      && html.includes('#00ff66')
      && !html.includes('Bearer ')
      && !html.includes('super-secret')
      && !html.includes('C:\\Users'), {
      rootPresent: html.includes('jarvis-wearable-hud-root'),
      greenPresent: html.includes('#00ff66')
    }),
    check('product:gate-passed', productGate.status === 'passed'
      && releaseDossier.status === 'passed'
      && releaseDossier.dossierSha256?.length === 64, {
      productGateStatus: productGate.status,
      releaseDossierStatus: releaseDossier.status,
      dossierSha256: releaseDossier.dossierSha256
    }),
    check('field-kit:browser-ready', fieldKit.status === 'passed'
      && fieldKit.productGate?.checks?.every((item) => item.passed), {
      status: fieldKit.status,
      outputDir: fieldKit.outputDir
    }),
    check('field:physical-gate-not-invalid', physicalField.status !== 'blocked', {
      status: physicalField.status,
      physicalValidationPassed: physicalField.physicalValidationPassed,
      evidenceState: physicalField.evidence.state
    }, 'operational')
  ];
  const status = checks.every((item) => item.passed) ? 'passed' : 'blocked';
  const report = {
    reportVersion: 'c-d-wearable-hud-verification-report-v1',
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      adapterVersion: wearableHudAdapterVersion,
      deviceModel: deviceProfile.modelName,
      displayPalette: frame.display.palette,
      lineCount: frame.lines.length,
      actionCount: frame.actions.length,
      contextCount: frame.context.length,
      operatorFirst: frame.layoutContract.operatorFirst,
      highRiskDirectApproveEnabled: approvalState.actions.approve.enabled,
      pcHandoffEnabled: approvalState.actions.pcHandoff.enabled,
      rawTranscriptStored: voiceIntent.privacy.rawTranscriptStored,
      rawBridgeTokenStored: bridgeSyncPlan.privacy.rawBridgeTokenStored,
      physicalFieldStatus: physicalField.status,
      physicalValidationPassed: physicalField.physicalValidationPassed
    },
    scenario: {
      deviceProfile,
      voiceIntent,
      approvalState,
      frame,
      bridgeSyncPlan,
      textPreview: text
    },
    fieldKit,
    physicalField,
    productGate,
    releaseDossier,
    checks,
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath),
      htmlPath: resolve(htmlPath),
      fieldKitDir: fieldKit.outputDir,
      physicalFieldJsonPath: physicalField.artifacts.jsonPath
    }
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(htmlPath, html, 'utf8');
  return report;
}

function renderMarkdown(report) {
  return [
    '# JARVIS Wearable HUD Verification',
    '',
    `Status: **${report.status}**`,
    `Adapter: ${report.summary.adapterVersion}`,
    `Device: ${report.summary.deviceModel}`,
    `Palette: ${report.summary.displayPalette}`,
    `HUD lines: ${report.summary.lineCount}`,
    `Operator actions: ${report.summary.actionCount}`,
    `Operator first: ${report.summary.operatorFirst}`,
    `High-risk direct approve: ${report.summary.highRiskDirectApproveEnabled ? 'enabled' : 'blocked'}`,
    `PC handoff: ${report.summary.pcHandoffEnabled ? 'enabled' : 'blocked'}`,
    `Raw transcript stored: ${report.summary.rawTranscriptStored}`,
    `Raw bridge token stored: ${report.summary.rawBridgeTokenStored}`,
    `Field kit: ${report.fieldKit.status}`,
    `Physical field gate: ${report.summary.physicalFieldStatus}`,
    `Physical validation passed: ${report.summary.physicalValidationPassed}`,
    '',
    '## Checks',
    '',
    '| Check | Passed | Severity |',
    '| --- | --- | --- |',
    ...report.checks.map((item) => `| ${item.id} | ${item.passed ? 'yes' : 'no'} | ${item.severity} |`),
    '',
    '## Text Preview',
    '',
    '```text',
    report.scenario.textPreview,
    '```',
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
    else if (arg === '--html') args.htmlPath = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runWearableHudVerification(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Wearable HUD Verification');
  console.log(`Status: ${report.status}`);
  console.log(`Adapter: ${report.summary.adapterVersion}`);
  console.log(`Palette: ${report.summary.displayPalette}`);
  console.log('Reports: dist/wearable-hud-verification-report.json, dist/wearable-hud-verification-report.md, dist/wearable-hud-preview.html');
  if (report.status === 'blocked') process.exitCode = 1;
}
