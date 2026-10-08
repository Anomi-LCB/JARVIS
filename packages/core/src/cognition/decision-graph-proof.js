import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const present = value => typeof value === 'string' && value.length > 0;
const ref = value => present(value) ? hash(value) : null;
export const actionNodes = task => (task?.plan?.planGraph?.nodes ?? []).filter(n => typeof n.nodeId === 'string' && n.nodeId.startsWith('action_'));
const action = value => [value?.actionType, value?.toolName, value?.skillId, value?.arguments];
const expectedAction = (task, node) => [node.actionType ?? task.plan.action?.actionType,
  node.toolName ?? task.plan.action?.toolName, node.skillId ?? task.plan.action?.skillId, node.arguments ?? task.plan.action?.arguments];
const graphShape = task => [task.plan?.planGraph?.graphId,
  actionNodes(task).map(n => [n.nodeId, n.order, expectedAction(task, n)]), task.plan?.planGraph?.edges];
const packetShape = packet => [packet?.packetId, packet?.parentPacketId, packet?.taskId, packet?.planId,
  packet?.planGraphNodeId, action(packet?.action), packet?.capabilityToken?.taskId,
  packet?.capabilityToken?.planId, packet?.capabilityToken?.approvalId, packet?.capabilityToken?.tokenId, packet?.dryRun];
const executionShape = execution => [execution?.status, execution?.executionResult, execution?.evidence, execution?.dryRun];
const reportShape = report => [report?.taskId, report?.verificationId, report?.status, report?.checks];
const optedOut = execution => execution?.memoryEvent?.learningFlags?.doNotRemember === true;
const preview = (execution, packet) => packet?.dryRun || execution?.dryRun || execution?.executionResult?.dryRun || execution?.evidence?.dryRun;
const validReport = report => present(report?.verificationId) && Array.isArray(report.checks) && report.checks.length > 0
  && report.checks.every(c => c && typeof c === 'object')
  && ((report.status === 'passed' && report.checks.every(c => c.status === 'passed'))
    || (report.status === 'failed' && report.checks.some(c => c.status === 'failed')));

// Unsampled, process-local provenance, captured at the worker's actual node G call.
// User-provided tracing IDs or reconstructed reports cannot populate this WeakMap.
export class DecisionGraphProof {
  constructor() { this.nodes = new WeakMap(); this.frames = new WeakMap(); }

  begin(task, packet, context) {
    if (!context || !packet || typeof packet !== 'object' || !present(packet.packetId)
      || packet.taskId !== task.taskId || packet.planId !== task.plan?.planId
      || packet.packetId !== task.executionPacket?.packetId || actionNodes(task).length < 2) return false;
    const frame = { task, contextHash: hash(context), graphHash: hash(graphShape(task)), baseHash: hash(packetShape(packet)) };
    const existing = this.frames.get(packet);
    if (existing) return existing.task === task && existing.contextHash === frame.contextHash
      && existing.graphHash === frame.graphHash && existing.baseHash === frame.baseHash;
    this.frames.set(packet, frame);
    return true;
  }

  captureNode(report, { task, node, execution, packet, basePacket }, context) {
    const actualNode = actionNodes(task).find(n => n.nodeId === node?.nodeId);
    const frame = this.frames.get(basePacket);
    if (!frame || frame.task !== task || frame.contextHash !== hash(context)
      || frame.graphHash !== hash(graphShape(task)) || frame.baseHash !== hash(packetShape(basePacket))
      || !context || !actualNode || actualNode !== node || !report || typeof report !== 'object'
      || !execution || typeof execution !== 'object' || !validReport(report) || report.taskId !== task.taskId
      || execution.status !== 'COMPLETED' || !present(execution.evidence?.evidenceId)
      || !present(packet?.packetId) || !present(basePacket?.packetId) || !present(task.plan?.planGraph?.graphId)
      || basePacket.packetId !== task.executionPacket?.packetId || basePacket.taskId !== task.taskId
      || basePacket.planId !== task.plan.planId || packet.taskId !== task.taskId || packet.planId !== task.plan.planId
      || packet.parentPacketId !== basePacket.packetId || packet.planGraphNodeId !== node.nodeId
      || packet.action?.planGraphNode?.nodeId !== node.nodeId || hash(action(packet.action)) !== hash(expectedAction(task, node))
      || packet.capabilityToken?.taskId !== task.taskId || packet.capabilityToken?.planId !== task.plan.planId
      || packet.capabilityToken?.approvalId !== task.approvalCard?.approvalId || !context.approvalRef) return false;
    this.nodes.set(report, { task, execution, report, packet, contextHash: hash(context),
      basePacket, baseHash: frame.baseHash, baseRef: ref(basePacket.packetId), graphHash: frame.graphHash, nodeId: node.nodeId,
      reportHash: hash(reportShape(report)), executionHash: hash(executionShape(execution)), packetHash: hash(packetShape(packet)),
      excluded: optedOut(execution), preview: Boolean(preview(execution, packet) || basePacket.dryRun) });
    return true;
  }

