import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ManagedAgentSessionBroker } from '../packages/core/src/mission/managed-agent-session-broker.js';
import { createMissionRuntimeManagedAgentDispatcher, MANAGED_AGENT_MISSION_TOOLS } from '../packages/core/src/mission/managed-agent-mission-tool-dispatcher.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';
import {MissionBudgetGate} from '../packages/core/src/personal-operations/mission-budget-gate.js';
import {localMandateFileRef} from '../packages/core/src/personal-operations/local-mandate-observation.js';
import {createMissionEgressAuthorizationPolicy} from '../packages/core/src/mission/mission-egress-authorization-policy.js';

function attachReadMandate(t,f,allowed=true){
 const store=new PersonalOperationsStore({dbPath:':memory:'}),budget=new PersonalMandateBudget(store),gate=new MissionBudgetGate({store,budget});
 t.after(()=>store.close());
 const quota=gate.createQuota({validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',maxCalls:2,
  scope:{accountRef:null,dataRefs:[localMandateFileRef(allowed?f.path:join(f.workspace,'other.txt'),f.workspace)],deniedDataRefs:[]}});
 f.parent.executionMandateId=quota.mandate.id;f.runtime.missionRuntime.executionBudget=gate;
 return {store,gate,quota};
}

test('managed read obeys parent exact file mandate before creating or executing a child',async t=>{
 const f=await setup(t,async request=>({status:'authorized',decisionId:'scope-denied',content:request.content}));
 attachReadMandate(t,f,false);
 await f.broker.reconcileMission(f.parent.missionId);
 assert.equal(f.submitted.filter(x=>x.result.success).length,0);
 assert.equal([...f.runtime.missionRuntime.missions.values()].filter(x=>x.metadata?.managedAgentParentMissionId===f.parent.missionId).length,0);
});

test('saved managed result obeys parent mandate revocation on resubmission',async t=>{
 const f=await setup(t,async request=>({status:'authorized',decisionId:'scope-revoked',content:request.content}));
 const {store,quota}=attachReadMandate(t,f);let posts=0;
 f.provider.submitToolResult=async(_id,payload)=>{assert.equal(payload.success,true);posts++;throw Error('accepted response lost');};
 await assert.rejects(f.broker.reconcileMission(f.parent.missionId),/accepted response lost/);
 store.revokeMandate(quota.mandate.id);
 await assert.rejects(f.broker.reconcileMission(f.parent.missionId),{code:'A_MANAGED_AGENT_EGRESS_RESUBMISSION_DENIED'});
 assert.equal(posts,1);
});

test('managed parent mandate revoked inside asynchronous file preparation prevents the actual byte read',async t=>{
 const f=await setup(t,async request=>({status:'authorized',decisionId:'late-scope-revoked',content:request.content}));
 const {store,quota}=attachReadMandate(t,f);
 const adapter=f.runtime.pcAgent.registry.get('filesystem.readText'),prepare=adapter.shadow.bind(adapter),execute=adapter.execute.bind(adapter);
 let reads=0;
 adapter.shadow=async(...args)=>{const prepared=await prepare(...args);store.revokeMandate(quota.mandate.id);return prepared;};
 adapter.execute=async(...args)=>{reads++;return execute(...args);};
 await f.broker.reconcileMission(f.parent.missionId);
 assert.equal(reads,0);assert.equal(f.submitted.filter(x=>x.result.success).length,0);
});

const EGRESS_TEST_SECRET = 'isolated-egress-signing-fixture-key';
const hash = value => createHash('sha256').update(value).digest('hex');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
const signEgress = claims => createHmac('sha256', EGRESS_TEST_SECRET).update(JSON.stringify(ordered(claims))).digest('hex');

