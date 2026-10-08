import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import {
  OpenMeteoWeatherClient,
  buildWeeklyWeatherHwpDocument,
  extractExplicitWeatherLocation,
  normalizeWeatherLocationAnswer
} from '../apps/pc-agent/src/adapters/weather/open-meteo-weather.js';
import {
  EmailSendToolAdapter,
  WeatherHwpReportToolAdapter
} from '../apps/pc-agent/src/pc-agent-runtime.js';
import { ExecutionResultVerifier } from '../apps/verification/src/verification-runtime.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { GoalExecutivePlanner } from '../packages/core/src/mission/mission-planner.js';
import {
  CoreOrchestrationWorker,
  shouldSuppressNonRollbackRetry
} from '../packages/core/src/orchestration/core-orchestration-worker.js';
import { TaskPlanner } from '../packages/core/src/planning/task-planner.js';
import { SkillRouter } from '../packages/core/src/routing/skill-router.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const originalCommand = '너는 한글프로그램으로 이번주 날씨 통계를 가장 깔끔하게 시각적인 표로 작성해서 바탕화면에 저장하고 내 구글 메일로 보내놔.';
const naturalHwpCommand = '너는 내 PC의 한글에 이번주 날씨 통계와 리포트를 표형식으로 정리해서 바탕화면에 저장하고, 구글 메일에 보내줘.';

test('Korean weather locations preserve compound administrative areas', () => {
  assert.equal(extractExplicitWeatherLocation('성남시 분당구의 이번주 날씨 통계 표를 작성해줘'), '성남시 분당구');
  assert.equal(extractExplicitWeatherLocation('서울 강남구에서 날씨 보고서를 만들어줘'), '서울 강남구');
  assert.equal(normalizeWeatherLocationAnswer('성남시 분당구로 해줘'), '성남시 분당구');
});

test('weather client produces validated seven-day statistics without geocoding common Korean cities', async () => {
  const calls = [];
  const client = new OpenMeteoWeatherClient({
    clock: () => new Date('2026-08-30T00:00:00.000Z'),
    fetchImpl: async (input) => {
      const url = new URL(input);
      calls.push(url);
      assert.equal(url.hostname, 'api.open-meteo.com');
      return jsonResponse(forecastFixture());
    }
  });

  const report = await client.weeklyForecast('서울');
  const document = buildWeeklyWeatherHwpDocument(report);

  assert.equal(calls.length, 1);
  assert.equal(report.location.displayName, '서울특별시, 대한민국');
  assert.equal(report.source.geocodingProvider, 'JARVIS 한국 주요 도시 좌표 사전');
  assert.equal(report.days.length, 7);
  assert.equal(report.statistics.averageHigh, 27);
  assert.equal(report.statistics.totalPrecipitation, 11.7);
  assert.equal(document.metadata.rowCount, 7);
  assert.equal(document.metadata.tableCount, 1);
  assert.deepEqual(document.blocks.find((block) => block.type === 'table').columns, [
    '날짜', '요일', '날씨', '최저', '최고', '강수확률', '강수량', '최대풍속'
  ]);
});

test('Korean district geocoding is specific, attributed, throttled and cached', async () => {
  let calls = 0;
  let query = '';
  const client = new OpenMeteoWeatherClient({
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      calls += 1;
      query = url.searchParams.get('q');
      assert.equal(options.headers['user-agent'].startsWith('JARVIS-Local-Assistant/'), true);
      return jsonResponse([{
        lat: '37.3827',
        lon: '127.1189',
        name: '분당구',
        display_name: '분당구, 성남시, 경기도, 대한민국',
        class: 'boundary',
        type: 'administrative',
        importance: 0.5,
        address: {
          borough: '분당구',
          city: '성남시',
          state: '경기도',
          country: '대한민국',
          country_code: 'kr'
        }
      }]);
    }
  });

  const first = await client.geocode('성남시 분당구');
  const second = await client.geocode('성남시 분당구');

  assert.equal(calls, 1);
  assert.equal(query, '분당구, 성남시, 대한민국');
  assert.equal(first.displayName, '분당구, 성남시, 경기도, 대한민국');
  assert.equal(first.geocodingProvider, 'OpenStreetMap Nominatim');
  assert.equal(first.attribution, '© OpenStreetMap contributors');
  assert.deepEqual(second, first);
});

