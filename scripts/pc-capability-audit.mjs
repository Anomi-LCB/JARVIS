import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import {
  WindowsOcrContextProvider,
  WindowsUiAutomationContextProvider
} from '../packages/core/src/context/context-snapshot.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';

const reportPath = resolve(readFlag('--report') ?? 'dist/verification/pc-capability-audit.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = resolve(dirname(reportPath), 'pc-capability-audit-runs', runId);
const workspace = join(runRoot, 'workspace');
const auditRoot = join(runRoot, 'audit');
const startedAt = new Date();

await mkdir(workspace, { recursive: true });
await mkdir(auditRoot, { recursive: true });
process.env.JARVIS_BACKUP_DIR = join(runRoot, 'backups');
process.env.JARVIS_MACRO_PATH = join(runRoot, 'macros.json');
process.env.JARVIS_BROWSER_DRIVER = '1';

const runtime = createAgRuntime({
  allowedRoots: [workspace],
  auditRoot,
  cwd: () => workspace,
  env: {},
  workerDaemonEnabled: false
});
const { pcAgent, policyRuntime } = runtime;
const scenarios = [];
let sequence = 0;

const appRegistration = probeComRegistration();
const uiContext = new WindowsUiAutomationContextProvider({ timeoutMs: 3000 }).collect({ allowAppTitles: false });
const ocrContext = new WindowsOcrContextProvider({ timeoutMs: 3000 }).collect({ allowScreenOcr: true });

const notePath = join(workspace, 'inbox', 'voice-note.txt');
const createNote = await executeAction({
  id: 'text-create',
  label: 'Create a text artifact',
  actionType: ActionType.CREATE_FILE,
  toolName: 'filesystem.createTextFile',
  args: {
    path: notePath,
    content: 'JARVIS PC capability audit voice-note fixture.'
  }
});
record('text-create', 'verified', succeeded(createNote.result) && await fileExists(notePath), {
  durationMs: createNote.durationMs,
  artifact: await fileEvidence(notePath),
  rollbackAvailable: createNote.result?.executionResult?.rollbackAvailable === true
});

const replayStarted = performance.now();
const replay = await pcAgent.receiveExecutionPacket(createNote.packet);
record('packet-idempotency', 'verified', replay.idempotentReplay === true && replay.status === TaskStatus.COMPLETED, {
  durationMs: round(performance.now() - replayStarted),
  duplicateMutationPrevented: replay.idempotentReplay === true
});

const listResult = await executeAction({
  id: 'file-list',
  label: 'List workspace files',
  actionType: ActionType.LIST_FILES,
  toolName: 'filesystem.listFiles',
  args: { directory: dirname(notePath), maxItems: 20 }
});
record('file-list', 'verified', succeeded(listResult.result)
  && listResult.result.executionResult?.listedItems?.some((item) => item.name === 'voice-note.txt'), {
  durationMs: listResult.durationMs,
  itemCount: listResult.result.executionResult?.listedItems?.length ?? 0,
  metadataOnly: true
});

const workbookPath = join(workspace, 'monthly-operations.xlsx');
const workbookResult = await executeAction({
  id: 'excel-create',
  label: 'Create a structured Excel workbook',
  actionType: ActionType.CREATE_FILE,
  toolName: 'excel.createWorkbook',
  args: {
    outputPath: workbookPath,
    sheetName: 'Operations',
    columns: ['Task', 'Progress', 'Owner'],
    rows: [
      ['Voice command intake', 80, 'JARVIS'],
      ['PC execution verification', 100, 'JARVIS'],
      ['Wearable field validation', 20, 'Operator']
    ],
    charts: [{ type: 'bar', title: 'Progress', categoryColumn: 'Task', valueColumn: 'Progress' }]
  }
});
record('excel-create', 'verified', succeeded(workbookResult.result) && await fileExists(workbookPath), {
  durationMs: workbookResult.durationMs,
  artifact: await fileEvidence(workbookPath),
  workbook: workbookResult.result.executionResult?.evidence?.workbook ?? null
});

const editResult = await executeAction({
  id: 'excel-edit',
  label: 'Edit a precise Excel cell',
  actionType: ActionType.EDIT_DOCUMENT,
  toolName: 'document.edit',
  args: {
    targetPath: workbookPath,
    sheet: 'Operations',
    edits: [{ cell: 'B2', value: 95 }]
  }
});
const editedCell = await readWorkbookCell(workbookPath, 'Operations', 'B2');
const editRollbackStarted = performance.now();
const editRollback = succeeded(editResult.result) ? await pcAgent.rollbackTask(editResult.packet.taskId) : null;
const restoredCell = await readWorkbookCell(workbookPath, 'Operations', 'B2');
record('excel-edit', 'verified', succeeded(editResult.result)
  && Number(editedCell) === 95
  && editRollback?.success === true
  && Number(restoredCell) === 80, {
  durationMs: round(editResult.durationMs + (performance.now() - editRollbackStarted)),
  editedCell: 'B2',
  editedValueMatched: Number(editedCell) === 95,
  rollbackRestoredOriginal: Number(restoredCell) === 80,
  backupCreated: Boolean(editResult.result.executionResult?.backupPath),
  runtimeUndoJournalRecorded: Boolean(editResult.result.executionResult?.undoJournalId)
});

const moveTarget = join(workspace, 'archive', 'voice-note.txt');
const moveResult = await executeAction({
  id: 'file-move',
  label: 'Move a file with rollback evidence',
  actionType: ActionType.MOVE_FILE,
  toolName: 'filesystem.moveFiles',
  args: { from: notePath, to: moveTarget }
});
const moved = succeeded(moveResult.result) && await fileExists(moveTarget) && !(await fileExists(notePath));
const rollbackStarted = performance.now();
const rollback = moved ? await pcAgent.rollbackTask(moveResult.packet.taskId) : null;
const rollbackRestored = rollback?.success === true && await fileExists(notePath) && !(await fileExists(moveTarget));
record('file-move-rollback', 'verified', moved && rollbackRestored, {
  durationMs: round(moveResult.durationMs + (performance.now() - rollbackStarted)),
  moved,
  rollbackRestored,
  transactionStatus: rollback?.transaction?.status ?? null
});

const shellResult = await executeAction({
  id: 'shell-readonly',
  label: 'Run and verify a safe PowerShell command',
  actionType: ActionType.SHELL_EXECUTE,
  toolName: 'shell.execute',
  args: {
    command: '[Environment]::OSVersion.VersionString',
    verifyCommand: '$true',
    rawText: 'Windows operating system information'
  }
});
record('shell-readonly', 'verified', succeeded(shellResult.result)
  && shellResult.result.executionResult?.exitCode === 0
  && shellResult.result.executionResult?.verification?.verified === true, {
  durationMs: shellResult.durationMs,
  readOnly: shellResult.result.executionResult?.readOnly === true,
  exitCode: shellResult.result.executionResult?.exitCode,
  selfVerified: shellResult.result.executionResult?.verification?.verified === true
});

const guiShadow = await executeAction({
  id: 'gui-automation-shadow',
  label: 'Preview a GUI automation command without launching it',
  actionType: ActionType.SHELL_EXECUTE,
  toolName: 'shell.execute',
  mode: 'shadow',
  args: {
    command: 'Start-Process notepad.exe; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("JARVIS")',
    rawText: 'Open Notepad and type JARVIS'
  }
});
record('gui-automation-shadow', 'conditional', shadowed(guiShadow.result)
  && guiShadow.result.shadow?.riskLevel === 'caution', {
  durationMs: guiShadow.durationMs,
  executionAttempted: false,
  riskLevel: guiShadow.result.shadow?.riskLevel ?? null,
  strongVisualClosedLoop: false
});

const browserResult = await executeAction({
  id: 'browser-readonly-search',
  label: 'Run a read-only browser research capture',
  actionType: ActionType.BROWSER_SEARCH,
  toolName: 'browser.search',
  args: { query: 'Windows PowerShell documentation', searchEngine: 'bing', maxResults: 3, readOnly: true }
});
record('browser-readonly-search', 'verified', succeeded(browserResult.result)
  && browserResult.result.executionResult?.readOnly === true
  && browserResult.result.executionResult?.search?.liveCapture?.live === true, {
  durationMs: browserResult.durationMs,
  liveCapture: browserResult.result.executionResult?.search?.liveCapture ?? null,
  resultCount: browserResult.result.executionResult?.search?.resultPreview?.length ?? 0,
  sideEffectsAllowed: false
});

const wordPath = join(workspace, 'operations-brief.docx');
if (appRegistration.word) {
  const wordResult = await executeAction({
    id: 'word-create',
    label: 'Create a native Word document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'word.create',
    args: {
      path: wordPath,
      title: 'JARVIS Operations Brief',
      blocks: [
        { type: 'heading', level: 1, text: 'Readiness' },
        { type: 'paragraph', text: 'This document was authored by the PC capability audit.' },
        { type: 'bullets', items: ['Voice intake', 'Guarded execution', 'Artifact verification'] }
      ]
    }
  });
  record('word-create', 'host-dependent', succeeded(wordResult.result) && await fileExists(wordPath), {
    durationMs: wordResult.durationMs,
    artifact: await fileEvidence(wordPath),
    adapterStatus: wordResult.result.executionResult?.status ?? null,
    runtimeUndoJournalRecorded: Boolean(wordResult.result.executionResult?.undoJournalId)
  });
} else {
  record('word-create', 'host-dependent', false, { reason: 'Word COM registration not found' });
}

const presentationPath = join(workspace, 'operations-brief.pptx');
if (appRegistration.powerpoint) {
  const presentationResult = await executeAction({
    id: 'powerpoint-create',
    label: 'Create a native PowerPoint deck',
    actionType: ActionType.CREATE_FILE,
    toolName: 'powerpoint.create',
    args: {
      path: presentationPath,
      deckTitle: 'JARVIS Operations Brief',
      slides: [
        { title: 'JARVIS Operations Brief', bullets: ['Voice-first guarded PC automation'] },
        { title: 'Verified workflow', bullets: ['Plan', 'Approve', 'Execute', 'Verify', 'Learn'] }
      ]
    }
  });
  record('powerpoint-create', 'host-dependent', succeeded(presentationResult.result) && await fileExists(presentationPath), {
    durationMs: presentationResult.durationMs,
    artifact: await fileEvidence(presentationPath),
    adapterStatus: presentationResult.result.executionResult?.status ?? null,
    runtimeUndoJournalRecorded: Boolean(presentationResult.result.executionResult?.undoJournalId)
  });
} else {
  record('powerpoint-create', 'host-dependent', false, { reason: 'PowerPoint COM registration not found' });
}

const hwpPath = join(workspace, 'operations-brief.hwp');
if (appRegistration.hwp) {
  const hwpResult = await executeAction({
    id: 'hwp-create',
    label: 'Create a native HWP document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'hwp.create',
    args: {
      path: hwpPath,
      title: 'JARVIS Operations Brief',
      blocks: [{ type: 'paragraph', text: 'This HWP file was authored by the guarded PC capability audit.' }]
    }
  });
  record('hwp-create', 'host-dependent', succeeded(hwpResult.result) && await fileExists(hwpPath), {
    durationMs: hwpResult.durationMs,
    registered: true,
    executionVerified: succeeded(hwpResult.result),
    artifact: await fileEvidence(hwpPath),
    runtimeUndoJournalRecorded: Boolean(hwpResult.result.executionResult?.undoJournalId),
    lastStep: hwpResult.result.executionResult?.evidence?.lastStep ?? null,
    pathApproval: hwpResult.result.executionResult?.evidence?.pathApproval ?? null,
    ownedProcessCleanup: hwpResult.result.executionResult?.evidence?.ownedProcessCleanup ?? null
  });
} else {
  record('hwp-create', 'host-dependent', false, {
    registered: false,
    executionVerified: false,
    reason: 'HWP COM registration not found.'
  });
}

const emailShadow = await executeAction({
  id: 'email-shadow',
  label: 'Preview an email transfer without sending',
  actionType: ActionType.SEND_EMAIL,
  toolName: 'email.send',
  mode: 'shadow',
  args: { to: 'audit@example.invalid', subject: 'JARVIS audit', body: 'No message is sent.' }
});
record('email-shadow', 'conditional', shadowed(emailShadow.result), {
  durationMs: emailShadow.durationMs,
  smtpConfigured: emailShadow.result.shadow?.smtpConfigured === true,
  externalTransferExecuted: false,
  desktopApprovalRequired: true
});

const outsidePath = resolve(workspace, '..', 'outside-allowed-root.txt');
const pathEscapeResult = await executeAction({
  id: 'path-escape-block',
  label: 'Block an allowed-root escape',
  actionType: ActionType.CREATE_FILE,
  toolName: 'filesystem.createTextFile',
  args: { path: outsidePath, content: 'must not be written' }
});
record('path-escape-block', 'safety', pathEscapeResult.result.status === TaskStatus.BLOCKED
  && !(await fileExists(outsidePath)), {
  durationMs: pathEscapeResult.durationMs,
  blockedReason: pathEscapeResult.result.blockedReason ?? null,
  outsideArtifactCreated: await fileExists(outsidePath)
});

const outsideNativePath = resolve(workspace, '..', 'outside-native-document.docx');
const nativePathGuardResult = await executeAction({
  id: 'native-document-path-guard',
  label: 'Block a native Office document outside allowed roots',
  actionType: ActionType.CREATE_FILE,
  toolName: 'word.create',
  args: { path: outsideNativePath, title: 'Must not be created', blocks: [] }
});
record('native-document-path-guard', 'safety', nativePathGuardResult.result.status === TaskStatus.BLOCKED
  && !(await fileExists(outsideNativePath)), {
  durationMs: nativePathGuardResult.durationMs,
  blockedReason: nativePathGuardResult.result.blockedReason ?? null,
  outsideArtifactCreated: await fileExists(outsideNativePath)
});

const deletePacket = {
  packetId: `packet_delete_${runId}`,
  taskId: `task_delete_${runId}`,
  planId: `plan_delete_${runId}`,
  action: {
    actionType: ActionType.DELETE_FILE,
    toolName: 'filesystem.deleteFile',
    arguments: { path: notePath }
  },
  capabilityToken: { tokenId: 'forbidden-delete-token' },
  requestedMode: 'execute',
  userConfirmation: { confirmed: true, approvalId: `approval_delete_${runId}` }
};
const deleteResult = await pcAgent.receiveExecutionPacket(deletePacket);
record('delete-hard-block', 'safety', deleteResult.status === TaskStatus.BLOCKED
  && deleteResult.blockedReason === 'B_FORBIDDEN_DESTRUCTIVE_ACTION'
  && await fileExists(notePath), {
  blockedReason: deleteResult.blockedReason,
  protectedArtifactStillExists: await fileExists(notePath)
});

record('desktop-window-context', 'conditional', uiContext.telemetry?.status === 'collected', {
  status: uiContext.telemetry?.status ?? null,
  openWindowCount: uiContext.openApps?.length ?? 0,
  titlesStored: false
});
record('screen-ocr-context', 'conditional', ocrContext.telemetry?.status === 'collected', {
  status: ocrContext.telemetry?.status ?? null,
  commandConfigured: Boolean(process.env.JARVIS_DESKTOP_OCR_COMMAND),
  screenMetadataCollected: Boolean(ocrContext.screen?.dimensions),
  ocrTextCollected: Boolean(ocrContext.screen?.ocrText)
});

const llmDiagnostics = await loadJson(resolve('dist/llm-provider-diagnostics.json'));
const complexBenchmark = await loadJson(resolve('dist/verification/voice-complex-workflow-benchmark.json'));
const desktopControlAudit = await loadJson(resolve('dist/verification/desktop-control-audit.json'));
const desktopControlChecks = desktopControlAudit?.checks ?? [];
const localOcrPerception = desktopControlAudit?.evidence?.localOcrPerception ?? null;
const localTemplatePerception = desktopControlAudit?.evidence?.localTemplatePerception ?? null;
const structuredDesktopReady = desktopControlAudit?.status === 'passed'
  && desktopControlChecks.length > 0
  && desktopControlChecks.every((item) => item.passed === true)
  && desktopControlAudit?.evidence?.taskStatus === TaskStatus.COMPLETED
  && desktopControlAudit?.evidence?.verification?.passed === true
  && desktopControlAudit?.evidence?.rawTypedValueStored === false;
const visualTextDesktopReady = structuredDesktopReady
  && localOcrPerception?.engine === 'Windows.Media.Ocr'
  && localOcrPerception?.matchCount === 1
  && localOcrPerception?.foregroundVerified === true
  && localOcrPerception?.screenshotStored === false
  && localOcrPerception?.rawOcrTextStored === false;
const templateIconDesktopReady = structuredDesktopReady
  && localTemplatePerception?.engine === 'Jarvis.LocalTemplateMatcher'
  && localTemplatePerception?.matchCount === 1
  && localTemplatePerception?.foregroundVerified === true
  && Number(localTemplatePerception?.confidence ?? 0) >= 0.9
  && localTemplatePerception?.screenshotStored === false
  && localTemplatePerception?.rawPixelsStored === false
  && localTemplatePerception?.templateCopied === false
  && desktopControlAudit?.evidence?.ambiguousTemplateControl?.error === 'desktop-visual-template-ambiguous'
  && desktopControlAudit?.evidence?.ambiguousTemplateControl?.mutationRecorded === false;
record('desktop-control-closed-loop', 'verified', structuredDesktopReady, {
  reportVersion: desktopControlAudit?.reportVersion ?? null,
  generatedAt: desktopControlAudit?.generatedAt ?? null,
  checkCount: desktopControlChecks.length,
  passedChecks: desktopControlChecks.filter((item) => item.passed).length,
  taskStatus: desktopControlAudit?.evidence?.taskStatus ?? null,
  operationCount: desktopControlAudit?.evidence?.operationCount ?? null,
  verificationPassed: desktopControlAudit?.evidence?.verification?.passed === true,
  rawTypedValueStored: desktopControlAudit?.evidence?.rawTypedValueStored ?? null,
  visualTextControlReady: visualTextDesktopReady,
  templateIconControlReady: templateIconDesktopReady,
  localOcrEngine: localOcrPerception?.engine ?? null,
  localOcrLanguage: localOcrPerception?.languageTag ?? null,
  screenshotStored: localOcrPerception?.screenshotStored ?? null,
  rawOcrTextStored: localOcrPerception?.rawOcrTextStored ?? null,
  localTemplateEngine: localTemplatePerception?.engine ?? null,
  localTemplateConfidence: localTemplatePerception?.confidence ?? null,
  ambiguousTemplateBlocked: desktopControlAudit?.evidence?.ambiguousTemplateControl?.error === 'desktop-visual-template-ambiguous',
  controlledUserApplication: false,
  dedicatedFixtureOnly: true
});
const requiredIds = [
  'text-create',
  'packet-idempotency',
  'file-list',
  'excel-create',
  'excel-edit',
  'file-move-rollback',
  'shell-readonly',
  'desktop-control-closed-loop',
  'browser-readonly-search',
  'path-escape-block',
  'native-document-path-guard',
  'delete-hard-block'
];
const required = scenarios.filter((item) => requiredIds.includes(item.id));
const requiredPassed = required.filter((item) => item.passed).length;
const reliableActionCount = scenarios.filter((item) => item.passed && item.classification === 'verified').length;
const nativeOfficePassed = scenarios.filter((item) => ['word-create', 'powerpoint-create', 'hwp-create'].includes(item.id) && item.passed).length;
const generalVisualDesktopReady = templateIconDesktopReady && Boolean(process.env.JARVIS_DESKTOP_VISION_COMMAND);
const autonomyLevel = visualTextDesktopReady ? 4 : 3;
const finishedAt = new Date();
const report = {
  reportVersion: 'b-pc-capability-field-audit-v2',
  generatedAt: finishedAt.toISOString(),
  status: requiredPassed === required.length ? 'passed-with-limitations' : 'failed',
  runId,
  runRoot,
  workspace,
  summary: {
    requiredPassed,
    requiredTotal: required.length,
    requiredPassRate: required.length ? round(requiredPassed / required.length) : 0,
    reliableActionCount,
    nativeOfficePassed,
    structuredDesktopControlReady: structuredDesktopReady,
    visualTextDesktopControlReady: visualTextDesktopReady,
    templateIconDesktopControlReady: templateIconDesktopReady,
    generalVisualDesktopReady,
    autonomyLevel,
    autonomyLabel: autonomyLevel >= 4 ? 'hybrid-uia-local-ocr-template-closed-loop-automation' : 'guarded-closed-loop-multi-tool-automation'
  },
  host: {
    platform: process.platform,
    node: process.version,
    comRegistration: appRegistration,
    smtpConfigured: Boolean(process.env.JARVIS_SMTP_USER && process.env.JARVIS_SMTP_PASS),
    desktopOcrConfigured: Boolean(process.env.JARVIS_DESKTOP_OCR_COMMAND)
  },
  planning: {
    llmIntentEnabled: envEnabled('JARVIS_LLM_INTENT'),
    llmPlannerEnabled: envEnabled('JARVIS_LLM_PLANNER'),
    llmContentEnabled: envEnabled('JARVIS_LLM_CONTENT'),
    providerStatus: llmDiagnostics?.status ?? 'not-measured',
    providerOrder: llmDiagnostics?.readiness?.providerOrder ?? [],
    liveProvider: llmDiagnostics?.liveProbe?.provider ?? null,
    liveModel: llmDiagnostics?.liveProbe?.model ?? null,
    liveLatencyMs: llmDiagnostics?.liveProbe?.latencyMs ?? null,
    openAiApiConfigured: llmDiagnostics?.readiness?.credentials?.openAiApiConfigured === true,
    anthropicApiConfigured: llmDiagnostics?.readiness?.credentials?.anthropicApiConfigured === true,
    rawCredentialStored: false
  },
  complexVoiceWorkflow: complexBenchmark ? {
    status: complexBenchmark.status,
    actionNodesPerTask: complexBenchmark.workload?.actionNodesPerTask ?? null,
    executionMedianMs: complexBenchmark.performance?.executionMedianMs ?? null,
    warmPlanningMedianMs: complexBenchmark.performance?.warmPlanningMedianMs ?? null,
    measuredPlanningSpeedup: complexBenchmark.performance?.measuredPlanningSpeedup ?? null,
    physicalMicrophoneIncluded: false
  } : { status: 'not-measured' },
  scenarios,
  limitations: [
    {
      id: 'structured-windows-ui-control',
      severity: 'high',
      ready: structuredDesktopReady,
      detail: 'Standard Windows controls with stable UI Automation selectors now support observe, act, and postcondition verification through desktop.control.'
    },
    {
      id: 'local-ocr-visual-text-control',
      severity: 'high',
      ready: visualTextDesktopReady,
      detail: 'Canvas-rendered text controls can be located with on-device Windows OCR, clicked only inside the verified foreground target window, and checked through explicit postconditions without storing pixels or OCR text.'
    },
    {
      id: 'trusted-template-icon-control',
      severity: 'high',
      ready: templateIconDesktopReady,
      detail: 'Icon-only controls with trusted workspace templates can be matched locally across DPI scale changes, rejected when ambiguous, clicked only in the verified foreground window, and checked through explicit postconditions without storing captured pixels.'
    },
    {
      id: 'general-gui-closed-loop',
      severity: 'high',
      ready: generalVisualDesktopReady,
      detail: 'UI Automation, canvas text, and trusted-template icons now have verified closed loops, but previously unseen icons, games, video, and remote-desktop surfaces still need an explicitly configured general vision provider.'
    },
    {
      id: 'cold-llm-latency',
      severity: 'high',
      ready: Number(llmDiagnostics?.liveProbe?.latencyMs ?? Infinity) < 5000,
      detail: 'Current external planning provider is a per-call CLI process unless a direct API credential is configured.'
    },
    {
      id: 'document-edit-undo-journal',
      severity: 'medium',
      ready: scenarios.find((item) => item.id === 'excel-edit')?.evidence?.runtimeUndoJournalRecorded === true,
      detail: 'Excel editing must create a verified backup, expose an undo-journal entry, and restore the original workbook through PC-Agent rollback.'
    },
    {
      id: 'hwp-host-safety',
      severity: 'medium',
      ready: scenarios.find((item) => item.id === 'hwp-create')?.passed === true
        && ['single-path', 'not-requested'].includes(scenarios.find((item) => item.id === 'hwp-create')?.evidence?.pathApproval?.approvalScope),
      detail: 'HWP authoring must approve only the exact output path, finish without terminating unrelated HWP processes, and leave rollback evidence.'
    },
    {
      id: 'native-document-undo-journal',
      severity: 'medium',
      ready: ['word-create', 'powerpoint-create', 'hwp-create']
        .filter((id) => scenarios.find((item) => item.id === id)?.passed)
        .every((id) => scenarios.find((item) => item.id === id)?.evidence?.runtimeUndoJournalRecorded === true),
      detail: 'Every successful native document creation must expose a PC-Agent undo-journal entry.'
    },
    {
      id: 'external-app-actions',
      severity: 'medium',
      ready: false,
      detail: 'Browser search is intentionally read-only; arbitrary form submission, authenticated web actions, downloads, uploads, and payments are not enabled.'
    }
  ],
  privacy: {
    rawVoiceAudioStored: false,
    windowTitlesStored: false,
    rawCredentialsStored: false,
    externalEmailSent: false,
    userFilesModified: false,
    userApplicationsControlled: false,
    dedicatedDesktopFixtureOnly: true,
    dedicatedWorkspaceOnly: true
  },
  durationMs: finishedAt.getTime() - startedAt.getTime()
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, renderMarkdown(report), 'utf8');
process.stdout.write(`${JSON.stringify({
  status: report.status,
  reportPath,
  markdownPath,
  summary: report.summary,
  planning: report.planning,
  failedRequired: required.filter((item) => !item.passed).map((item) => item.id),
  limitations: report.limitations.filter((item) => !item.ready).map((item) => item.id)
}, null, 2)}\n`);
if (report.status === 'failed') process.exitCode = 1;

async function executeAction({ id, label, actionType, toolName, args, mode = 'execute' }) {
  sequence += 1;
  const taskId = `task_pc_audit_${sequence}_${runId}`;
  const planId = `plan_pc_audit_${sequence}_${runId}`;
  const approvalId = `approval_pc_audit_${sequence}_${runId}`;
  const action = {
    actionType,
    toolName,
    skillId: `pc.audit.${id}`,
    arguments: args
  };
  const capabilityToken = policyRuntime.capabilities.issue({
    taskId,
    planId,
    approvalId,
    action,
    allowedPaths: [workspace]
  });
  if (capabilityToken?.success === false || !capabilityToken?.tokenId) {
    throw new Error(`capability-issue-failed:${id}:${capabilityToken?.error?.code ?? 'unknown'}`);
  }
  const packet = {
    packetId: `packet_pc_audit_${sequence}_${runId}`,
    taskId,
    planId,
    action,
    capabilityToken,
    requestedMode: mode,
    userConfirmation: { confirmed: true, approvalId },
    approvalDecision: { approvalId, decision: 'approve' },
    traceId: `trace_pc_audit_${sequence}_${runId}`
  };
  const started = performance.now();
  const result = await pcAgent.receiveExecutionPacket(packet);
  return { id, label, packet, result, durationMs: round(performance.now() - started) };
}

function record(id, classification, passed, evidence = {}) {
  scenarios.push({ id, classification, passed: passed === true, evidence });
}

function succeeded(result) {
  return result?.status === TaskStatus.COMPLETED && result?.executionResult?.status === 'success';
}

function shadowed(result) {
  return result?.status === TaskStatus.VERIFYING && result?.shadow?.mode === 'shadow';
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileEvidence(path) {
  if (!(await fileExists(path))) return null;
  const [info, content] = await Promise.all([stat(path), readFile(path)]);
  return {
    relativePath: relative(workspace, path),
    size: info.size,
    sha256: createHash('sha256').update(content).digest('hex')
  };
}

async function readWorkbookCell(path, sheetName, cellAddress) {
  try {
    const imported = await import('../apps/pc-agent/node_modules/exceljs/excel.js');
    const ExcelJS = imported.default ?? imported;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    return workbook.getWorksheet(sheetName)?.getCell(cellAddress)?.value ?? null;
  } catch {
    return null;
  }
}

function probeComRegistration() {
  if (process.platform !== 'win32') return { excel: false, word: false, powerpoint: false, hwp: false };
  const script = [
    '$ids = @{ excel = "Excel.Application"; word = "Word.Application"; powerpoint = "PowerPoint.Application"; hwp = "HWPFrame.HwpObject" }',
    '$out = @{}',
    'foreach ($entry in $ids.GetEnumerator()) { $out[$entry.Key] = ([System.Type]::GetTypeFromProgID($entry.Value) -ne $null) }',
    '$out | ConvertTo-Json -Compress'
  ].join('; ');
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true
    }));
  } catch {
    return { excel: false, word: false, powerpoint: false, hwp: false };
  }
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function envEnabled(name) {
  return ['1', 'true'].includes(String(process.env[name] ?? '').toLowerCase());
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function renderMarkdown(report) {
  const rows = report.scenarios.map((item) => (
    `| ${item.id} | ${item.classification} | ${item.passed ? 'PASS' : 'LIMITED'} |`
  )).join('\n');
  const limits = report.limitations.map((item) => (
    `- ${item.id}: ${item.ready ? 'ready' : item.severity} - ${item.detail}`
  )).join('\n');
  return `# JARVIS PC Capability Audit\n\n`
    + `- Status: **${report.status}**\n`
    + `- Autonomy: **Level ${report.summary.autonomyLevel} - ${report.summary.autonomyLabel}**\n`
    + `- Required checks: **${report.summary.requiredPassed}/${report.summary.requiredTotal}**\n`
    + `- Reliable actions verified: **${report.summary.reliableActionCount}**\n`
    + `- Native Office adapters verified: **${report.summary.nativeOfficePassed}**\n`
    + `- Structured Windows control: **${report.summary.structuredDesktopControlReady ? 'verified' : 'not verified'}**\n`
    + `- Canvas text control (local OCR): **${report.summary.visualTextDesktopControlReady ? 'verified' : 'not verified'}**\n`
    + `- Trusted-template icon control: **${report.summary.templateIconDesktopControlReady ? 'verified' : 'not verified'}**\n`
    + `- Current live LLM latency: **${report.planning.liveLatencyMs ?? 'not measured'} ms**\n\n`
    + `| Scenario | Classification | Result |\n|---|---|---|\n${rows}\n\n`
    + `## Limitations\n\n${limits}\n`;
}