  captureAggregate(report, { task, execution, packet, verificationTargets }, context) {
    const expected = actionNodes(task).map(n => n.nodeId);
    if (!context || expected.length < 2 || new Set(expected).size !== expected.length
      || !Array.isArray(verificationTargets) || verificationTargets.length !== expected.length
      || !validReport(report) || report.taskId !== task.taskId || !Array.isArray(report.nodeVerifications)
      || report.nodeVerifications.length !== expected.length) return null;
    const seen = new Set(), packets = new Set(), reports = new Set(), bindings = [];
    for (const target of verificationTargets) {
      const binding = this.nodes.get(target.verification);
      const summary = report.nodeVerifications.filter(n => n.nodeId === target.nodeId);
      if (!expected.includes(target.nodeId) || seen.has(target.nodeId) || !binding
        || binding.nodeId !== target.nodeId || binding.task !== task || binding.execution !== target.execution
        || binding.contextHash !== hash(context) || binding.baseRef !== ref(packet?.packetId)
        || binding.graphHash !== hash(graphShape(task)) || binding.packetHash !== hash(packetShape(target.packet))
        || summary.length !== 1 || summary[0].verificationId !== target.verification.verificationId
        || summary[0].status !== target.verification.status || target.capability?.taskId !== task.taskId
        || target.capability?.planId !== task.plan.planId || target.capability?.approvalId !== task.approvalCard?.approvalId
        || packets.has(target.packet?.packetId) || reports.has(target.verification.verificationId)) return null;
      if (!this.nodeUnchanged(binding) || (report.status === 'passed' && target.verification.status !== 'passed')) return null;
      seen.add(target.nodeId); packets.add(target.packet.packetId); reports.add(target.verification.verificationId); bindings.push(binding);
    }
    const proof = { task, contextHash: hash(context), baseRef: ref(packet?.packetId),
      graphHash: hash(graphShape(task)), graphRef: ref(task.plan.planGraph.graphId), bindings,
      nodeProofs: bindings.map(b => ({ nodeRef: ref(b.nodeId), packetRef: ref(b.packet.packetId),
        verificationRef: ref(b.report.verificationId), evidenceRef: ref(b.execution.evidence.evidenceId), outcome: b.report.status })) };
    return this.matches(proof, { task, packet, context, execution }) ? proof : null;
  }

  nodeUnchanged(binding) {
    return !binding.excluded && !optedOut(binding.execution) && !binding.preview && !preview(binding.execution, binding.packet)
      && binding.baseHash === hash(packetShape(binding.basePacket))
      && binding.reportHash === hash(reportShape(binding.report))
      && binding.executionHash === hash(executionShape(binding.execution)) && binding.packetHash === hash(packetShape(binding.packet));
  }

  matches(proof, { task, packet, context }) {
    return proof.task === task && proof.contextHash === hash(context)
      && proof.baseRef === ref(packet?.packetId) && proof.baseRef === ref(task.executionPacket?.packetId)
      && packet?.taskId === task.taskId && packet?.planId === task.plan.planId
      && proof.graphHash === hash(graphShape(task)) && proof.bindings.every(b => this.nodeUnchanged(b));
  }
}
