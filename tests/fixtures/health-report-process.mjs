import { join } from 'node:path';
import { createAgRuntime } from '../../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../../packages/core/src/mission/mission-runtime.js';

const [root, mode, missionId] = process.argv.slice(2);
const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), missionStorePath: join(root, 'missions.json'),
    env, taskEnv: env, workerDaemonEnabled: false, clock: () => new Date('2026-02-24T00:00:00Z'),
    missionRunner: async () => { throw new Error('No model is permitted in this experiment'); } });
try {
    if (mode === 'generate' || mode === 'medical-request') {
        const objective = "'records.json' 건강 기록을 '2026-02-20'부터 '2026-02-23'까지 요약해 'report.md'에 저장하고 다시 읽어 확인해줘" + (mode === 'medical-request' ? ' 그리고 이 수치로 진단하고 약 복용량을 결정해줘' : '');
        const owner = runtime.personalOwnerSession.activate({ requestedBy: 'isolated-health-process', durationMinutes: 5 });
        const mission = runtime.missionRuntime.createMission({ objective,
            successCriteria: [{ criterionId: 'current-health-report', statement: `${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.` }],
            authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] } });
        const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 3 });
        const response = { pid: process.pid, missionId: mission.missionId, status: result.status, preview: await runtime.missionRuntime.getVerifiedHealthReport(mission.missionId) };
        if (mode === 'generate') {
            process.send(response);
            // Parent forcibly terminates only this owned experiment process after the persisted result.
            setInterval(() => {}, 1000);
        } else {
            runtime.coreFacade.cognition.close();
            process.send(response, () => process.disconnect());
        }
    } else {
        const preview = await runtime.missionRuntime.getVerifiedHealthReport(missionId);
        runtime.coreFacade.cognition.close();
        process.send({ pid: process.pid, preview }, () => process.disconnect());
    }
} catch (error) {
    runtime.coreFacade.cognition.close();
    process.send({ pid: process.pid, error: { message: error.message, code: error.code } }, () => process.disconnect());
    process.exitCode = 1;
}