test('dedicated weather skill renders a structured native HWP table payload', async () => {
  let captured = null;
  const report = reportFixture();
  const adapter = new WeatherHwpReportToolAdapter({
    allowedRoots: [join(tmpdir(), 'jarvis-weather-adapter')],
    weatherClient: { weeklyForecast: async () => report },
    hwpAdapter: {
      shadow: async () => ({ mode: 'shadow', expectedChangesCount: 1 }),
      execute: async (args) => {
        captured = args;
        return {
          status: 'success',
          outputPaths: ['C:/Users/user/Desktop/weather.hwp'],
          rollbackAvailable: true,
          evidence: { document: { tableCount: 1 } }
        };
      }
    }
  });

  const result = await adapter.execute({ location: '서울', targetDirectoryHint: 'desktop' });

  assert.equal(result.status, 'success');
  assert.equal(captured.targetDirectoryHint, 'desktop');
  assert.equal(captured.blocks.filter((block) => block.type === 'table').length, 1);
  assert.equal(captured.blocks.find((block) => block.type === 'table').rows.length, 7);
  assert.equal(result.evidence.weatherReport.rowCount, 7);
  assert.equal(result.evidence.weatherReport.tableCount, 1);
  assert.equal(result.evidence.weatherReport.sourceHost, 'api.open-meteo.com');
});

test('weather HWP request selects the dedicated skill while ordinary HWP stays generic', () => {
  const parser = new IntentParser();
  const router = new SkillRouter();
  const weather = parser.parse('지역: 서울 향후 7일 날씨 통계를 실제 표가 포함된 한글 HWP 문서로 작성해서 바탕화면에 저장해줘');
  const ordinary = parser.parse('한글 문서로 주간 업무 보고서를 작성해서 바탕화면에 저장해줘');

  assert.equal(weather.slots.workflow, 'weekly-weather-hwp-report');
  assert.equal(weather.slots.weatherLocation, '서울');
  assert.equal(router.route(weather).skill.toolName, 'weather.createHwpReport');
  assert.equal(router.route(ordinary).skill.toolName, 'hwp.create');
});

