import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import { FileMissionStore } from '../packages/core/src/mission/mission-store.js';

const fixture = process.env.JARVIS_G01_FIXTURE_PATH
  ? JSON.parse(await readFile(process.env.JARVIS_G01_FIXTURE_PATH, 'utf8'))
  : JSON.parse(await readFile(new URL('./fixtures/agent-platform-g01-public-sources.json', import.meta.url), 'utf8'));
const collaborationGroupId = 'g01-public-source-report';

function continueWith(actions, summary = 'G01 역할 단계 진행') {
  return { decision: 'continue', summary, actions, criteriaAssessment: [] };
}

class G01Planner {
  constructor({ sources, sourcePaths, outputPath, reportContent }) {
    this.sources = sources;
    this.sourcePaths = sourcePaths;
    this.outputPath = outputPath;
    this.reportContent = reportContent;
    this.calls = 0;
  }

  async planNextWave(context) {
    this.calls += 1;
    const observations = context.observations.filter(item => item.outcome === 'success');
    const readPaths = new Set(observations.filter(item => item.toolName === 'filesystem.readText')
      .map(item => item.data?.fileEvidence?.relativePath).filter(Boolean));
    const unreadPaths = this.sourcePaths.filter(path => !readPaths.has(`sources/${path.split(/[\\/]/u).at(-1)}`));
    const editorWrite = observations.some(item => item.toolName === 'filesystem.createTextFile');
    if (unreadPaths.length > 0) {
      return continueWith(unreadPaths.map((path, index) => ({
        id: `research-source-${readPaths.size + index + 1}`,
        title: `연구자가 공개 출처 ${readPaths.size + index + 1} 확인`,
        command: `${path} 공개 자료를 읽어줘`,
        expectedToolName: 'filesystem.readText',
        arguments: { path, maxChars: 12_000 },
        dependencies: [],
        collaborationGroupId,
        workerRole: 'researcher',
        successSignal: '공개 출처 원문과 근거가 G 검증됨'
      })));
    }
    if (!editorWrite) {
      assert.equal(observations.filter(item => item.toolName === 'filesystem.readText').length, this.sourcePaths.length);
      for (const source of this.sources) assert.ok(observations.some(item => item.data?.stdoutPreview?.includes(source.quote)));
      return continueWith([{
        id: 'editor-final-report', title: '편집자가 근거 보고서 하나로 통합',
        command: '공개 자료 두 건의 주장과 인용 및 출처 URL을 report.md 하나에 정리해줘',
        expectedToolName: 'filesystem.createTextFile',
        arguments: { path: this.outputPath, content: this.reportContent },
        dependencies: [], collaborationGroupId, workerRole: 'editor',
        successSignal: '두 출처별 주장·연속 인용·정확한 URL을 포함한 report.md 생성 및 검증'
      }]);
    }
    const verified = observations.some(item => item.toolName === 'filesystem.readText'
      && item.data?.fileEvidence?.relativePath === 'report.md' && item.data?.stdoutPreview === this.reportContent);
    if (!verified) return continueWith([{
      id: 'verifier-read-final-report', title: '검증자가 최종 보고서를 다시 읽음',
      command: 'report.md 파일을 읽어줘', expectedToolName: 'filesystem.readText',
      arguments: { path: this.outputPath, maxChars: 12_000 }, dependencies: [],
      collaborationGroupId, workerRole: 'verifier', successSignal: '최종 단일 보고서를 다시 읽고 G 증거 확인'
    }]);
    return {
      decision: 'complete', summary: '검증자가 두 공개 출처의 보고서를 확인했습니다.',
      criteriaAssessment: context.successCriteria.map(criterion => ({ criterionId: criterion.criterionId, status: 'satisfied' }))
    };
  }
}

function reportFor(sources) {
  return [
    '# W3C WCAG 2.2 공개 자료 요약',
    ...sources.flatMap(source => [
      `## ${source.title}`,
      `요약 주장: ${source.claim}`,
      `근거 원문: ${source.quote}`,
      `출처 URL: ${source.url}`
    ])
  ].join('\n');
}