for (const [label, mutate] of [
  ['goal revision', f => { f.parent.goalContract.revision += 1; }],
  ['read grant revoked', f => { f.parent.authorization.grants = []; }],
  ['parent cancelled', f => { f.parent.status = MissionStatus.CANCELLED; }],
  ['parent replaced', f => { f.runtime.missionRuntime.missions.set(f.parent.missionId, structuredClone(f.parent)); }]
]) {
  test(`egress race: ${label} during async authorization never releases local content`, async t => {
    let f;
    f = await setup(t, async request => {
      await Promise.resolve();
      mutate(f);
      return { status: 'authorized', decisionId: 'race-decision', content: request.content };
    });
    const result = await f.broker.reconcileMission(f.parent.missionId);
    assert.ok(result.outcomes.every(o => o.verified !== true), JSON.stringify(result));
    assert.ok(f.submitted.every(s => s.result.success !== true));
    assert.ok(f.submitted.every(s => !JSON.stringify(s.result).includes('verified local content')));
    const child = [...f.runtime.missionRuntime.missions.values()].find(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
    assert.equal(child.waves[0].actions[0].status, 'succeeded', 'local E/B/G read must still run');
  });
}

async function setup(t, authorizeEgress, fileContent = 'verified local content', mutateAuthorization = null, mutateClaims = null,
  workerRole = null, useProductPolicy = false) {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-managed-agent-ebg-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace, { recursive: true });
  const path = join(workspace, 'notes.txt'); await writeFile(path, fileContent, 'utf8');
  const db = new DatabaseSync(join(root, 'broker.sqlite')); db.exec('PRAGMA foreign_keys=ON');
  const dbConnections=[db];
  const submitted = []; const requiredActions = [{ type: 'function_call', turn_id: 'remote-turn-1', call_id: 'remote-call-1',
    name: MANAGED_AGENT_MISSION_TOOLS[0], arguments: { path: 'notes.txt', maxChars: 1000 } }];
  const provider = { async retrieveSession(sessionId) { return { id: sessionId, status: 'requires_action', required_actions: requiredActions }; },
    async submitToolResult(sessionId, result, options) { submitted.push({ sessionId, result, options }); } };
  let broker;
  const runtime = createAgRuntime({ env: {}, allowedRoots: [workspace], auditRoot: join(root, 'audit'),
    cwd: () => workspace, workerDaemonEnabled: false,
    missionPlanner: { async planNextWave() { throw new Error('The one-action local plan must not invoke a planner.'); } },
    managedAgentSessionBrokerFactory: ({ missionRuntime }) => {
      if (useProductPolicy) {
        const keyStore = {
          signDecision: claims => ({claims,signature:signEgress(claims)}),
          verifyDecision: envelope => envelope?.signature === signEgress(envelope?.claims ?? {})
        };
        const egressPolicy = createMissionEgressAuthorizationPolicy({missionRuntime,keyStore});
        const dispatcher = createMissionRuntimeManagedAgentDispatcher({missionRuntime,egressPolicy});
        broker = new ManagedAgentSessionBroker({db,provider,dispatchVerifiedTool:dispatcher,allowedToolNames:[...MANAGED_AGENT_MISSION_TOOLS]});
        return broker;
      }
      const dispatcher = createMissionRuntimeManagedAgentDispatcher({ missionRuntime,
        authorizeEgress: async request => {
          const result = await authorizeEgress(request);
          if (result?.status !== 'authorized') return result;
          const parent = missionRuntime.missions.get(request.parentMissionId);
          let gate = parent.gates.find(item => item.type === 'external_data_egress' && item.callKey === request.callKey);
          const rank = Math.max(Number(request.classification.dataClass.slice(1)), Number((request.classification.ministryDataClass ?? 'M0').slice(1)));
          if (!gate && rank >= 2) {
            const created = missionRuntime.createExternalEgressGate(parent, {
              childMissionId: request.childMissionId, callKey: request.callKey, providerId: request.providerId,
              toolName: request.toolName, contentSha256: request.contentToAuthorizeSha256,
              dataClass: request.classification.dataClass, ministryDataClass: request.classification.ministryDataClass
            });
            const approved = missionRuntime.decideGate(parent.missionId, created.gateId, { decision: 'approve', decidedBy: 'fixture-owner' });
            assert.equal(approved.success, true);
            gate = parent.gates.find(item => item.gateId === created.gateId);
          }
          const issuedAt = new Date().toISOString();
          const claims = { decision: 'allow', decisionId: result.decisionId, missionId: request.parentMissionId,
            purpose:request.purpose,contentKind:request.contentKind,dataPolicyVersion:'mission-data-purpose-v1',
            sourceDataRef:request.sourceDataRef,executionMandateId:request.executionMandateId,
            childMissionId:request.childMissionId,goalRevision:request.goalRevision,goalBinding:request.goalBinding,argumentsSha256:request.argumentsSha256,
            callKey: request.callKey, providerId: request.providerId, toolName: request.toolName,
            contentSha256: hash(request.content), use: 'single-call',
            authorizationMode: gate?.status === 'approved' ? 'mission-gate' : 'policy-auto',
            gateId: gate?.status === 'approved' ? gate.gateId : null,
            approvedBy: gate?.status === 'approved' ? gate.decidedBy : 'policy:fixture-policy-v1',
            policyVersion: 'fixture-policy-v1', issuedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() };
          const finalClaims = mutateClaims?.(claims, request) ?? claims;
          const authorization = { claims: finalClaims, signature: signEgress(finalClaims) };
          return { ...result, authorization: mutateAuthorization?.(authorization, request) ?? authorization };
        },
        verifyEgressDecision: async authorization => {
          const expected = Buffer.from(signEgress(authorization?.claims ?? {}));
          const actual = Buffer.from(authorization?.signature ?? '');
          return expected.length === actual.length && timingSafeEqual(expected, actual);
        } });
      broker = new ManagedAgentSessionBroker({ db, provider, dispatchVerifiedTool: dispatcher,
        allowedToolNames: [...MANAGED_AGENT_MISSION_TOOLS], workerRole });
      return broker;
    } });
  const parent = runtime.missionRuntime.createMission({ objective: '원격 에이전트의 읽기 요청을 제한된 권한으로 처리한다.',
    successCriteria: ['관리형 세션 도구가 제한된 권한으로 실행된다.'], authorization: { grants: [MissionGrant.READ_ONLY] } });
  broker.bindSession({ missionId: parent.missionId, sessionId: 'remote-session-1',
    ...(workerRole ? { workerRole, collaborationGroupId: 'source-review' } : {}) });
  t.after(async () => { for(const connection of dbConnections)try { connection.close(); } catch {} runtime.workerDaemon?.stop?.(); await rm(root, { recursive: true, force: true }); });
  return { runtime, broker, provider, db, dbConnections, dbPath:join(root,'broker.sqlite'),parent: runtime.missionRuntime.missions.get(parent.missionId), submitted, path, workspace };
}

