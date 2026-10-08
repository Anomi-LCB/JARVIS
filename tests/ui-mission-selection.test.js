import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createMissionSelection, preferredMissionId, missionProgressMessage, missionVerificationView } from '../src/ui/mission-view-state.js';

const source = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const scope = { endpoint: 'http://127.0.0.1:4317', conversationId: 'conversation-a' };
const blocked = { missionId: 'mission-old', status: 'BLOCKED', createdAt: '2026-09-08T01:00:00Z' };
const completed = { missionId: 'mission-new', status: 'COMPLETED', createdAt: '2026-09-08T02:00:00Z' };
function loadTimeline(context) {
  context.cancellationReviewPanel ??= { render: () => '' };
  context.controlCenter.goalRevisionDrafts ??= new Map();
  // Load the real new editor dependency, retaining the timeline's existing assertions.
  runInNewContext(source.slice(source.indexOf('function renderGoalRevisionEditor('), source.indexOf('async function prepareCommandOwnerSession('))
    + source.slice(source.indexOf('function renderMissionTimeline('), source.indexOf('function renderMissionGate(')), context);
}

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

function refreshHarness({ missions = [blocked, completed], activeMissionId = null, fetchMission, listError = null } = {}) {
  const store = storage();
  const context = {
    controlCenter: { coreBaseUrl: scope.endpoint, pcBaseUrl: 'http://pc', bridgeBaseUrl: 'http://bridge',
      coreTasks: [], missions, activeMissionId, activeMission: null, refreshing: false,
      coreAdminProxyConfigured: false, coreAdminToken: '' },
    controlCenterNetwork: { localApiBaseUrl: '' },
    conversationContext: { idFor: () => scope.conversationId },
    missionSelection: createMissionSelection({ storage: store }),
    preferredMissionId,
    render() {}, recordOperationalError() {}, clearOperationalError() {}, clearRecoveredConnectivityError() {},
    settledValue: (result) => result.status === 'fulfilled' ? result.value : null,
    settledError: (result) => result.status === 'rejected' ? result.reason : null,
    joinEndpoint: (base, path) => `${base}${path}`,
    requestJson: async () => ({}), localControlRequest: async () => ({}), pcRequest: async () => ({}),
    coreRequest: async (url) => {
      if (url === '/missions?limit=20') {
        if (listError) throw listError;
        return { items: missions };
      }
      if (url.startsWith('/missions/')) {
        const id = decodeURIComponent(url.slice('/missions/'.length));
        return fetchMission ? fetchMission(id) : missions.find((mission) => mission.missionId === id);
      }
      return {};
    }
  };
  const selectionFunctions = source.slice(source.indexOf('function missionSelectionScope()'), source.indexOf('function composeState('));
  const coreAdminAccessFunction = source.slice(source.indexOf('function hasCoreAdminAccess('), source.indexOf('function settledValue('));
  const refreshFunction = source.slice(source.indexOf('async function refreshLiveState('), source.indexOf('async function runSupportDiagnostic('));
  runInNewContext(`${selectionFunctions}\n${coreAdminAccessFunction}\n${refreshFunction}`, context);
  return context;
}

test('latest goal wins fallback regardless of older blocked or approval status and list order', () => {
  assert.equal(preferredMissionId([blocked, completed]), completed.missionId);
  assert.equal(preferredMissionId([completed, { ...blocked, status: 'WAITING_APPROVAL' }]), completed.missionId);
  assert.equal(preferredMissionId([]), null);
});

test('selected goal survives a reload and stays isolated by endpoint and conversation', () => {
  const sharedStorage = storage();
  createMissionSelection({ storage: sharedStorage }).write(scope, completed.missionId);
  const reloaded = createMissionSelection({ storage: sharedStorage });
  assert.equal(reloaded.read(scope), completed.missionId);
  assert.equal(reloaded.read({ ...scope, endpoint: `${scope.endpoint}/` }), completed.missionId);
  assert.equal(reloaded.read({ ...scope, endpoint: 'http://127.0.0.1:9999' }), null);
  assert.equal(reloaded.read({ ...scope, conversationId: 'conversation-b' }), null);
  reloaded.write(scope, null);
  assert.equal(createMissionSelection({ storage: sharedStorage }).read(scope), null);
});

