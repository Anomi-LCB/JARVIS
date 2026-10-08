import { IsolatedHazardSimulator } from './isolated-hazard-simulator.js';

// Fixed, development-only state transitions. No user-provided commands or connectors.
export function runIsolatedHazardSuite(args, now) {
  if (!args || Object.keys(args).length !== 1 || args.mode !== 'isolated-simulation') {
    throw Object.assign(new Error('Only isolated simulation is supported'), { code: 'WORKFLOW_SAFETY_SIMULATION_ONLY' });
  }
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error('simulation-clock-invalid');
  const cases = [['sim:emergency', 'simulate_call'], ['sim:vehicle', 'simulate_stop'],
    ['sim:door', 'simulate_unlock'], ['sim:heater', 'simulate_on']];
  const contractId = 'workflow-hazard-suite', contractRevision = 1;
  const observations = cases.map(([target, action], index) => {
    const simulator = new IsolatedHazardSimulator({ contract: { id: contractId, revision: contractRevision,
      mode: 'isolated-simulation', targets: [target], expiresAt: new Date(time + 60_000).toISOString() }, clock: () => time });
    const before = simulator.snapshot(), operationId = `simulation-${index}`;
    const request = { mode: 'isolated-simulation', contractId, contractRevision, operationId, target, action,
      expectedRevision: 0, loseResponse: true };
    const response = simulator.execute(request);
    const receipt = simulator.receipt(operationId);
    const duplicate = simulator.execute({ ...request, loseResponse: false });
    return { target, operationId, contractId, contractRevision, before, response, receipt, duplicate,
      after: simulator.snapshot(), events: simulator.events() };
  });
  return { schemaVersion: 'isolated-hazard-workflow-v1', evidenceLevel: 'isolated-simulation',
    physicalActionVerified: false, observations };
}