for (const [label, mutate] of [
  ['goal changed', f => { f.parent.goalContract.revision++; }],
  ['read revoked', f => { f.parent.authorization.grants=[]; }],
  ['cancelled', f => { f.parent.status=MissionStatus.CANCELLED; }],
  ['expired grant', f => { f.runtime.missionRuntime.clock=()=>new Date(Date.now()+600_000); }],
  ['legacy result without proof', f => { const row=f.db.prepare('SELECT result_json FROM managed_agent_tool_calls').get();const result=JSON.parse(row.result_json);delete result.egressAuthorization;f.db.prepare('UPDATE managed_agent_tool_calls SET result_json=?').run(JSON.stringify(result)); }],
  ['legacy result without purpose', f => { const row=f.db.prepare('SELECT result_json FROM managed_agent_tool_calls').get();const result=JSON.parse(row.result_json);delete result.egressAuthorization.claims.purpose;result.egressAuthorization.signature=signEgress(result.egressAuthorization.claims);f.db.prepare('UPDATE managed_agent_tool_calls SET result_json=?').run(JSON.stringify(result)); }],
  ['saved output changed', f => { const row=f.db.prepare('SELECT result_json FROM managed_agent_tool_calls').get();const result=JSON.parse(row.result_json);result.output='tampered payload';f.db.prepare('UPDATE managed_agent_tool_calls SET result_json=?').run(JSON.stringify(result)); }]
]) test(`saved egress: ${label} prevents re-submission after broker reopen`, async t => {
  const f=await setup(t,async request=>({status:'authorized',decisionId:'saved-proof',content:request.content}));
  let submits=0;
  f.provider.submitToolResult=async()=>{submits++;throw new Error('accepted response lost');};
  await assert.rejects(f.broker.reconcileMission(f.parent.missionId),/accepted response lost/);
  mutate(f);
  f.db.close();const db=new DatabaseSync(f.dbPath);f.dbConnections.push(db);
  const reopened=new ManagedAgentSessionBroker({db,provider:f.provider,dispatchVerifiedTool:f.broker.dispatchVerifiedTool,allowedToolNames:[...MANAGED_AGENT_MISSION_TOOLS]});
  await assert.rejects(reopened.reconcileMission(f.parent.missionId),{code:'A_MANAGED_AGENT_EGRESS_RESUBMISSION_DENIED'});
  assert.equal(submits,1);
  const child=[...f.runtime.missionRuntime.missions.values()].find(m=>m.metadata?.managedAgentParentMissionId===f.parent.missionId);
  assert.equal(child.waves.length,1);assert.equal(child.waves[0].actions[0].status,'succeeded');
});

test('actual managed Mission E/B/G and product egress policy bind host-owned purpose before submission', async t => {
  const f = await setup(t, null, '공개 연구 자료', null, null, null, true);
  await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].result.success, true);
  assert.equal(JSON.parse(f.submitted[0].result.output).content, '공개 연구 자료');
  const row = f.db.prepare('SELECT result_json FROM managed_agent_tool_calls').get();
  const claims = JSON.parse(row.result_json).egressAuthorization.claims;
  assert.equal(claims.purpose, 'mission-tool-evidence');
  assert.equal(claims.contentKind, 'LOCAL_FILE_CONTENT');
  assert.equal(claims.dataPolicyVersion, 'mission-data-purpose-v1');
  assert.equal(claims.policyVersion, 'jarvis-mission-egress-policy-v2');
  assert.equal(f.submitted[0].result.egressAuthorization, undefined);
});

