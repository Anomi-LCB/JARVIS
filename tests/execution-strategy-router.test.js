import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { buildMissionPlanningPrompt } from '../packages/core/src/mission/mission-planner.js';
import {
  ExecutionChannel,
  ExecutionStrategyRouter
} from '../packages/core/src/routing/execution-strategy-router.js';
import { SkillRouter } from '../packages/core/src/routing/skill-router.js';
import { ActionType, ModuleId, TrustBoundary } from '../packages/shared/src/types.js';

test('execution strategy prefers a matching MCP/API path before browser and desktop fallbacks', () => {
  const router = new ExecutionStrategyRouter();
  const skills = [
    fakeSkill('mcp.knowledge.search', ExecutionChannel.MCP_CONNECTOR, ['검색', '조사']),
    fakeSkill('browser.search', ExecutionChannel.WEB_DOM, ['검색', '조사']),
    fakeSkill('desktop.control', ExecutionChannel.DESKTOP_UIA, ['화면', '클릭'])
  ];

  const ranked = router.rank(skills, { objective: '웹에서 최신 기술 동향을 검색하고 조사해' });

  assert.equal(ranked[0].skill.toolName, 'mcp.knowledge.search');
  assert.equal(ranked.at(-1).skill.toolName, 'desktop.control');
  assert.ok(ranked[0].reasons.includes('objective:live-data'));
  assert.ok(ranked[0].reasons.includes('objective:web-workflow'));
});

test('execution strategy keeps private offline work on deterministic local tools', () => {
  const router = new ExecutionStrategyRouter();
  const local = fakeSkill('filesystem.searchFiles', ExecutionChannel.DETERMINISTIC_LOCAL, ['파일', '검색'], {
    readsLocalFiles: true
  });
  const remote = fakeSkill('mcp.cloud.search', ExecutionChannel.MCP_CONNECTOR, ['파일', '검색'], {
    externalNetwork: true
  });

  const ranked = router.rank([remote, local], {
    objective: '기밀 파일을 오프라인만 사용해서 검색해',
    constraints: ['네트워크 금지', '외부 공유 금지']
  });

  assert.equal(ranked[0].skill.toolName, 'filesystem.searchFiles');
  assert.ok(ranked[1].reasons.includes('constraint:offline-external-blocked'));
});

test('skill router bounds the model tool catalog and retains verified fallback routes', () => {
  const router = new SkillRouter();
  const selection = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: '최신 AI 뉴스를 웹에서 조사해',
    maxTools: 6
  });

  assert.equal(selection.totalCount, router.capabilityMatrix().length);
  assert.equal(selection.selectedCount, 6);
  assert.ok(selection.selectedToolNames.includes('browser.search'));
  assert.ok(selection.selectedToolNames.includes('desktop.control'));
  assert.ok(selection.selectedToolNames.includes('shell.execute'));
  assert.equal(selection.selectedToolNames.includes('email.send'), false);
  assert.equal(selection.capabilities[0].executionStrategy.rank, 1);

  const privateSelection = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: '기밀 작업 폴더에서 package.json 파일을 오프라인만 사용해서 찾아',
    constraints: ['네트워크 금지', '외부 공유 금지'],
    maxTools: 6
  });
  assert.equal(privateSelection.capabilities[0].toolName, 'filesystem.searchFiles');
  assert.equal(privateSelection.selectedToolNames.includes('externalTransfer.reviewOnly'), false);
});

test('shortlist pins tools explicitly required by a compound artifact workflow ahead of generic fallbacks', () => {
  const router = new SkillRouter();
  const selection = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: [
      '다음 작업을 순서대로 완료해줘.',
      '1) 오늘 핫뉴스를 웹에서 검색해 hot-news-report.md에 저장해.',
      '2) workspace에서 보고서를 다시 찾아 읽어.',
      '3) cards/news-01.png 뉴스 카드를 만들어.',
      '4) 결과를 hot-news-package.zip으로 묶어.',
      '5) 내 구글 메일로 보내.'
    ].join(' '),
    maxTools: 8
  });

  const required = [
    'news.fetchHeadlines',
    'browser.search',
    'filesystem.createTextFile',
    'filesystem.searchFiles',
    'filesystem.readText',
    'visual.createCards',
    'archive.createZip',
    'email.send'
  ];
  assert.equal(selection.selectedCount, 8);
  assert.deepEqual(new Set(selection.pinnedToolNames), new Set(required));
  for (const toolName of required) assert.ok(selection.selectedToolNames.includes(toolName), toolName);
  assert.equal(selection.selectedToolNames.includes('shell.execute'), false);
  assert.equal(selection.selectedToolNames.includes('desktop.control'), false);
});