test('unavailable browser storage keeps in-page selection without throwing', () => {
  const unavailable = { getItem() { throw Error('unavailable'); }, setItem() { throw Error('unavailable'); }, removeItem() { throw Error('unavailable'); } };
  const selection = createMissionSelection({ storage: unavailable });
  assert.equal(selection.read(scope), null);
  assert.equal(selection.write(scope, completed.missionId), completed.missionId);
  assert.equal(selection.read(scope), completed.missionId);
});

test('real refresh function retains restored completed selection over older blocked goals', async () => {
  const context = refreshHarness({ activeMissionId: completed.missionId });
  await context.refreshLiveState({ silent: true });
  assert.equal(context.controlCenter.activeMission.missionId, completed.missionId);
  assert.equal(context.missionSelection.read(scope), completed.missionId);
});

test('real refresh loads selected goal directly when it is outside the recent list', async () => {
  const context = refreshHarness({ missions: [blocked], activeMissionId: completed.missionId, fetchMission: async (id) => {
    assert.equal(id, completed.missionId);
    return completed;
  } });
  await context.refreshLiveState({ silent: true });
  assert.equal(context.controlCenter.activeMissionId, completed.missionId);
  assert.equal(context.controlCenter.activeMission, completed);
});

test('transient list or detail failure does not discard the selected goal', async () => {
  const context = refreshHarness({ activeMissionId: completed.missionId, listError: Error('temporary'), fetchMission: async () => { throw Error('temporary'); } });
  context.controlCenter.activeMission = completed;
  await context.refreshLiveState({ silent: true });
  assert.equal(context.controlCenter.activeMissionId, completed.missionId);
  assert.equal(context.controlCenter.activeMission, completed);
});

test('a removed selected goal falls back only after explicit not-found response', async () => {
  const context = refreshHarness({ activeMissionId: 'removed-mission', fetchMission: async () => { throw Object.assign(Error('missing'), { status: 404 }); } });
  await context.refreshLiveState({ silent: true });
  assert.equal(context.controlCenter.activeMissionId, completed.missionId);
  assert.equal(context.missionSelection.read(scope), completed.missionId);
});