test('actual managed product policy keeps local-only data local', async t => {
  const f = await setup(t, null, '상담 비공개 합성 이야기', null, null, null, true);
  await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(f.submitted.some(row => row.result.success === true), false);
  assert.equal(f.submitted.some(row => JSON.stringify(row).includes('비공개 합성 이야기')), false);
  const children = [...f.runtime.missionRuntime.missions.values()].filter(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
  assert.equal(children[0].waves[0].actions[0].status, 'succeeded');
});

test('saved egress: unchanged scope retries exact payload and key without exposing local authorization', async t=>{
  const f=await setup(t,async request=>({status:'authorized',decisionId:'positive-saved-proof',content:request.content}));
  const attempts=[];
  f.provider.submitToolResult=async(_id,payload,options)=>{
    attempts.push({payload,options});
    if(attempts.length===1)throw new Error('accepted response lost');
  };
  await assert.rejects(f.broker.reconcileMission(f.parent.missionId),/accepted response lost/);
  f.db.close();const db=new DatabaseSync(f.dbPath);f.dbConnections.push(db);
  const reopened=new ManagedAgentSessionBroker({db,provider:f.provider,dispatchVerifiedTool:f.broker.dispatchVerifiedTool,allowedToolNames:[...MANAGED_AGENT_MISSION_TOOLS]});
  await reopened.reconcileMission(f.parent.missionId);
  assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);
  assert.equal(attempts[0].payload.egressAuthorization,undefined);
  assert.equal(JSON.parse(attempts[1].payload.output).content,'verified local content');
  const state=reopened.callState({sessionId:'remote-session-1',turnId:'remote-turn-1',callId:'remote-call-1'});
  assert.equal(state.state,'submitted');assert.ok(state.result.egressAuthorization.claims.argumentsSha256);
  const children=[...f.runtime.missionRuntime.missions.values()].filter(m=>m.metadata?.managedAgentParentMissionId===f.parent.missionId);
  assert.equal(children.length,1);assert.equal(children[0].waves[0].actions.length,1);
});

async function createVerifiedEditorArtifact(f) {
  f.parent.authorization.grants.push(MissionGrant.LOCAL_REVERSIBLE);
  const wave = f.runtime.missionRuntime.createWave(f.parent, { summary: 'editor가 검증된 인계 파일을 만든다.', actions: [{
    id: 'editor-handoff-source', title: '인계 자료 작성', command: 'handoff.txt 파일을 만들어줘',
    expectedToolName: 'filesystem.createTextFile', arguments: { path: join(f.workspace, 'handoff.txt'), content: 'verified handoff text' },
    dependencies: [], workerRole: 'editor', collaborationGroupId: 'source-review', successSignal: '파일 생성 후 G 검증 통과'
  }] });
  assert.ok(wave);
  await f.runtime.missionRuntime.executeWave(f.parent, wave);
  const action = wave.actions[0];
  assert.equal(action.status, 'succeeded');
  const observation = f.parent.observations.find(item => item.actionId === action.actionId && item.outcome === 'success');
  assert.equal(observation?.verification?.status, 'passed');
  assert.equal(observation?.artifacts?.[0]?.contentSha256?.length, 64);
  return action;
}

test('managed read tool runs as a child Mission through E→B→G and returns only after explicit data-egress authorization', async t => {
  let egressRequest;
  const f = await setup(t, async request => { egressRequest = request; return { status: 'authorized', decisionId: 'egress-grant-1', content: request.content }; });
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].status, 'result-submitted', JSON.stringify(result));
  assert.equal(result.outcomes[0].verified, true);
  assert.equal(egressRequest.providerId, 'openai-agents-api');
  assert.equal(egressRequest.untrusted, true);
  assert.equal(egressRequest.sourcePath, f.path);
  const payload = JSON.parse(f.submitted[0].result.output);
  assert.equal(payload.content, 'verified local content');
  assert.equal(payload.trustBoundary, 'LOCAL_FILE_CONTENT');
  assert.equal(payload.untrusted, true);
  const child = [...f.runtime.missionRuntime.missions.values()].find(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
  const action = child.waves.flatMap(wave => wave.actions)[0];
  const observation = child.observations.find(item => item.actionId === action.actionId && item.outcome === 'success');
  assert.equal(action.actualToolName, 'filesystem.readText');
  assert.equal(action.capabilityProfile.readOnly, true);
  assert.equal(action.capabilityProfile.executionClass, MissionGrant.READ_ONLY);
  assert.equal(observation.verification.status, 'passed');
  assert.ok(observation.verification.verificationId);
  assert.ok(observation.evidenceId);
  assert.equal(child.status, MissionStatus.PAUSED);
  assert.equal(f.parent.status, MissionStatus.CREATED);
});