test('shortlist retains C02 workbook, PNG-card and ZIP tools under catalog pressure', () => {
  const router = new SkillRouter();
  const selection = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: [
      '다음 작업을 순서대로 완료해줘.',
      'MDN 공식 문서를 웹에서 직접 읽어 promise-guide.md에 저장해.',
      'promise-matrix.xlsx를 만들고 두 파일을 workspace에서 다시 찾아 markdown을 읽어.',
      'cards/promise-all.png 카드를 만든 뒤 promise-package.zip으로 묶어.',
      '외부 전송, 이메일 발송, 결제, 계정 변경은 금지한다.'
    ].join(' '),
    maxTools: 7
  });

  const required = [
    'browser.search',
    'filesystem.createTextFile',
    'excel.createWorkbook',
    'filesystem.searchFiles',
    'filesystem.readText',
    'visual.createCards',
    'archive.createZip'
  ];
  assert.equal(selection.selectedCount, 7);
  for (const toolName of required) {
    assert.ok(selection.pinnedToolNames.includes(toolName), `not pinned: ${toolName}`);
    assert.ok(selection.selectedToolNames.includes(toolName), `not selected: ${toolName}`);
  }
  assert.equal(selection.selectedToolNames.includes('shell.execute'), false);
  assert.equal(selection.selectedToolNames.includes('desktop.control'), false);
  assert.equal(selection.pinnedToolNames.includes('email.send'), false);
});

test('shortlist pins explicit file listing and moves under catalog pressure', () => {
  const router = new SkillRouter();
  const selection = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: [
      '다음 작업을 순서대로 완료해줘.',
      '1) inbox 폴더를 나열해 파일을 확인해.',
      '2) 두 txt 파일을 reviewed 폴더로 이동해.',
      '3) 이동한 파일을 다시 읽어.',
      '4) 결과를 move-manifest.md에 저장해.',
      '5) 결과를 reviewed-package.zip으로 묶어.'
    ].join(' '),
    maxTools: 5
  });

  const required = [
    'filesystem.listFiles',
    'filesystem.moveFiles',
    'filesystem.readText',
    'filesystem.createTextFile',
    'archive.createZip'
  ];
  assert.equal(selection.selectedCount, 5);
  assert.deepEqual(new Set(selection.pinnedToolNames), new Set(required));
  for (const toolName of required) assert.ok(selection.selectedToolNames.includes(toolName), toolName);
});

test('negative artifact creation instructions retain read and search pins without pinning forbidden outputs', () => {
  const router = new SkillRouter();
  const settlement = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: [
      'ledger.csv와 approval.txt를 모두 읽어.',
      'workspace에서 required-rates.csv를 정확히 검색해.',
      '필수 파일 제공 전에는 settlement.xlsx, settlement-summary.md, settlement-package.zip을 생성하지 말아.'
    ].join(' '),
    maxTools: 8
  });
  const contract = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: [
      'contract-main.txt와 approval-rule.txt를 모두 읽어.',
      'workspace에서 annex-sla.csv를 정확히 검색해.',
      '부속서 제공 전에는 contract-approval.docx, contract-check.xlsx, contract-package.zip을 만들지 마.'
    ].join(' '),
    maxTools: 8
  });

  for (const selection of [settlement, contract]) {
    assert.ok(selection.pinnedToolNames.includes('filesystem.readText'));
    assert.ok(selection.pinnedToolNames.includes('filesystem.searchFiles'));
  }
  for (const toolName of ['excel.createWorkbook', 'filesystem.createTextFile', 'archive.createZip']) {
    assert.equal(settlement.pinnedToolNames.includes(toolName), false, toolName);
  }
  for (const toolName of ['word.create', 'excel.createWorkbook', 'archive.createZip']) {
    assert.equal(contract.pinnedToolNames.includes(toolName), false, toolName);
  }
});

test('affirmative artifact creation remains pinned after negation filtering', () => {
  const router = new SkillRouter();
  const selection = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: 'report.md를 작성하고 report.xlsx와 report.docx를 만든 뒤 report-package.zip으로 묶어.',
    maxTools: 4
  });

  const required = ['filesystem.createTextFile', 'excel.createWorkbook', 'word.create', 'archive.createZip'];
  assert.deepEqual(new Set(selection.pinnedToolNames), new Set(required));
});

test('text-file organization verbs pin createText only when joined to a supported filename', () => {
  const router = new SkillRouter();
  const named = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: '계산 결과를 maintenance-plan.md에 정리하고 핵심 수치를 shipping-brief.md에 명시해.',
    maxTools: 4
  });
  const unnamed = router.shortlistCapabilities(router.capabilityMatrix(), {
    objective: '계산 결과를 정리하고 핵심 수치를 명시해.',
    maxTools: 4
  });

  assert.ok(named.pinnedToolNames.includes('filesystem.createTextFile'));
  assert.equal(unnamed.pinnedToolNames.includes('filesystem.createTextFile'), false);
});