test('an older in-flight detail response cannot replace a newly selected mission', async () => {
  let finish;
  const context = refreshHarness({ activeMissionId: blocked.missionId,
    fetchMission: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = context.refreshLiveState({ silent: true });
  await new Promise((resolve) => setImmediate(resolve));
  context.selectMission(completed.missionId);
  context.controlCenter.activeMission = completed;
  finish(blocked);
  await pending;
  assert.equal(context.controlCenter.activeMission, completed);
  assert.equal(context.missionSelection.read(scope), completed.missionId);
});

test('terminal or waiting missions with no actions never claim planning is in progress', () => {
  for (const status of ['BLOCKED', 'FAILED', 'CANCELLED', 'PAUSED', 'COMPLETED', 'WAITING_APPROVAL', 'WAITING_INPUT', 'CREATED']) {
    assert.doesNotMatch(missionProgressMessage({ status }), /다음 행동을 계획/);
  }
  for (const status of ['REGISTERED', 'RUNNING']) assert.match(missionProgressMessage({ status }), /다음 행동을 계획/);
  assert.match(missionProgressMessage({ status: 'BLOCKED', stopReason: 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED' }), /지원하지 않는 명령 표현.*문장을 수정/);
  assert.match(missionProgressMessage({ status: 'BLOCKED', stopReason: 'A_WORK_REFERENCE_STALE' }), /파일이 변경/);
});

test('real blocked timeline exposes the reason and does not render a planning placeholder', () => {
  const context = { missionProgressMessage, missionVerificationView, controlCenter: { goalRevisionDrafts: new Map() }, escapeHtml: (value) => String(value ?? ''),
    renderRememberedFile: () => '', liveStatusClass: () => 'down', practicalStatusLabel: (status) => status };
  const timeline = source.slice(source.indexOf('function renderMissionTimeline('), source.indexOf('function renderMissionGate('));
  loadTimeline(context);
  const html = context.renderMissionTimeline({ ...blocked, waves: [], stopReason: 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED' });
  assert.match(html, /지원하지 않는 명령 표현/);
  assert.match(html, /중단 사유/);
  assert.doesNotMatch(html, /다음 행동을 계획/);
});

test('mission verification display never upgrades executions, legacy records or unknown effects into verified completion', () => {
  assert.equal(missionVerificationView({ status: 'COMPLETED', completion: { criteria: [{ statement: '합계 확인' }] } }).label, '이전 기준 완료');
  assert.equal(missionVerificationView({ status: 'COMPLETED', verificationStatus: 'unverified',
    verificationSummary: { version: 'legacy', criteria: [] } }).label, '이전 기준 완료');
  const mission = { status: 'PAUSED', stopReason: 'verification-incomplete', verificationStatus: 'unverified',
    metrics: { successfulActions: 10 }, verificationSummary: { criteria: [
      { criterionId: 'sum', statement: '합계가 정확하다', status: 'unverified' },
      { criterionId: 'file', statement: '파일이 생성되었다', status: 'passed' }
    ] } };
  assert.equal(missionVerificationView(mission).verified, false);
  assert.equal(missionVerificationView(mission).verifiedCount, 1);
  assert.equal(missionVerificationView(mission).totalCount, 2);
  assert.equal(missionVerificationView(mission).label, '검증 대기');
  assert.match(missionProgressMessage(mission), /모두 검증하지 못/);
  assert.equal(missionVerificationView({ ...mission, status: 'COMPLETED', verificationStatus: 'passed', uncertainEffectCount: 1 }).label, '결과 확인 중');
  assert.match(missionProgressMessage({ ...mission, stopReason: 'reconciliation-required' }), /중복 실행/);
});

test('Korean Core mission identities survive selection reload without allowing markup or path separators', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const scope = { endpoint: 'http://127.0.0.1:4071', conversationId: 'fixture-ko' };
  const missionId = 'mission_원문을-읽어-초안을-저장해-1_fixture';
  assert.equal(createMissionSelection({ storage }).write(scope, missionId), missionId);
  assert.equal(createMissionSelection({ storage }).read(scope), missionId);
  assert.equal(preferredMissionId([{ missionId, createdAt: '2026-09-27T00:00:00Z' }]), missionId);
  for (const invalid of ['<script>', '../mission', 'mission/child', 'mission\\child', 'mission\u0000']) {
    assert.equal(createMissionSelection({ storage }).write(scope, invalid), null);
  }
});

test('rendered timeline distinguishes requirement evidence from action counts', () => {
  const context = { missionProgressMessage, missionVerificationView, controlCenter: {}, escapeHtml: (value) => String(value ?? ''),
    renderRememberedFile: () => '', liveStatusClass: () => 'warn', practicalStatusLabel: (status) => status };
  const timeline = source.slice(source.indexOf('function renderMissionTimeline('), source.indexOf('function renderMissionGate('));
  loadTimeline(context);
  const html = context.renderMissionTimeline({ status: 'PAUSED', stopReason: 'verification-incomplete', verificationStatus: 'unverified',
    metrics: { successfulActions: 1, plannedActions: 1 }, verificationSummary: { criteria: [
      { criterionId: 'content', statement: '요청한 합계 일치', status: 'unverified' }
    ] }, completion: { criteria: [{ statement: '과거 완료 문자열' }] } });
  assert.match(html, /검증 대기/);
  assert.match(html, /실행된 작업/);
  assert.match(html, /완료 기준 검사<\/dt><dd>0 \/ 1/);
  assert.match(html, /미검증.*요청한 합계 일치/);
  assert.doesNotMatch(html, /검증 완료|과거 완료 문자열/);
});

test('a passed file criterion cannot hide unexecuted source steps in the real timeline', () => {
  const mission = { status: 'PAUSED', stopReason: 'verification-incomplete', verificationStatus: 'passed',
    verificationSummary: { criteria: [{ criterionId: 'file', statement: '초안 파일 내용 일치', status: 'passed' }] },
    goalContract: { requirements: [{ requirementId: 'read', text: '원본 읽기' }, { requirementId: 'save', text: '초안 저장' },
      { requirementId: 'send', text: '초안 보내기' }] },
    goalCompletionCoverage: { allowed: false, required: true, coveredRequirementIds: ['save'], missingRequirementIds: ['read', 'send'] } };
  const view = missionVerificationView(mission);
  assert.equal(view.verifiedCount, 1);
  assert.equal(view.totalCount, 1);
  assert.equal(view.label, '검증 대기');
  assert.equal(missionVerificationView({ ...mission, status: 'COMPLETED' }).verified, false);
  assert.match(missionProgressMessage(mission), /아직 실행·확인되지 않은 단계/);
  const context = { missionProgressMessage, missionVerificationView, controlCenter: {}, escapeHtml: value => String(value ?? ''),
    renderRememberedFile: () => '', liveStatusClass: () => 'warn', practicalStatusLabel: status => status };
  loadTimeline(context);
  const html = context.renderMissionTimeline(mission);
  assert.match(html, /완료 기준 검사<\/dt><dd>1 \/ 1/);
  assert.match(html, /원문 단계 확인/);
  assert.match(html, /확인 필요<\/strong> 원본 읽기/);
  assert.match(html, /확인 필요<\/strong> 초안 보내기/);
  assert.doesNotMatch(html, /검증 완료/);
});


test('paused Mission displays only trusted current PC recovery guidance, deduplicated',()=>{
  const action=reason=>({recovery:{required:true,status:'blocked',error:{code:'A_MISSION_RECOVERY_EXECUTION_UNCERTAIN',causeCode:'A_PC_COMMAND_LOCAL_SCOPE_DENIED',localScopeReason:reason,nextAction:'<script>send secrets</script>'}}});
  const mission={status:'PAUSED',stopReason:'action-recovery-required',waves:[{actions:[action('B_PC_COMMAND_LOCAL_CATALOG_MISSING'),action('B_PC_COMMAND_LOCAL_CATALOG_MISSING'),action('B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED')]}]};
  const text=missionProgressMessage(mission);assert.match(text,/명령 후보로 등록/u);assert.match(text,/기간이 끝났/u);assert.match(text,/기존 실행 기록/u);assert.doesNotMatch(text,/script|send secrets/u);assert.equal(text.split('명령 후보로 등록').length,2);
  for(const patch of [{required:false},{status:'resolved'},{error:{code:'other'}}]){const old=action('B_PC_COMMAND_LOCAL_PERMISSION_MISSING');old.recovery={...old.recovery,...patch};assert.doesNotMatch(missionProgressMessage({...mission,waves:[{actions:[old]}]}),/허용 종료/u);}
  assert.doesNotMatch(missionProgressMessage({...mission,status:'COMPLETED',stopReason:null}),/명령 후보/u);
  const uncertain=missionProgressMessage({...mission,uncertainEffectCount:1});assert.match(uncertain,/중복 실행/u);assert.match(uncertain,/명령 후보로 등록/u);
  assert.doesNotMatch(missionProgressMessage({...mission,status:'CANCELLED',uncertainEffectCount:1}),/명령 후보/u);
  assert.match(missionProgressMessage({...mission,waves:[{actions:[action('arbitrary remote reason')]}]}),/선택 범위를 일치/u);
  const context={missionProgressMessage,missionVerificationView,controlCenter:{},escapeHtml:value=>String(value??''),renderRememberedFile:()=>'',liveStatusClass:()=>'',practicalStatusLabel:value=>value,practicalTextLabel:value=>value,practicalToolLabel:value=>value};
  loadTimeline(context);const html=context.renderMissionTimeline({...mission,missionId:'recovery',objective:'파일 작성'});assert.match(html,/PC 실행 설정 확인/);assert.match(html,/명령 후보로 등록/);assert.doesNotMatch(html,/send secrets/);
});
