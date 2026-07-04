import { CoreFacade } from '../core-facade.js';
import { createApprovalDecision, ApprovalDecision, ModuleId } from '../../../shared/src/types.js';

const args = process.argv.slice(2);
const approve = args.includes('--approve') || args.includes('-y');
const reject = args.includes('--reject') || args.includes('-n');
const command = args.filter((arg) => !arg.startsWith('--') && !['-y', '-n'].includes(arg)).join(' ') || '엑셀 만들어';

const core = new CoreFacade({ eventLogPath: 'logs/core-events.jsonl' });
const task = core.createCliTask(command);

const output = {
  module: 'A_CORE_CLI',
  taskId: task.taskId,
  status: task.status,
  interpretation: {
    title: task.plan.title,
    confidence: task.intent.confidence,
    ambiguous: task.ambiguity.ambiguous,
    alternatives: task.ambiguity.alternatives.map((candidate) => ({
      label: candidate.label,
      actionType: candidate.actionType,
      confidence: candidate.confidence
    }))
  },
  plan: {
    planId: task.plan.planId,
    skillId: task.plan.action.skillId,
    toolName: task.plan.action.toolName,
    steps: task.plan.planSteps
  },
  risk: task.policy.risk,
  approvalCard: task.approvalCard
};

if (approve || reject) {
  const decision = createApprovalDecision({
    approvalId: task.approvalCard.approvalId,
    taskId: task.taskId,
    decision: approve ? ApprovalDecision.APPROVE : ApprovalDecision.REJECT,
    deviceId: 'local_cli',
    sourceModule: ModuleId.CORE
  });
  output.approvalDecision = core.submitApprovalDecision(decision);
  if (approve) {
    output.capabilityRequest = core.createCapabilityRequest(task.taskId, decision);
    output.executionResult = core.completeDummyExecution(task.taskId, decision);
    output.status = task.status;
  }
}

console.log(JSON.stringify(output, null, 2));