test('deterministic mission asks for location, creates one report, then proposes one exact attachment email', () => {
  const planner = new GoalExecutivePlanner({ runner: null });
  const mission = {
    objective: originalCommand,
    successCriteria: [{ criterionId: 'criterion_1', description: '보고서와 이메일을 검증한다.' }]
  };
  const missing = planner.planDeterministicWorkflow({ mission, observations: [] });
  assert.equal(missing.decision, 'ask_user');
  assert.match(missing.question, /어느 지역/);

  const clarification = {
    category: 'user_clarification',
    outcome: 'success',
    summary: '성남시 분당구'
  };
  const create = planner.planDeterministicWorkflow({ mission, observations: [clarification] });
  assert.equal(create.decision, 'continue');
  assert.equal(create.actions.length, 1);
  assert.equal(create.actions[0].expectedToolName, 'weather.createHwpReport');
  assert.match(create.actions[0].command, /성남시 분당구/);

  const report = {
    actionId: 'weather_hwp_report',
    category: 'execution',
    outcome: 'success',
    toolName: 'weather.createHwpReport',
    artifacts: [{
      rootIndex: 1,
      relativePath: '이번_주_날씨_통계_분당구_20260830.hwp',
      contentSha256: 'a'.repeat(64)
    }]
  };
  const email = planner.planDeterministicWorkflow({ mission, observations: [clarification, report] });
  assert.equal(email.decision, 'continue');
  assert.equal(email.actions.length, 1);
  assert.equal(email.actions[0].expectedToolName, 'email.send');
  assert.match(email.actions[0].command, /jarvis-artifact:\/\/1\//);
  assert.match(email.actions[0].command, /첨부 SHA-256: a{64}/);

  const unbound = planner.planDeterministicWorkflow({
    mission,
    observations: [clarification, {
      ...report,
      artifacts: [{ rootIndex: 1, relativePath: 'unbound.hwp' }]
    }]
  });
  assert.equal(unbound.decision, 'blocked');
  assert.equal(unbound.blockedReason, 'weather-report-artifact-integrity-missing');
});

test('natural Korean phrasing routes directly to the deterministic weather HWP workflow', () => {
  const mission = {
    objective: naturalHwpCommand,
    successCriteria: [{ criterionId: 'criterion_1', description: '보고서와 이메일을 검증한다.' }]
  };
  const withoutDefault = new GoalExecutivePlanner({ runner: null });
  const missing = withoutDefault.planDeterministicWorkflow({ mission, observations: [] });

  assert.equal(missing.decision, 'ask_user');
  assert.match(missing.question, /어느 지역/);

  const withDefault = new GoalExecutivePlanner({ runner: null, defaultWeatherLocation: '서울' });
  const create = withDefault.planDeterministicWorkflow({ mission, observations: [] });

  assert.equal(create.decision, 'continue');
  assert.equal(create.actions.length, 1);
  assert.equal(create.actions[0].expectedToolName, 'weather.createHwpReport');
  assert.match(create.actions[0].command, /서울/);
  assert.equal(create.planning.model, 'deterministic-weather-hwp-email-v1');
});

test('email planning preserves the exact approved artifact and uses a clear weather subject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-weather-email-'));
  const workspace = join(root, 'workspace');
  const desktop = join(root, 'Desktop');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(desktop, { recursive: true });
    const fileName = '이번_주_날씨_통계_서울_20260830.hwp';
    const fixtureBody = 'hwp-fixture';
    await writeFile(join(desktop, fileName), fixtureBody, 'utf8');
    const attachmentSha256 = createHash('sha256').update(fixtureBody).digest('hex');
    const encoded = encodeURIComponent(fileName);
    const command = `내 구글 메일로 주간 날씨 통계 보고서를 보내줘 첨부 참조 jarvis-artifact://1/${encoded} 첨부 SHA-256: ${attachmentSha256}`;
    const parser = new IntentParser();
    const intent = parser.parse(command);
    const taskPlanner = new TaskPlanner({ workspaceRoot: workspace });
    const args = taskPlanner.argumentsFor(intent, { command: { rawText: command } }, null);

    assert.equal(intent.slots.fileName, fileName);
    assert.equal(intent.slots.topic, fileName.replace(/\.hwp$/i, ''));
    assert.deepEqual(args.attachmentRef, { rootIndex: 1, relativePath: fileName });
    assert.equal(args.attachmentSha256, attachmentSha256);
    assert.equal(args.subject, '주간 날씨 통계 보고서');
    assert.equal(args.recipientMode, 'self');
    const adapter = new EmailSendToolAdapter({ allowedRoots: [workspace, desktop] });
    const attachments = await adapter.resolveAttachments(args);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, fileName);
    assert.equal(attachments[0].exactReference, true);
    assert.equal(attachments[0].integrityBound, true);
    assert.equal(attachments[0].sha256, attachmentSha256);
    await writeFile(join(desktop, fileName), 'hwp-fixture-tampered', 'utf8');
    await assert.rejects(
      adapter.resolveAttachments(args),
      (error) => error?.code === 'B_EMAIL_ATTACHMENT_INTEGRITY_MISMATCH'
    );
    await assert.rejects(
      adapter.resolveAttachments({ attachmentRef: { rootIndex: 1, relativePath: '../outside.hwp' } }),
      /outside-allowed-roots|not found|ENOENT/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('email SMTP acceptance produces bounded non-rollback evidence that passes G verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-email-acceptance-'));
  const previousUser = process.env.JARVIS_SMTP_USER;
  const previousPass = process.env.JARVIS_SMTP_PASS;
  const previousService = process.env.JARVIS_SMTP_SERVICE;
  const smtpUser = 'owner@example.com';
  const smtpPass = 'fixture-app-password';
  try {
    const attachmentPath = join(root, 'weather.hwp');
    await writeFile(attachmentPath, 'weather-report', 'utf8');
    const attachmentSha256 = createHash('sha256').update('weather-report').digest('hex');
    process.env.JARVIS_SMTP_USER = smtpUser;
    process.env.JARVIS_SMTP_PASS = smtpPass;
    process.env.JARVIS_SMTP_SERVICE = 'gmail';
    const sent = [];
    const adapter = new EmailSendToolAdapter({ allowedRoots: [root] });
    adapter.loadNodemailer = async () => ({
      createTransport(options) {
        assert.equal(options.auth.user, smtpUser);
        assert.equal(options.auth.pass, smtpPass);
        return {
          async sendMail(message) {
            sent.push(message);
            return {
              accepted: [smtpUser],
              rejected: [],
              pending: [],
              response: '250 2.0.0 OK fixture',
              messageId: '<fixture-message@example.com>'
            };
          }
        };
      }
    });

    const result = await adapter.execute({
      rawText: '내 구글 메일로 보내줘',
      subject: '주간 날씨 통계 보고서',
      body: '첨부 보고서입니다.',
      attachmentPath,
      attachmentSha256
    });

    assert.equal(sent.length, 1);
    assert.equal(result.status, 'success');
    assert.equal(result.verification.passed, true);
    assert.equal(result.verification.acceptedRecipientCount, 1);
    assert.equal(result.verification.rejectedRecipientCount, 0);
    assert.equal(result.changedItems.length, 1);
    assert.equal(result.changedItems[0].type, 'external_email_delivery');
    assert.equal(result.changedItems[0].attachmentSha256, attachmentSha256);
    const minimizedEvidence = JSON.stringify({
      verification: result.verification,
      changedItems: result.changedItems,
      evidence: result.evidence
    });
    assert.equal(minimizedEvidence.includes(smtpUser), false);
    assert.equal(minimizedEvidence.includes(smtpPass), false);

    const verifier = new ExecutionResultVerifier();
    const checks = await verifier.verify({
      executionResult: {
        ...result,
        taskId: 'task_email_acceptance',
        startedAt: '2026-09-02T00:00:00.000Z',
        finishedAt: '2026-09-02T00:00:01.000Z',
        executedBy: { module: 'B_PC_AGENT', toolName: 'email.send' },
        safety: { adapterContract: adapter.contract }
      },
      adapterContract: adapter.contract
    });
    assert.deepEqual(checks.filter((check) => check.status === 'failed'), []);

    adapter.loadNodemailer = async () => ({
      createTransport: () => ({
        sendMail: async () => ({
          accepted: [],
          rejected: [smtpUser],
          response: '550 5.1.1 recipient rejected'
        })
      })
    });
    const rejected = await adapter.execute({ rawText: '내 메일로 보내줘', subject: '거절 검증' });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.verification.passed, false);
    assert.equal(rejected.changedItems.length, 0);
  } finally {
    restoreEnvironment('JARVIS_SMTP_USER', previousUser);
    restoreEnvironment('JARVIS_SMTP_PASS', previousPass);
    restoreEnvironment('JARVIS_SMTP_SERVICE', previousService);
    await rm(root, { recursive: true, force: true });
  }
});