test('role managed-agent read tool creates a child Mission with the same enforced role and collaboration group', async t => {
  const f = await setup(t, async request => ({ status: 'authorized', decisionId: 'role-egress', content: request.content }),
    'public source fixture', null, null, 'researcher');
  const sourceAction = await createVerifiedEditorArtifact(f);
  const sourceObservation = f.parent.observations.find(item => item.actionId === sourceAction.actionId && item.outcome === 'success');
  sourceObservation.artifacts.unshift({ outsideAllowedRoots: false, rootIndex: 0, relativePath: 'missing-sibling.txt', contentSha256: 'a'.repeat(64) });
  f.broker.provider.retrieveSession = async sessionId => ({ id: sessionId, status: 'requires_action', required_actions: [{
    type: 'function_call', turn_id: 'remote-turn-1', call_id: 'remote-call-1', name: MANAGED_AGENT_MISSION_TOOLS[0],
    arguments: { path: 'handoff.txt', maxChars: 1000, sourceActionId: sourceAction.actionId }
  }] });
  const result = await f.broker.reconcileMission(f.parent.missionId, {
    workerRole: 'researcher', collaborationGroupId: 'source-review'
  });
  assert.equal(result.outcomes[0].verified, true, JSON.stringify({ result, submitted: f.submitted[0] }));
  const child = [...f.runtime.missionRuntime.missions.values()].find(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
  const action = child.waves.flatMap(wave => wave.actions)[0];
  assert.equal(action.workerRole, 'researcher');
  assert.equal(action.collaborationGroupId, 'source-review');
  assert.equal(action.roleScope.allowed, true);
  assert.equal(f.submitted[0].result.output.includes('verified handoff text'), true);
  assert.equal(f.parent.observations.some(item => item.category === 'execution' && item.outcome === 'success'
    && item.artifacts?.some(artifact => artifact.name === 'handoff.txt')), true);
  assert.equal(child.status, MissionStatus.PAUSED, 'a verified read child still does not complete the parent mission');
});

test('role-scoped reads of user-supplied files keep the existing E/B/G and egress authorization path', async t => {
  let egressCalls = 0;
  const f = await setup(t, async request => {
    egressCalls++;
    return { status: 'authorized', decisionId: 'user-file-read', content: request.content };
  }, 'user supplied file', null, null, 'researcher');
  const result = await f.broker.reconcileMission(f.parent.missionId, {
    workerRole: 'researcher', collaborationGroupId: 'source-review'
  });
  assert.equal(result.outcomes[0].verified, true, JSON.stringify(result));
  assert.equal(egressCalls, 1);
  assert.equal(JSON.parse(f.submitted[0].result.output).content, 'user supplied file');
});

test('role handoff rehashes the source after G and withholds changed content before egress', async t => {
  let egressCalls = 0;
  const f = await setup(t, async request => {
    egressCalls++;
    return { status: 'authorized', decisionId: 'must-not-send-stale-file', content: request.content };
  }, 'public source fixture', null, null, 'researcher');
  const sourceAction = await createVerifiedEditorArtifact(f);
  await writeFile(join(f.workspace, 'handoff.txt'), 'changed after G', 'utf8');
  f.broker.provider.retrieveSession = async sessionId => ({ id: sessionId, status: 'requires_action', required_actions: [{
    type: 'function_call', turn_id: 'remote-turn-1', call_id: 'remote-call-1', name: MANAGED_AGENT_MISSION_TOOLS[0],
    arguments: { path: 'handoff.txt', maxChars: 1000, sourceActionId: sourceAction.actionId }
  }] });
  const result = await f.broker.reconcileMission(f.parent.missionId, {
    workerRole: 'researcher', collaborationGroupId: 'source-review'
  });
  assert.equal(result.outcomes[0].verified, false, JSON.stringify({ result, submitted: f.submitted[0] }));
  assert.equal(egressCalls, 0);
  assert.equal(f.submitted[0].result.success, false);
  assert.match(f.submitted[0].result.error, /source artifact changed after G verification/u);
  const child = [...f.runtime.missionRuntime.missions.values()].find(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
  assert.equal(child?.status, MissionStatus.PAUSED);
  assert.equal(f.parent.status, MissionStatus.RUNNING);
});

test('role managed-agent read tool refuses an unverified or same-role artifact source before creating a read Mission', async t => {
  const f = await setup(t, async request => ({ status: 'authorized', decisionId: 'must-not-egress', content: request.content }),
    'public source fixture', null, null, 'researcher');
  f.broker.provider.retrieveSession = async sessionId => ({ id: sessionId, status: 'requires_action', required_actions: [{
    type: 'function_call', turn_id: 'remote-turn-1', call_id: 'remote-call-1', name: MANAGED_AGENT_MISSION_TOOLS[0],
    arguments: { path: 'notes.txt', maxChars: 1000, sourceActionId: 'invented-action' }
  }] });
  const result = await f.broker.reconcileMission(f.parent.missionId, {
    workerRole: 'researcher', collaborationGroupId: 'source-review'
  });
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(result.outcomes[0].verified, false, JSON.stringify(result));
  assert.equal([...f.runtime.missionRuntime.missions.values()].filter(m => m.metadata?.managedAgentParentMissionId).length, 0);
  assert.equal(f.submitted[0].result.success, false);
  assert.equal(f.submitted[0].result.error.includes('source action'), true, JSON.stringify(f.submitted[0]));
});

test('role artifact provenance fails closed when source role, group, status, G evidence, or allowed-root reference is tampered', async t => {
  const corruptions = [
    ['same-role source', ({ sourceAction }) => { sourceAction.workerRole = 'researcher'; }],
    ['different collaboration group', ({ sourceAction }) => { sourceAction.collaborationGroupId = 'other-group'; }],
    ['non-success source action', ({ sourceAction }) => { sourceAction.status = 'failed'; }],
    ['missing G evidence ID', ({ sourceObservation }) => { sourceObservation.evidenceId = null; }],
    ['failed source G verification', ({ sourceObservation }) => { sourceObservation.verification.status = 'failed'; }],
    ['artifact path escaping its allowed root', ({ sourceObservation }) => {
      sourceObservation.artifacts[0].relativePath = '../outside-root.txt';
    }]
  ];
  for (const [label, corrupt] of corruptions) {
    let egressCalls = 0;
    const f = await setup(t, async request => {
      egressCalls++;
      return { status: 'authorized', decisionId: 'must-not-authorize-corrupt-source', content: request.content };
    }, 'public source fixture', null, null, 'researcher');
    const sourceAction = await createVerifiedEditorArtifact(f);
    const sourceObservation = f.parent.observations.find(item => item.actionId === sourceAction.actionId && item.outcome === 'success');
    corrupt({ sourceAction, sourceObservation });
    f.broker.provider.retrieveSession = async sessionId => ({ id: sessionId, status: 'requires_action', required_actions: [{
      type: 'function_call', turn_id: 'turn-corrupt-source', call_id: `call-${label.replaceAll(/[^a-z0-9]+/giu, '-')}`,
      name: MANAGED_AGENT_MISSION_TOOLS[0], arguments: { path: 'handoff.txt', maxChars: 1000, sourceActionId: sourceAction.actionId }
    }] });
    const result = await f.broker.reconcileMission(f.parent.missionId, {
      workerRole: 'researcher', collaborationGroupId: 'source-review'
    });
    assert.equal(result.outcomes[0].verified, false, `${label}: ${JSON.stringify(result)}`);
    assert.equal(egressCalls, 0, `${label} must be rejected before egress authorization`);
    assert.equal([...f.runtime.missionRuntime.missions.values()]
      .filter(mission => mission.metadata?.managedAgentParentMissionId === f.parent.missionId).length, 0,
    `${label} must be rejected before creating a read Mission`);
    assert.equal(f.submitted[0].result.success, false, `${label} must return a blocked result`);
  }
});

test('managed read tool never returns local content when external data-egress policy denies it', async t => {
  let egressRequest;
  const f = await setup(t, async request => { egressRequest = request; return { status: 'denied', decisionId: 'deny-1' }; });
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(egressRequest.content, 'verified local content');
  assert.equal(f.submitted[0].result.success, false);
  assert.doesNotMatch(f.submitted[0].result.error, /verified local content/);
  const child = [...f.runtime.missionRuntime.missions.values()].find(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
  assert.equal(child.status, MissionStatus.PAUSED);
  assert.equal(child.stopReason, 'managed-agent-egress-denied');
  assert.equal(f.parent.status, MissionStatus.CREATED);
});

test('managed read tool blocks path traversal before creating or executing a child Mission', async t => {
  const f = await setup(t, async request => ({ status: 'authorized', decisionId: 'egress-grant', content: request.content }));
  f.runtime.missionRuntime.managedAgentSessionBroker.provider.retrieveSession = async sessionId => ({ id: sessionId,
    status: 'requires_action', required_actions: [{ type: 'function_call', turn_id: 'turn-x', call_id: 'call-x',
      name: MANAGED_AGENT_MISSION_TOOLS[0], arguments: { path: '..\\secret.txt' } }] });
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal([...f.runtime.missionRuntime.missions.values()].filter(m => m.metadata?.managedAgentParentMissionId).length, 0);
  assert.equal(f.submitted[0].result.success, false);
});

test('managed read tool blocks a symlink that resolves outside every allowed root', async t => {
  const f = await setup(t, async request => ({ status: 'authorized', decisionId: 'must-not-run', content: request.content }));
  const outside = await mkdtemp(join(tmpdir(), 'jarvis-managed-agent-outside-'));
  const outsidePath = join(outside, 'secret.txt');
  await writeFile(outsidePath, 'outside secret', 'utf8');
  const linkPath = join(f.workspace, 'outside-link');
  try {
    await symlink(outside, linkPath, 'junction');
  } catch (error) {
    await rm(outside, { recursive: true, force: true });
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`directory symlink unavailable: ${error.code}`);
    throw error;
  }
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  f.runtime.missionRuntime.managedAgentSessionBroker.provider.retrieveSession = async sessionId => ({ id: sessionId,
    status: 'requires_action', required_actions: [{ type: 'function_call', turn_id: 'turn-symlink', call_id: 'call-symlink',
      name: MANAGED_AGENT_MISSION_TOOLS[0], arguments: { path: 'outside-link/secret.txt' } }] });
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(f.submitted[0].result.success, false);
  assert.doesNotMatch(f.submitted[0].result.error, /outside secret/u);
  assert.equal([...f.runtime.missionRuntime.missions.values()].filter(m => m.metadata?.managedAgentParentMissionId).length, 0);
  await rm(linkPath, { force: true });
});

test('managed read tool masks D2 personal data before the external authorization callback sees it', async t => {
  let egressRequest;
  const f = await setup(t, async request => { egressRequest = request; return { status: 'authorized', decisionId: 'egress-mask-1', content: request.content }; },
    '연락처: pastor@example.org');
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].status, 'result-submitted');
  assert.doesNotMatch(egressRequest.content, /pastor@example\.org/u);
  assert.match(egressRequest.content, /\[SENSITIVE(?:_ENTITY)?\]/u);
  assert.equal(egressRequest.classification.dataClass, 'D2');
  assert.ok(egressRequest.redactions.length > 0);
  assert.doesNotMatch(f.submitted[0].result.output, /pastor@example\.org/u);
});