test('G01 local Mission divides public-source reads by role, rejects editor source access, and verifies one cited report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-agent-platform-g01-'));
  const workspace = join(root, 'workspace');
  const sourceDirectory = join(workspace, 'sources');
  const missionStorePath = join(root, 'missions.json');
  const deniedMissionStorePath = join(root, 'denied-missions.json');
  const reportContent = reportFor(fixture.sources);
  const sourcePaths = fixture.sources.map((source, index) => join(sourceDirectory, `source-${index + 1}.json`));
  const outputPath = join(workspace, 'report.md');
  let runtime = null;
  let deniedRuntime = null;
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(workspace, 'researcher-private-notes.txt'), '조사자 전용 내부 작업 메모', 'utf8');
    for (let index = 0; index < fixture.sources.length; index += 1) {
      await writeFile(sourcePaths[index], JSON.stringify(fixture.sources[index], null, 2), 'utf8');
    }
    const planner = new G01Planner({ sources: fixture.sources, sourcePaths, outputPath, reportContent });
    runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'audit'), cwd: () => workspace,
      env: {}, missionPlanner: planner, workerDaemonEnabled: false,
      missionStore: new FileMissionStore({ filePath: missionStorePath }) });
    const objective = '공개 자료 두 건을 조사자와 편집자가 나눠 맡고, 검증자가 출처를 대조해 하나의 report.md로 정리한다.';
    const created = runtime.missionRuntime.createMission({ objective,
      successCriteria: [
        { statement: 'report.md 파일이 두 출처의 주장을 정확한 인용과 출처 URL로 담는다.',
          verificationSpec: { version: 1, kind: 'text.equals', path: 'report.md', equals: reportContent } },
        { statement: 'report.md 파일을 읽어줘.' }
      ], authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] } });
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.status, MissionStatus.COMPLETED, JSON.stringify(completed));
    assert.equal(completed.completion.status, 'verified');
    assert.equal(await readFile(outputPath, 'utf8'), reportContent);
    const actions = completed.waves.flatMap(wave => wave.actions);
    assert.deepEqual(actions.map(item => item.workerRole), ['researcher', 'researcher', 'editor', 'verifier']);
    assert.ok(actions.every(item => item.collaborationGroupId === collaborationGroupId && item.roleScope?.allowed === true));
    assert.deepEqual(actions.map(item => item.actualToolName), [
      'filesystem.readText', 'filesystem.readText', 'filesystem.createTextFile', 'filesystem.readText'
    ]);
    assert.ok(completed.observations.filter(item => item.outcome === 'success')
      .every(item => item.verification?.status === 'passed' && item.evidenceId));

    const deniedPlanner = { calls: 0, async planNextWave() { this.calls += 1; return continueWith([{
      id: 'editor-private-read', title: '편집자가 조사자 전용 메모 요청',
      command: 'researcher-private-notes.txt 내용을 보여줘', expectedToolName: 'filesystem.readText',
      arguments: { path: join(workspace, 'researcher-private-notes.txt'), maxChars: 12_000 },
      dependencies: [], collaborationGroupId, workerRole: 'editor', successSignal: '내부 메모 확인'
    }]); } };
    deniedRuntime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(root, 'denied-audit'), cwd: () => workspace,
      env: {}, missionPlanner: deniedPlanner, workerDaemonEnabled: false,
      missionStore: new FileMissionStore({ filePath: deniedMissionStorePath }) });
    const deniedCreated = deniedRuntime.missionRuntime.createMission({ objective: 'G01 실패 주입: 편집자가 조사자 전용 메모를 읽으려 한다.',
      authorization: { grants: [MissionGrant.READ_ONLY] } });
    const denied = await deniedRuntime.missionRuntime.runMission(deniedCreated.missionId);
    assert.equal(denied.status, MissionStatus.PAUSED);
    assert.match(denied.stopReason, /^mission-role-scope-editor-requires-local-artifact-write/u);
    assert.ok(denied.observations.some(item => item.outcome !== 'success'), JSON.stringify(denied.observations));
    assert.equal(deniedPlanner.calls, 1);

    const capturePath = process.env.JARVIS_G01_ORACLE_EVIDENCE_PATH;
    if (typeof capturePath === 'string' && capturePath.length > 0) {
      const saved = JSON.parse(await readFile(missionStorePath, 'utf8'));
      const durableMission = saved.missions.find(item => item.missionId === created.missionId);
      const deniedSaved = JSON.parse(await readFile(deniedMissionStorePath, 'utf8'));
      const durableDeniedMission = deniedSaved.missions.find(item => item.missionId === deniedCreated.missionId);
      const sourceEvidence = [];
      for (let index = 0; index < sourcePaths.length; index += 1) {
        const bytes = await readFile(sourcePaths[index]);
        sourceEvidence.push({ relativePath: `sources/source-${index + 1}.json`, byteLength: bytes.length,
          base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const reportBytes = await readFile(outputPath);
      await writeFile(capturePath, `${JSON.stringify({
        schemaVersion: 1, scenarioId: fixture.captureMode === 'fresh-public-http-get' ? 'G01-LIVE' : 'G01', fixture,
        result: { missionId: completed.missionId, status: completed.status,
          actions: actions.map(item => ({ actionId: item.actionId, status: item.status, workerRole: item.workerRole,
            collaborationGroupId: item.collaborationGroupId, actualToolName: item.actualToolName,
            relativePath: item.arguments?.path ? item.arguments.path.replace(`${workspace}\\`, '').replaceAll('\\', '/') : null,
            observationId: item.observationId, roleScope: item.roleScope })),
          observations: completed.observations.map(item => ({ actionId: item.actionId, observationId: item.observationId,
            toolName: item.toolName, outcome: item.outcome, verification: item.verification, evidenceId: item.evidenceId })) },
        durableMission: { missionId: durableMission?.missionId, status: durableMission?.status,
          actionIds: durableMission?.waves.flatMap(wave => wave.actions.map(item => item.actionId)),
          observationIds: durableMission?.observations.map(item => item.observationId) },
        deniedAttempt: { missionId: denied.missionId, status: denied.status, stopReason: denied.stopReason,
          actions: denied.waves.flatMap(wave => wave.actions).map(item => ({ actionId: item.actionId,
            status: item.status, workerRole: item.workerRole, actualToolName: item.actualToolName, roleScope: item.roleScope,
            relativePath: item.arguments?.path ? item.arguments.path.replace(`${workspace}\\`, '').replaceAll('\\', '/') : null })),
          observations: denied.observations.map(item => ({ actionId: item.actionId, outcome: item.outcome,
            error: item.error, verification: item.verification })) },
        durableDeniedMission: { missionId: durableDeniedMission?.missionId, status: durableDeniedMission?.status,
          stopReason: durableDeniedMission?.stopReason },
        sources: sourceEvidence,
        workspaceFiles: await readdir(workspace),
        artifact: { relativePath: 'report.md', byteLength: reportBytes.length, base64: reportBytes.toString('base64'),
          sha256: createHash('sha256').update(reportBytes).digest('hex') }
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
  } finally {
    runtime?.workerDaemon?.stop?.({ reason: 'test-finished' });
    runtime?.coreFacade.cognition?.close?.();
    deniedRuntime?.workerDaemon?.stop?.({ reason: 'test-finished' });
    deniedRuntime?.coreFacade.cognition?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
