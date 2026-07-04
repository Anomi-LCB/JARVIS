import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisSystem } from '../src/domain/core-engine.js';
import { PermissionLevel } from '../src/domain/models.js';
import { SecurityGateway } from '../src/domain/security.js';
import { GrowthMemory } from '../src/domain/memory.js';
import { DeviceBridge } from '../src/domain/bridge.js';
import { LocalPcController } from '../src/domain/local-control.js';

await test('dashboard composes all seven document modules into a deterministic console state', () => {
  const dashboard = createJarvisSystem().composeDashboardState('회의 자료 분석');

  assert.equal(dashboard.modules.length, 7);
  assert.equal(dashboard.documentStreams.length, 7);
  assert.deepEqual(dashboard.documentStreams.map((stream) => stream.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(dashboard.brand, 'JARVIS');
  assert.equal(dashboard.progress, 88);
  assert.ok(dashboard.documentProgress > 70);
  assert.equal(dashboard.workflow.find((step) => step.status === 'active').label, '검증 통과');
  assert.deepEqual(dashboard.simulationResult.failedChecks, []);
  assert.equal(dashboard.bridgeRoute.delivered, true);
  assert.equal(dashboard.approval.status, 'approved');
  assert.equal(dashboard.readiness.status, 'go');
  assert.equal(dashboard.readiness.watchItems.length, 0);
  assert.equal(dashboard.actionPlan.focus, '회의 자료 분석 릴리스 진행');
  assert.equal(dashboard.actionPlan.nextActions.length, 0);
});

await test('command profile changes local plan, bridge target, and simulation scenario', () => {
  const system = createJarvisSystem();
  const capture = system.composeDashboardState('현재 화면 캡처');
  const record = system.composeDashboardState('회의 녹음 시작');

  assert.equal(capture.commandProfile.scenarioId, 'live-capture');
  assert.equal(capture.plan.capability, 'capture');
  assert.equal(capture.plan.requiresConfirmation, true);
  assert.equal(capture.plan.mode, 'ready');
  assert.equal(capture.bridgeRoute.target, '스마트폰');
  assert.equal(capture.simulationResult.passRate, 100);

  assert.equal(record.commandProfile.scenarioId, 'voice-record');
  assert.equal(record.plan.capability, 'record');
  assert.equal(record.plan.risk, 'high');
  assert.equal(record.bridgeRoute.target, '블루투스 이어폰');
  assert.deepEqual(record.simulationResult.failedChecks, ['speaker-label-needs-review']);
});

await test('local control policy blocks destructive commands before execution', () => {
  const localPc = new LocalPcController();
  const plan = localPc.plan('다운로드 폴더 삭제');

  assert.equal(plan.executable, false);
  assert.equal(plan.mode, 'blocked');
  assert.equal(plan.reason, 'destructive-command-blocked');
  assert.deepEqual(plan.guardrails, ['deny-by-default', 'audit-required']);
});

await test('blocked local plans become B-document readiness blockers', () => {
  const dashboard = createJarvisSystem().composeDashboardState('다운로드 폴더 삭제');

  assert.equal(dashboard.commandProfile.title, '제한 명령 차단');
  assert.equal(dashboard.simulationResult.id, 'restricted-command');
  assert.equal(dashboard.plan.executable, false);
  assert.equal(dashboard.progress, 15);
  assert.equal(dashboard.commandHistory[0].status, 'local-blocked');
  assert.equal(dashboard.commandHistory[0].title, '제한 명령 차단');
  assert.equal(dashboard.workflow.find((step) => step.status === 'active').label, '실행 계획');
  assert.equal(dashboard.readiness.status, 'blocked');
  assert.ok(dashboard.readiness.blockers.some((item) => item.id === 'B'));
  assert.equal(dashboard.readiness.goCriteria.find((item) => item.label === 'Local plan allowlisted').pass, false);
  assert.equal(dashboard.actionPlan.nextActions[0].docId, 'B');
  assert.equal(dashboard.actionPlan.nextActions[0].priority, 'critical');
});

await test('dashboard records command memory for the active command profile', () => {
  const dashboard = createJarvisSystem().composeDashboardState('프로젝트 자료 검색');

  assert.equal(dashboard.commandProfile.title, '자료 검색');
  assert.equal(dashboard.recentMemory.tags[0], 'search');
  assert.equal(dashboard.memories[0].title, '자료 검색 요청 처리');
});

await test('sensitive system inspection waits for admin approval in normal mode', () => {
  const dashboard = createJarvisSystem().composeDashboardState('설정 점검');

  assert.equal(dashboard.commandProfile.requiredLevel, PermissionLevel.ADMIN);
  assert.equal(dashboard.approval.status, 'pending');
  assert.equal(dashboard.canAssist, false);
  assert.equal(dashboard.progress, 15);
  assert.equal(dashboard.commandHistory[0].status, 'approval-required');
  assert.equal(dashboard.moduleTelemetry.find((item) => item.label === 'Security').status, 'pending');
  assert.equal(dashboard.documentStreams.find((stream) => stream.id === 'E').stage, 'blocked');
  assert.equal(dashboard.documentStreams.find((stream) => stream.id === 'E').health, 'blocked');
  assert.equal(dashboard.readiness.status, 'blocked');
  assert.ok(dashboard.readiness.blockers.some((item) => item.id === 'E'));
  assert.equal(dashboard.actionPlan.nextActions[0].priority, 'critical');
  assert.equal(dashboard.actionPlan.nextActions[0].docId, 'E');
});

await test('admin mode clears sensitive system inspection and records command history', () => {
  const system = createJarvisSystem();
  const normal = system.composeDashboardState('설정 점검');
  const elevated = system.composeDashboardState('설정 점검', {
    autoApprove: true,
    userLevel: PermissionLevel.ADMIN
  });

  assert.equal(normal.canAssist, false);
  assert.equal(elevated.canAssist, true);
  assert.equal(elevated.approval.status, 'approved');
  assert.equal(elevated.plan.capability, 'inspect');
  assert.equal(elevated.plan.mode, 'dry-run');
  assert.equal(elevated.commandHistory.length, 2);
  assert.deepEqual(elevated.commandHistory.map((item) => item.status), ['running', 'approval-required']);
  assert.equal(elevated.documentStreams.find((stream) => stream.id === 'E').stage, 'complete');
  assert.notEqual(elevated.readiness.status, 'blocked');
  assert.equal(elevated.readiness.goCriteria.find((item) => item.label === 'Security gate cleared').pass, true);
  assert.equal(elevated.actionPlan.nextActions.some((item) => item.priority === 'critical'), false);
});

await test('security gateway requires approved requests and sufficient permission rank', () => {
  const security = new SecurityGateway();
  const approval = security.requestApproval({
    id: 'sensitive-control',
    actor: 'operator',
    action: 'pc-control',
    requiredLevel: PermissionLevel.CONTROL,
    autoApprove: true
  });

  assert.equal(security.canExecute({ approvalId: approval.id, userLevel: PermissionLevel.ASSIST }), false);
  assert.equal(security.canExecute({ approvalId: approval.id, userLevel: PermissionLevel.ADMIN }), true);
});

await test('security gateway expires approvals and supports renewal', () => {
  const security = new SecurityGateway({ defaultTtlMs: 1000 });
  const approval = security.requestApproval({
    id: 'temporary-admin',
    actor: 'operator',
    action: 'system-inspection',
    requiredLevel: PermissionLevel.ADMIN,
    autoApprove: true,
    createdAt: '2026-06-07T00:00:00.000Z'
  });

  assert.equal(approval.expiresAt, '2026-06-07T00:00:01.000Z');
  assert.equal(
    security.canExecute({
      approvalId: approval.id,
      userLevel: PermissionLevel.ADMIN,
      at: '2026-06-07T00:00:02.000Z'
    }),
    false
  );
  assert.equal(security.approvalSummary('2026-06-07T00:00:02.000Z')[0].status, 'expired');

  const renewed = security.renewApproval({
    approvalId: approval.id,
    actor: 'operator',
    ttlMs: 2000,
    autoApprove: true,
    at: '2026-06-07T00:00:03.000Z'
  });

  assert.equal(renewed.renewalCount, 1);
  assert.equal(
    security.canExecute({
      approvalId: approval.id,
      userLevel: PermissionLevel.ADMIN,
      at: '2026-06-07T00:00:04.000Z'
    }),
    true
  );
});

await test('growth memory prioritizes heavier contextual memories', () => {
  const memory = new GrowthMemory([
    { title: '낮은 우선순위', tags: ['workflow'], weight: 1, createdAt: '2026-06-07T01:00:00.000Z' },
    { title: '높은 우선순위', tags: ['workflow'], weight: 5, createdAt: '2026-06-07T02:00:00.000Z' }
  ]);

  assert.equal(memory.recallByTag('workflow', 1)[0].title, '높은 우선순위');
  assert.deepEqual(memory.summarizeProfile()[0], { tag: 'workflow', score: 6 });
});

await test('bridge reports device health and routes messages by target type', () => {
  const bridge = new DeviceBridge([
    { name: 'phone', type: 'mobile', latencyMs: 40 },
    { name: 'cloud', type: 'cloud', latencyMs: 320 }
  ]);

  assert.equal(bridge.connectionSummary()[1].status, 'degraded');
  assert.deepEqual(bridge.routeMessage({ targetType: 'mobile', payload: 'hello' }), {
    delivered: true,
    target: 'phone',
    etaMs: 42
  });
});