test('normal skill routes expose an auditable execution strategy', () => {
  const router = new SkillRouter();
  const routed = router.route({
    actionType: ActionType.SEARCH_FILES,
    category: 'filesystem',
    rawText: '작업 폴더에서 package.json 파일을 찾아',
    slots: { fileName: 'package.json' }
  });

  assert.equal(routed.routable, true);
  assert.equal(routed.skill.toolName, 'filesystem.searchFiles');
  assert.equal(routed.executionStrategy.channel, ExecutionChannel.DETERMINISTIC_LOCAL);
  assert.equal(routed.executionStrategy.modelRoundTrips, 0);
  assert.ok(routed.executionStrategy.fallbackToolNames.includes('shell.execute'));
});

test('mission planning prompt receives deferred tool ranks and fallback guidance', () => {
  const prompt = buildMissionPlanningPrompt({
    mission: {
      objective: '최신 자료를 조사해',
      successCriteria: [],
      constraints: [],
      remainingBudget: { waves: 2, actions: 4, plannerCalls: 2 },
      waveCount: 0
    },
    capabilities: [{
      toolName: 'browser.search',
      actionType: ActionType.BROWSER_SEARCH,
      readOnly: true,
      executionStrategy: {
        channel: ExecutionChannel.WEB_DOM,
        planningMode: 'deterministic',
        expectedLatencyMs: 2200,
        reliability: 0.88,
        modelRoundTrips: 0,
        rank: 1,
        fallbackToolNames: ['desktop.control']
      }
    }],
    capabilitySelection: {
      selectionVersion: 'a-deferred-tool-selection-v1',
      totalCount: 20,
      selectedCount: 1,
      deferredCount: 19
    },
    observations: [],
    today: '2026-08-18'
  });

  assert.match(prompt, /도구 지연 선택/);
  assert.match(prompt, /"executionChannel":"web-dom"/);
  assert.match(prompt, /fallbackToolNames/);
  assert.match(prompt, /구조화 로컬\/API\/MCP\/웹 DOM/);
});

test('mission runtime sends a relevant bounded catalog to the executive planner', async () => {
  const auditRoot = await mkdtemp(join(tmpdir(), 'jarvis-strategy-test-'));
  let capturedContext = null;
  const missionPlanner = {
    async planNextWave(context) {
      capturedContext = structuredClone(context);
      return {
        decision: 'blocked',
        summary: 'catalog captured',
        blockedReason: 'test-stop',
        actions: [],
        criteriaAssessment: [],
        fingerprint: 'test-catalog'
      };
    }
  };
  try {
    const runtime = createAgRuntime({
      auditRoot,
      allowedRoots: [join(auditRoot, 'workspace')],
      missionPlanner,
      missionMaxPlannerTools: 5,
      workerDaemonEnabled: false
    });
    const mission = runtime.missionRuntime.createMission({ objective: '파워포인트 발표 자료를 만들어' });
    await runtime.missionRuntime.runMission(mission.missionId);

    assert.equal(capturedContext.capabilities.length, 5);
    assert.equal(capturedContext.capabilitySelection.selectedCount, 5);
    assert.ok(capturedContext.capabilitySelection.totalCount > capturedContext.capabilitySelection.selectedCount);
    assert.ok(capturedContext.capabilitySelection.selectedToolNames.includes('powerpoint.create'));
  } finally {
    await rm(auditRoot, { recursive: true, force: true });
  }
});

function fakeSkill(toolName, channel, keywords, capabilityOverrides = {}) {
  return {
    skillId: toolName.replace(/[^a-z0-9]+/gi, '_'),
    version: '1.0.0',
    label: toolName,
    module: ModuleId.PC_AGENT,
    category: 'research',
    actionType: ActionType.BROWSER_SEARCH,
    toolName,
    match: { keywords },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: channel === ExecutionChannel.MCP_CONNECTOR || channel === ExecutionChannel.WEB_DOM,
      externalTransfer: false,
      reversible: false,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute'],
      ...capabilityOverrides
    },
    safety: { trustBoundary: TrustBoundary.USER_COMMAND },
    adapterContract: { preview: true, execute: true, rollback: false, evidence: ['result'] },
    lifecycle: { status: 'active', routable: true },
    execution: {
      channel,
      expectedLatencyMs: channel === ExecutionChannel.MCP_CONNECTOR ? 500 : channel === ExecutionChannel.WEB_DOM ? 2000 : 1800,
      reliability: channel === ExecutionChannel.MCP_CONNECTOR ? 0.96 : channel === ExecutionChannel.WEB_DOM ? 0.86 : 0.76,
      modelRoundTrips: channel === ExecutionChannel.DESKTOP_UIA ? 1 : 0,
      fallbackToolNames: channel === ExecutionChannel.MCP_CONNECTOR ? ['browser.search'] : channel === ExecutionChannel.WEB_DOM ? ['desktop.control'] : []
    }
  };
}