test('managed read tool withholds D3/D4 content before external authorization and submission', async t => {
  let authorizationCalls = 0;
  const f = await setup(t, async request => { authorizationCalls += 1; return { status: 'authorized', decisionId: 'should-not-be-used', content: request.content }; },
    '계좌번호 123456789012');
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(authorizationCalls, 0);
  assert.equal(f.submitted[0].result.success, false);
  assert.doesNotMatch(f.submitted[0].result.error, /123456789012/u);
});

test('M10 captures only minimized provider payload and proves high-sensitivity source is withheld', async t => {
  const publicSource = '공개 안내: 자료 배포는 다음 주입니다.\n연락처: pastor@example.org';
  let publicEgressRequest;
  const publicFixture = await setup(t, async request => {
    publicEgressRequest = request;
    return { status: 'authorized', decisionId: 'm10-public-only', content: request.content };
  }, publicSource);
  const publicResult = await publicFixture.broker.reconcileMission(publicFixture.parent.missionId);
  assert.equal(publicResult.outcomes[0].status, 'result-submitted');
  const publicPayload = publicFixture.submitted[0].result.output;
  assert.match(publicPayload, /공개 안내: 자료 배포는 다음 주입니다/u);
  assert.doesNotMatch(publicPayload, /pastor@example\.org/u);

  let sensitiveAuthorizationCalls = 0;
  const sensitiveFixture = await setup(t, async request => {
    sensitiveAuthorizationCalls += 1;
    return { status: 'authorized', decisionId: 'must-not-authorize-sensitive', content: request.content };
  }, '계좌번호 123456789012');
  const sensitiveResult = await sensitiveFixture.broker.reconcileMission(sensitiveFixture.parent.missionId);
  assert.equal(sensitiveResult.outcomes[0].verified, false);
  assert.equal(sensitiveAuthorizationCalls, 0);
  assert.equal(sensitiveFixture.submitted[0].result.success, false);
  assert.doesNotMatch(JSON.stringify(sensitiveFixture.submitted[0].result), /123456789012/u);

  const evidencePath = process.env.JARVIS_M10_ORACLE_EVIDENCE_PATH;
  if (evidencePath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(evidencePath, `${JSON.stringify({ schemaVersion: 1, scenarioId: 'M10',
      fixtureId: 'm10-local-classifier-egress-v1',
      publicCase: { sourceSha256: hash(publicSource), classification: 'D2',
        egressRequestCount: publicEgressRequest ? 1 : 0, minimizedContent: publicEgressRequest?.content ?? null,
        providerPayload: publicPayload, submitted: true },
      sensitiveCase: { sourceSha256: hash('계좌번호 123456789012'), classification: 'D3',
        authorizationCalls: sensitiveAuthorizationCalls, providerPayload: JSON.stringify(sensitiveFixture.submitted[0].result),
        submitted: false, verified: sensitiveResult.outcomes[0].verified },
      metrics: { externalNetworkRequests: null, providerSessionApiCalls: 0, mockProviderSubmissions: 2 }
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
});

test('egress authorization cannot replace minimized content with the original or another payload', async t => {
  const original = '연락처: pastor@example.org';
  const f = await setup(t, async () => ({ status: 'authorized', decisionId: 'bad-policy-adapter', content: original }), original);
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(f.submitted[0].result.success, false);
  assert.doesNotMatch(f.submitted[0].result.error, /pastor@example\.org/u);
  const child = [...f.runtime.missionRuntime.missions.values()].find(m => m.metadata?.managedAgentParentMissionId === f.parent.missionId);
  assert.equal(child.stopReason, 'managed-agent-egress-denied');
});

test('egress authorization requires a valid signed grant bound to the exact call and content', async t => {
  const f = await setup(t, async request => ({ status: 'authorized', decisionId: 'egress-signed-1', content: request.content }),
    'verified local content', authorization => ({ ...authorization, signature: 'forged-signature' }));
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(f.submitted[0].result.success, false);
  assert.doesNotMatch(f.submitted[0].result.error, /verified local content/u);
});

test('valid policy signature cannot auto-authorize D2 content or bypass a Mission approval gate', async t => {
  let egressRequest;
  const f = await setup(t, async request => { egressRequest = request; return { status: 'authorized', decisionId: 'policy-auto-d2', content: request.content }; },
    '연락처: pastor@example.org', null,
    claims => ({ ...claims, authorizationMode: 'policy-auto', gateId: null, approvedBy: 'policy:fixture-policy-v1' }));
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false, JSON.stringify(result));
  assert.match(egressRequest.content, /\[SENSITIVE(?:_ENTITY)?\]/u);
  assert.equal(f.submitted[0].result.success, false);
});

test('external egress gate holds the remote call until the same Mission gate is approved, then resumes it', async t => {
  let f, authorizationChecks = 0, expectedContentHash;
  f = await setup(t, async request => {
    authorizationChecks++;
    if (authorizationChecks === 1) {
      expectedContentHash = request.contentToAuthorizeSha256;
      const parent = f.runtime.missionRuntime.missions.get(request.parentMissionId);
      const created = f.runtime.missionRuntime.createExternalEgressGate(parent, {
        childMissionId: request.childMissionId, callKey: request.callKey, providerId: request.providerId,
        toolName: request.toolName, contentSha256: request.contentToAuthorizeSha256,
        dataClass: request.classification.dataClass, ministryDataClass: request.classification.ministryDataClass
      });
      assert.equal(created.success, true);
      return { status: 'pending_approval', gateId: created.gateId };
    }
    return { status: 'authorized', decisionId: 'approved-after-gate', content: request.content };
  });
  const first = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(first.outcomes[0].status, 'approval-required');
  assert.equal(f.submitted.length, 0);
  const parent = f.runtime.missionRuntime.missions.get(f.parent.missionId);
  const gate = parent.gates.find(item => item.type === 'external_data_egress');
  assert.equal(gate.status, 'pending');
  assert.equal(gate.externalTransfer, true);
  assert.equal(gate.contentSha256, expectedContentHash);
  const approval = f.runtime.missionRuntime.decideGate(f.parent.missionId, gate.gateId, { decision: 'approve', decidedBy: 'mission-owner' });
  assert.equal(approval.success, true);
  assert.equal(approval.gates.find(item => item.gateId === gate.gateId).status, 'approved');

  const resumed = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(resumed.outcomes[0].status, 'result-submitted');
  assert.equal(f.submitted.length, 1);
  assert.equal(JSON.parse(f.submitted[0].result.output).content, 'verified local content');
  assert.equal(authorizationChecks, 2);
});

test('expired external egress gate cannot release the remote tool call', async t => {
  let f, gateId;
  f = await setup(t, async request => {
    const parent = f.runtime.missionRuntime.missions.get(request.parentMissionId);
    const created = f.runtime.missionRuntime.createExternalEgressGate(parent, {
      childMissionId: request.childMissionId, callKey: request.callKey, providerId: request.providerId,
      toolName: request.toolName, contentSha256: request.contentToAuthorizeSha256,
      dataClass: request.classification.dataClass, ministryDataClass: request.classification.ministryDataClass
    });
    gateId = created.gateId;
    parent.gates.find(item => item.gateId === gateId).expiresAt = new Date(Date.now() - 1_000).toISOString();
    return { status: 'pending_approval', gateId };
  });
  const result = await f.broker.reconcileMission(f.parent.missionId);
  assert.equal(result.outcomes[0].verified, false);
  assert.equal(f.submitted[0].result.success, false);
  const decision = f.runtime.missionRuntime.decideGate(f.parent.missionId, gateId, { decision: 'approve', decidedBy: 'too-late-owner' });
  assert.equal(decision.success, false);
  assert.equal(f.runtime.missionRuntime.missions.get(f.parent.missionId).gates.find(item => item.gateId === gateId).status, 'expired');
});
