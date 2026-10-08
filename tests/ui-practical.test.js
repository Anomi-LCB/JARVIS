import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('control center renders only the live practical surface and exposes honest release state', async () => {
  const [uiSource, serverSource] = await Promise.all([
    readFile('src/ui/app.js', 'utf8'),
    readFile('scripts/dev-server.mjs', 'utf8')
  ]);
  const renderBody = uiSource.match(/function render\(\{ preserveScroll = false \} = \{\}\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.match(renderBody, /renderLiveTopbar\(\)/);
  assert.match(renderBody, /renderLiveOperations\(\)/);
  assert.match(renderBody, /renderRoutineWorkspace\(\)/);
  assert.match(renderBody, /renderPracticalWorkspace\(\)/);
  assert.doesNotMatch(renderBody, /renderModuleTelemetry|renderDocumentStreams|renderTodayOpsPanel|renderConsoleCore/);
  assert.match(serverSource, /\/api\/local\/release-status/);
  assert.match(serverSource, /\/api\/local\/llm-status/);
  assert.match(serverSource, /\/api\/local\/support-bundle/);
  assert.match(serverSource, /JARVIS_BRIDGE_API_URL \?\? 'http:\/\/127\.0\.0\.1:17777'/);
  assert.match(serverSource, /pendingValidationCount/);
  assert.match(serverSource, /rawReportsExposed: false/);
  assert.match(uiSource, /renderLlmOperationalState\(\)/);
  assert.match(uiSource, /Claude 로그인 필요/);
  assert.match(uiSource, /diagnostic\?\.recovery\?\.command/);
  assert.match(uiSource, /class="system-diagnostics"/);
  assert.match(uiSource, /coreRequest\('\/routines(?:\/command)?'/);
  assert.match(uiSource, /createRoutineRequest\(controlCenter\.routinesDraft/);
  assert.match(uiSource, /friendlyOperationalError/);
  assert.doesNotMatch(uiSource, /\$\{action\}을 완료하지 못했습니다/);
  assert.match(uiSource, /data-run-support-diagnostic/);
  assert.match(uiSource, /jarvis-support-bundle\.json/);
  assert.match(uiSource, /AI 안경 화면·음성·연결 현장 확인/);
  assert.match(uiSource, /releaseValidationAction/);
  assert.doesNotMatch(uiSource, /<code>\$\{escapeHtml\(item\.command\)\}<\/code>/);
  assert.doesNotMatch(uiSource, /controlCenter\.lastError\s*=.*error\.message/);
  assert.match(uiSource, /renderInlineTaskApproval\(task\)/);
  assert.match(uiSource, /commandDraft/);
  assert.match(uiSource, /taskProgress\.scrollLeft = taskProgress\.scrollWidth/);
  const liveOperationsBody = uiSource.match(/function renderLiveOperations\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(liveOperationsBody, /renderServiceCard|renderReleaseState|renderLlmOperationalState/);
});

test('control center approval buttons use the shared lowercase decision contract', async () => {
  const uiSource = await readFile('src/ui/app.js', 'utf8');

  assert.match(uiSource, /data-task-decision="approve"/);
  assert.match(uiSource, /data-task-decision="reject"/);
  assert.doesNotMatch(uiSource, /data-task-decision="APPROVE"|data-task-decision="REJECT"/);
  assert.match(uiSource, /\['WAITING_APPROVAL', 'WAITING_INPUT', 'BLOCKED', 'REJECTED'\]/);
  assert.match(uiSource, /confirmed: false/);
  assert.match(uiSource, /const decidedTask = await coreRequest/);
});

test('completed tasks expose concise real execution results instead of lifecycle-only status', async () => {
  const uiSource = await readFile('src/ui/app.js', 'utf8');

  assert.match(uiSource, /renderTaskResult\(task\)/);
  assert.match(uiSource, /taskExecutionResult/);
  assert.match(uiSource, /result\.listedItems/);
  assert.match(uiSource, /result\.outputPaths/);
  assert.match(uiSource, /result\.changedItems/);
  assert.match(uiSource, /실제 실행 결과/);
  assert.match(uiSource, /executionVerification/);
  assert.match(uiSource, /selectedTaskId/);
  assert.match(uiSource, /\/tasks\/\$\{encodeURIComponent\(selectedTaskId\)\}/);
  assert.match(uiSource, /renderTaskRollback\(task, result\)/);
  assert.match(uiSource, /data-task-rollback-preview/);
  assert.match(uiSource, /data-task-rollback-confirm/);
  assert.match(uiSource, /\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/compensation\/plan/);
  assert.match(uiSource, /\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/compensation\/run/);
  assert.match(uiSource, /userConfirmation:[\s\S]*?confirmed: true/);
  assert.match(uiSource, /변경을 원래 상태로 되돌렸습니다/);
  assert.match(uiSource, /const TASK_CREATION_TIMEOUT_MS = 60_000/);
  assert.match(uiSource, /coreRequest\('\/tasks',[\s\S]*?timeoutMs: TASK_CREATION_TIMEOUT_MS/);
  assert.match(uiSource, /PLANNING: '계획 중'/);
  assert.match(uiSource, /COMPENSATING: '복구 중'/);
});

test('control center exposes durable mission execution and decision gates', async () => {
  const uiSource = await readFile('src/ui/app.js', 'utf8');

  assert.match(uiSource, /data-execution-mode="mission"/);
  assert.match(uiSource, /renderMissionTimeline\(controlCenter\.activeMission\)/);
  assert.match(uiSource, /coreRequest\('\/missions'/);
  assert.match(uiSource, /\/missions\/\$\{encodeURIComponent\(created\.missionId\)\}\/run/);
  assert.match(uiSource, /data-mission-gate-decision="approve"/);
  assert.match(uiSource, /data-mission-gate-decision="reject"/);
  assert.match(uiSource, /grants: \['read_only', 'local_reversible'\]/);
  assert.match(uiSource, /responseText/);
  assert.match(uiSource, /mission\.status === 'WAITING_APPROVAL'/);
  assert.match(uiSource, /selectMission\(created\.missionId\)/);
  assert.match(uiSource, /const selectedMissionId = controlCenter\.activeMissionId \?\? latestMissionId/);
  assert.match(uiSource, /missionSelection\.read\(missionSelectionScope\(\)\)/);
  assert.match(uiSource, /missionSelection\.write\(missionSelectionScope\(\), missionId\)/);
  assert.match(uiSource, /const latestMissionId = preferredMissionId\(controlCenter\.missions\)/);
  assert.match(uiSource, /cache: 'no-store'/);
  assert.match(uiSource, /method === 'GET' \? cacheBustedUrl\(url\) : url/);
  assert.match(uiSource, /_jarvis=/);
  assert.match(uiSource, /data-mission-cancel/);
  assert.match(uiSource, /data-mission-resume/);
  assert.match(uiSource, /계속 실행/);
  assert.match(uiSource, /cancelled-from-local-control-center/);
  assert.match(uiSource, /renderMissionGateAffectedDetails/);
  assert.match(uiSource, /gate\?\.type === 'external_data_egress'/);
  assert.match(uiSource, /전송 대상/);
  assert.match(uiSource, /자료 등급/);
  assert.match(uiSource, /전송 자료 식별값/);
  assert.match(uiSource, /내 구글 메일 연결 계정/);
  assert.match(uiSource, /missionChildTaskIds/);
  assert.match(uiSource, /mission-gate-details/);
  assert.match(uiSource, /SHA-256 확인됨/);
  assert.match(uiSource, /현재 확인된 상태의 위 파일 한 개를 한 번만 전송/);
  assert.match(uiSource, /SUCCEEDED: '완료'/);
  assert.match(uiSource, /SKIPPED: '건너뜀'/);
  assert.match(uiSource, /'email\.send': '메일 발송'/);
  assert.match(uiSource, /'weather\.createHwpReport': '주간 날씨 한글 보고서 생성'/);
  assert.match(uiSource, /practicalToolLabel\(action\.actualToolName/);
  assert.match(uiSource, /practicalToolLabel\(gate\.toolName/);
  assert.match(uiSource, /replaceAll\('Gmail', '구글 메일'\)/);
});

test('control center exposes a bounded personal owner session without hiding per-action safeguards', async () => {
  const uiSource = await readFile('src/ui/app.js', 'utf8');
  const styles = await readFile('src/ui/styles.css', 'utf8');

  assert.match(uiSource, /data-owner-session-toggle/);
  assert.match(uiSource, /role="switch"/);
  assert.match(uiSource, /\/owner-session\/activate/);
  assert.match(uiSource, /\/owner-session\/revoke/);
  assert.match(uiSource, /durationMinutes: 30/);
  assert.match(uiSource, /ownerSessionId/);
  assert.match(uiSource, /grants: \['read_only', 'local_reversible', 'high_impact'\]/);
  assert.match(uiSource, /외부 전송과 되돌릴 수 없는 작업은 계속 개별 확인/);
  assert.match(styles, /\.owner-session-toggle\.active/);
});

test('control center exposes fail-closed runtime trust controls without persisting operator secrets', async () => {
  const uiSource = await readFile('src/ui/app.js', 'utf8');
  const styles = await readFile('src/ui/styles.css', 'utf8');

  assert.match(uiSource, /coreRequest\('\/security\/trust'/);
  assert.match(uiSource, /\/security\/trust\/lockdown/);
  assert.match(uiSource, /\/security\/trust\/recovery\/challenge/);
  assert.match(uiSource, /\/security\/trust\/recover/);
  assert.match(uiSource, /\/security\/trust\/product-gate/);
  assert.match(uiSource, /긴급 잠금 확정/);
  assert.match(uiSource, /복구 승인/);
  assert.match(uiSource, /effectiveRuntimeTrust\(\)\?\.mode === 'lockdown'/);
  assert.match(uiSource, /incident\.status !== 'recovered'/);
  assert.match(uiSource, /heading: '최근 복구'/);
  assert.match(uiSource, /복구 완료/);
  assert.match(uiSource, /writeUiSecret\('jarvis\.coreAdminToken'/);
  assert.match(uiSource, /writeUiSecret\('jarvis\.pcAgentToken'/);
  assert.doesNotMatch(uiSource, /writeUiSetting\('jarvis\.coreAdminToken'/);
  assert.doesNotMatch(uiSource, /writeUiSetting\('jarvis\.pcAgentToken'/);
  assert.match(styles, /\.runtime-trust-panel/);
  assert.match(styles, /\.trust-actions \.lockdown\.armed/);
  assert.match(styles, /\.trust-reason\.recovered strong/);
});

test('mobile home command executes with one tap while the keyboard is open', async () => {
  const mobileSource = await readFile('apps/mobile/src/App.tsx', 'utf8');

  assert.match(mobileSource, /keyboardShouldPersistTaps="handled"/);
  assert.match(mobileSource, /keyboardDismissMode="on-drag"/);
  assert.match(mobileSource, /testID="home-command-input"/);
  assert.match(mobileSource, /testID="home-submit-button"[\s\S]*?onPress=\{\(\) => void homeSubmit\(\)\}/);
});