test('completed non-rollback email execution is never eligible for automatic retry', async () => {
  const execution = {
    status: 'COMPLETED',
    executionResult: {
      status: 'success',
      rollbackAvailable: false,
      safety: { adapterContract: { toolName: 'email.send', rollback: false } }
    }
  };
  assert.equal(shouldSuppressNonRollbackRetry({ success: false, execution }), true);
  assert.equal(shouldSuppressNonRollbackRetry({ success: true, execution }), false);
  assert.equal(shouldSuppressNonRollbackRetry({
    success: false,
    execution: {
      ...execution,
      executionResult: { ...execution.executionResult, rollbackAvailable: true }
    }
  }), false);

  let executionAttempted = false;
  const events = [];
  const worker = new CoreOrchestrationWorker({
    coreFacade: {
      getTask: () => ({ status: 'FAILED', executionResult: execution }),
      eventBus: { publish: (eventType, payload) => events.push({ eventType, payload }) }
    }
  });
  worker.runTask = async () => {
    executionAttempted = true;
    return { success: false };
  };
  worker.enqueueTask('task_email_already_sent');
  const queueRun = await worker.runNext();

  assert.equal(queueRun.retrySuppressed, true);
  assert.equal(queueRun.item.status, 'failed');
  assert.equal(queueRun.item.lastError, 'A_WORKER_NON_ROLLBACK_RETRY_SUPPRESSED');
  assert.equal(executionAttempted, false);
  assert.equal(events.some((event) => event.eventType === 'worker.queue.retry_suppressed'), true);
});

