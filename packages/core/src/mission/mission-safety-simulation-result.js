import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { compileNaturalWorkflowObjective } from './natural-workflow-compiler.js';
import { readGuardedResultFile } from './mission-field-summary-result.js';
import { verifyIsolatedHazardEffect } from '../../../../apps/verification/src/isolated-hazard-verifier.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export function verifySafetySimulationResult({ objective, statement, observations, allowedRoots = [], beforeAccess }) {
  if (statement !== `${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.` || !allowedRoots[0]) return { applicable: false };
  const compiled = compileNaturalWorkflowObjective(objective, { workspaceRoot: allowedRoots[0] });
  const nodes = compiled.spec?.nodes;
  if (compiled.status !== 'compiled' || compiled.clauseCount !== 1 || nodes?.map(node => node.op).join(',') !== 'safety.simulation,write.json,data.readJson') return { applicable: false };
  try {
    const workflows = observations.filter(item => item.toolName === 'workflow.execute' && item.outcome === 'success'
      && item.verification?.status === 'passed' && item.data?.workflow?.specSha256 === hash(JSON.stringify(compiled.spec)));
    if (workflows.length !== 1) throw new Error('workflow-binding');
    const workflow = workflows[0].data.workflow;
    if (workflow.workflowId !== compiled.spec.workflowId || workflow.nodeCount !== 3 || workflow.receipts.length !== 3) throw new Error('workflow-binding');
    const receipts = nodes.map(node => {
      const matches = workflow.receipts.filter(item => item.nodeId === node.id && item.op === node.op && item.status === 'success');
      if (matches.length !== 1) throw new Error('receipt-binding'); return matches[0];
    });
    if (resolve(receipts[2].source.path) !== resolve(nodes[1].args.path)) throw new Error('path-binding');
    const bytes = readGuardedResultFile(resolve(allowedRoots[0]), nodes[1].args.path, beforeAccess);
    if (hash(bytes) !== receipts[2].source.sha256) throw new Error('current-content');
    const output = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (hash(canonical(output)) !== receipts[0].resultSha256 || output.schemaVersion !== 'isolated-hazard-workflow-v1'
      || output.evidenceLevel !== 'isolated-simulation' || output.physicalActionVerified !== false || output.observations.length !== 4) throw new Error('simulation-binding');
    const targets = ['sim:emergency', 'sim:vehicle', 'sim:door', 'sim:heater'];
    const checks = output.observations.map((item, index) => {
      if (item.target !== targets[index] || item.operationId !== `simulation-${index}`
        || item.contractId !== 'workflow-hazard-suite' || item.contractRevision !== 1
        || item.response?.uncertain !== true || item.response?.success !== false || item.response?.physicalEffect !== false
        || item.response.operationId !== item.operationId || item.duplicate?.duplicate !== true) throw new Error('scenario-binding');
      const { duplicate, ...original } = item.duplicate;
      if (canonical(original) !== canonical(item.receipt)) throw new Error('duplicate-receipt');
      const verified = verifyIsolatedHazardEffect(item);
      if (verified.status !== 'verified-simulation') throw new Error('state-oracle');
      return { checkId: `isolated-hazard-${index}`, passed: true, target: item.target, evidenceLevel: 'isolated-simulation', physicalActionVerified: false };
    });
    return { applicable: true, passed: true, status: 'passed', reasons: [], checks };
  } catch {
    return { applicable: true, passed: false, status: 'unverified', reasons: ['isolated-safety-simulation-unverified'], checks: [] };
  }
}
