import { createAgRuntime } from '../../../runtime-compose/src/create-runtime.js';

const command = process.argv.slice(2).join(' ') || '엑셀 만들어';
const { coreFacade } = createAgRuntime();
const task = coreFacade.createTask(command);

console.log(JSON.stringify({
  module: 'B_PC_AGENT_CLI_MVP',
  taskId: task.taskId,
  status: task.status,
  approvalId: task.approvalCard.approvalId,
  riskTier: task.approvalCard.riskTier,
  planSteps: task.plan.planSteps
}, null, 2));