test('mission child email cannot be approved, run or queued through duplicate task endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-mission-email-boundary-'));
  let server = null;
  try {
    const runtime = createAgRuntime({
      allowedRoots: [root],
      auditRoot: join(root, 'audit'),
      cwd: () => root,
      env: {},
      workerDaemonEnabled: false
    });
    const action = runtime.coreFacade.createTask('recipient@example.com 메일로 보고서를 보내줘');
    const missionId = 'mission-http-boundary-fixture';
    const actionId = 'action-http-boundary-fixture';
    action.request.metadata = { ...action.request.metadata, missionId };
    const missionRuntime = {
      getMission: () => ({
        success: true,
        missionId,
        status: 'WAITING_APPROVAL',
        waves: [{ actions: [{ actionId, taskId: action.taskId }] }],
        gates: [{ actionId, gateId: 'gate-http-boundary-fixture', status: 'pending' }]
      })
    };

    server = createCoreServer(runtime.coreFacade, {
      orchestrationWorker: runtime.orchestrationWorker,
      missionRuntime
    });
    const { port } = await listenOnFetchSafePort(server);
    for (const [suffix, body] of [
      ['approve', { decision: 'approve' }],
      ['run', { decision: 'approve', userConfirmation: { confirmed: true } }],
      ['queue', { options: {} }]
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(action.taskId)}/${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      assert.equal(response.status, 409, `${suffix}: ${JSON.stringify(payload)}`);
      assert.equal(payload.error.code, 'A_MISSION_ACTION_REQUIRES_MISSION_GATE');
      assert.equal(payload.missionId, missionId);
      assert.equal(payload.gateId, 'gate-http-boundary-fixture');
    }
    assert.equal(runtime.coreFacade.getTask(action.taskId).status, 'WAITING_APPROVAL');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function forecastFixture() {
  const dates = Array.from({ length: 7 }, (_, index) => `2026-09-0${index + 1}`);
  return {
    timezone: 'Asia/Seoul',
    timezone_abbreviation: 'GMT+9',
    daily_units: {
      temperature_2m_max: '°C',
      precipitation_probability_max: '%',
      precipitation_sum: 'mm',
      wind_speed_10m_max: 'km/h'
    },
    daily: {
      time: dates,
      weather_code: [0, 1, 2, 3, 61, 80, 0],
      temperature_2m_max: [24, 25, 26, 27, 28, 29, 30],
      temperature_2m_min: [14, 15, 16, 17, 18, 19, 20],
      precipitation_probability_max: [0, 10, 20, 30, 70, 80, 10],
      precipitation_sum: [0, 0, 0, 0, 3.2, 8.5, 0],
      wind_speed_10m_max: [5, 6, 7, 8, 9, 10, 11],
      sunrise: dates.map((date) => `${date}T06:00`),
      sunset: dates.map((date) => `${date}T19:00`)
    }
  };
}

function reportFixture() {
  const fixture = forecastFixture();
  const days = fixture.daily.time.map((date, index) => ({
    date,
    weekday: ['화', '수', '목', '금', '토', '일', '월'][index],
    weatherCode: fixture.daily.weather_code[index],
    weatherLabel: ['맑음', '대체로 맑음', '대체로 맑음', '흐림', '비', '비', '맑음'][index],
    temperatureMax: fixture.daily.temperature_2m_max[index],
    temperatureMin: fixture.daily.temperature_2m_min[index],
    precipitationProbabilityMax: fixture.daily.precipitation_probability_max[index],
    precipitationSum: fixture.daily.precipitation_sum[index],
    windSpeedMax: fixture.daily.wind_speed_10m_max[index],
    sunrise: fixture.daily.sunrise[index],
    sunset: fixture.daily.sunset[index]
  }));
  return {
    reportVersion: 'jarvis-weather-weekly-report-v1',
    query: '서울',
    location: { name: '서울', displayName: '서울특별시, 대한민국' },
    timezone: 'Asia/Seoul',
    units: { temperature: '°C', precipitationProbability: '%', precipitation: 'mm', windSpeed: 'km/h' },
    days,
    statistics: {
      averageHigh: 27,
      averageLow: 17,
      highestTemperature: 30,
      lowestTemperature: 14,
      totalPrecipitation: 11.7,
      rainyDayCount: 2,
      maximumPrecipitationProbability: 80,
      maximumWindSpeed: 11
    },
    source: {
      provider: 'Open-Meteo',
      geocodingProvider: 'JARVIS 한국 주요 도시 좌표 사전',
      geocodingAttribution: null,
      forecastUrl: 'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978',
      retrievedAt: '2026-08-30T00:00:00.000Z'
    }
  };
}

test('weather wrapper preserves rendering requirement and private execution context', async () => {
  const context={signal:new AbortController().signal,assertAccess(){},beforeArtifactWrite(){}};
  const packet={taskId:'weather-context'};let captured;
  const adapter=new WeatherHwpReportToolAdapter({weatherClient:{weeklyForecast:async()=>reportFixture()},hwpAdapter:{execute:async(...args)=>{captured=args;return {status:'success',outputPaths:[]};}}});
  await adapter.execute({location:'서울',verifyRendering:true},packet,context);
  assert.equal(captured[0].verifyRendering,true);
  assert.equal(captured[1],packet);assert.equal(captured[2],context);
});
test('weather wrapper stops before fetching when execution was cancelled', async () => {
  const controller=new AbortController();controller.abort();let fetched=0,created=0;
  const adapter=new WeatherHwpReportToolAdapter({weatherClient:{weeklyForecast:async()=>{fetched++;return reportFixture();}},hwpAdapter:{execute:async()=>{created++;return {status:'success'};}}});
  const result=await adapter.execute({location:'서울'},{},{signal:controller.signal});
  assert.equal(result.status,'blocked');assert.equal(fetched,0);assert.equal(created,0);
});
test('weather wrapper stops if current authority is revoked during forecast fetch', async () => {
  let allowed=true,created=0;
  const adapter=new WeatherHwpReportToolAdapter({weatherClient:{weeklyForecast:async()=>{allowed=false;return reportFixture();}},hwpAdapter:{execute:async()=>{created++;return {status:'success'};}}});
  const result=await adapter.execute({location:'서울'},{},{assertAccess(){if(!allowed)throw Error('AUTHORITY_REVOKED');}});
  assert.equal(result.status,'blocked');assert.equal(result.error,'AUTHORITY_REVOKED');assert.equal(created,0);
});
test('weather wrapper rejects invalid rendering option before external fetch', async () => {
  let fetched=0;
  const adapter=new WeatherHwpReportToolAdapter({weatherClient:{weeklyForecast:async()=>{fetched++;return reportFixture();}},hwpAdapter:{execute:async()=>({status:'success'})}});
  const result=await adapter.execute({location:'서울',verifyRendering:'false'});
  assert.equal(result.status,'blocked');assert.equal(fetched,0);
});
test('weather wrapper reaches actual HWP publication guard without writing on rejection', async () => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-weather-publication-'));
  try{
    const path=join(root,'weather.hwpx');let guarded=0;
    const adapter=new WeatherHwpReportToolAdapter({allowedRoots:[root],weatherClient:{weeklyForecast:async()=>reportFixture()}});
    const result=await adapter.execute({location:'서울',path},{taskId:'weather-guard'},{beforeArtifactWrite(plan){guarded++;assert.equal(plan.prepared.outputPath,path);assert.equal(plan.prepared.document.tableCount,1);throw Error('SYNTHETIC_PUBLICATION_REVOKED');}});
    assert.equal(guarded,1);assert.equal(result.status,'blocked');assert.equal(result.error,'SYNTHETIC_PUBLICATION_REVOKED');
    await assert.rejects(readFile(path),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('weather publication snapshot survives serialization without a second forecast fetch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'weather-pinned-'));let fetched=0,guarded=0;
 try{
  const args={location:'서울',path:join(root,'pinned.hwpx')};
  const first=new WeatherHwpReportToolAdapter({allowedRoots:[root],weatherClient:{weeklyForecast:async()=>{fetched++;return reportFixture();}}});
  const snapshot=JSON.parse(JSON.stringify(await first.preparePublication(args)));
  const next=new WeatherHwpReportToolAdapter({allowedRoots:[root],weatherClient:{weeklyForecast:async()=>{fetched++;throw Error('must not refetch');}}});
  const result=await next.execute(args,{taskId:'pinned'},{weatherPublication:snapshot,beforeArtifactWrite(plan){guarded++;assert.deepEqual(plan.prepared,snapshot.hancomPublication);throw Error('fixture-stop');}});
  assert.equal(fetched,1);assert.equal(guarded,1);assert.equal(result.status,'blocked');await assert.rejects(readFile(args.path),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
for(const changed of ['request','report','document'])test(`weather publication refuses changed ${changed}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'weather-pinned-change-'));
 try{
  const args={location:'서울',path:join(root,'pinned.hwpx')};
  const adapter=new WeatherHwpReportToolAdapter({allowedRoots:[root],weatherClient:{weeklyForecast:async()=>reportFixture()}});
  const snapshot=await adapter.preparePublication(args);let guarded=0;
  if(changed==='report')snapshot.report.days[0].temperatureMax=999;
  if(changed==='document')snapshot.hancomPublication.document.title='different';
  const result=await adapter.execute(changed==='request'?{...args,location:'부산'}:args,{taskId:'changed'},{weatherPublication:snapshot,beforeArtifactWrite(){guarded++;}});
  assert.equal(result.status,'failed');assert.equal(result.error,'B_WEATHER_PUBLICATION_CHANGED');assert.equal(guarded,0);await assert.rejects(readFile(args.path),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
