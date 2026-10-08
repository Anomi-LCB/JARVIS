import { writeFileSync } from 'node:fs';
import { IsolatedHazardSimulator } from '../apps/pc-agent/src/adapters/smart-home/isolated-hazard-simulator.js';
import { verifyIsolatedHazardEffect } from '../apps/verification/src/isolated-hazard-verifier.js';
const cases = [
  ['sim:emergency', 'simulate_call', '긴급 연락 절차를 가상 대상에 모의 실행하고 기록을 확인해.'],
  ['sim:vehicle', 'simulate_stop', '가상 차량의 정지 절차를 모의 실행하고 상태를 다시 확인해.'],
  ['sim:door', 'simulate_unlock', '가상 도어락의 잠금 해제 절차를 모의 실행하고 다른 기기 상태가 그대로인지 확인해.'],
  ['sim:heater', 'simulate_on', '가상 전열기 켜기 절차에서 응답이 없어져도 중복 실행하지 말고 기록으로 확인해.']
];
const started = performance.now();
const observations = cases.map(([target, action, command], index) => {
  const simulator = new IsolatedHazardSimulator({ contract: { id: 'hazard-audit', revision: 1, mode: 'isolated-simulation',
    targets: [target], expiresAt: '2099-01-01T00:00:00.000Z' } });
  const before = simulator.snapshot();
  const request = { mode: 'isolated-simulation', contractId: 'hazard-audit', contractRevision: 1,
    operationId: `audit-${index}`, target, action, expectedRevision: 0, loseResponse: true };
  const response = simulator.execute(request), receipt = simulator.receipt(request.operationId);
  const duplicate = simulator.execute({ ...request, loseResponse: false });
  const after = simulator.snapshot(), events = simulator.events();
  const verification = verifyIsolatedHazardEffect({ before, after, events, receipt, operationId: request.operationId, target,
    contractId: request.contractId, contractRevision: request.contractRevision });
  return { command, commandIsFixtureDescriptionNotParsed: true, request, before, response, receipt, duplicate, after, events, verification };
});
const report = { schemaVersion: 'isolated-hazard-audit-v1', observedAt: new Date().toISOString(),
  evidenceLevel: 'isolated-simulation', coreMissionExecuted: false, physicalActionVerified: false,
  elapsedMs: performance.now() - started, actualCost: null, observations };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ scenarios: observations.length, verified: observations.filter(item => item.verification.status === 'verified-simulation').length,
  physicalActionVerified: false, elapsedMs: report.elapsedMs }));
if (observations.some(item => item.verification.status !== 'verified-simulation')) process.exitCode = 1;
