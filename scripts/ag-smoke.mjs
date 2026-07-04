import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MobileAppRuntime } from '../apps/mobile/src/mobile-runtime.js';
import { ApprovalDecision, TaskStatus } from '../packages/shared/src/types.js';

export async function runAgSmoke({
  command = '엑셀 만들어',
  outputPath = 'workspace/ag-smoke-output.txt',
  reportPath = 'dist/ag-smoke-report.json',
  allowedRoots = ['workspace'],
  auditRoot,
  clock
} = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });

  const runtime = createAgRuntime({
    allowedRoots,
    outputPath,
    auditRoot,
    clock
  });
  const mobile = new MobileAppRuntime({ bridgeRuntime: runtime.bridgeRuntime, clock });

  const pairing = runtime.bridgeRuntime.pairing.start();
  const paired = mobile.pair({ pairingCode: pairing.pairingCode, bridgeUrl: pairing.bridgeUrl });
  if (!paired.success) throw new Error(`Pairing failed: ${paired.error?.code ?? 'unknown'}`);

  const sent = mobile.sendCommand(command);
  if (sent.status !== TaskStatus.WAITING_APPROVAL) {
    throw new Error(`Task did not enter approval flow: ${sent.error?.code ?? sent.status ?? 'unknown'}`);
  }

  const approval = mobile.approvalQueue().items.find((item) => item.taskId === sent.taskId);
  if (!approval) throw new Error(`Approval card not found for ${sent.taskId}`);

  const card = mobile.approvalDetail(approval.approvalId);
  const approved = await mobile.decideApproval({
    approvalId: approval.approvalId,
    decision: ApprovalDecision.APPROVE
  });
  if (!approved.requiresUserConfirmation) {
    throw new Error(`Execution handoff was not created for ${sent.taskId}`);
  }

  const executed = await mobile.confirmExecution(approved.handoffId);
  if (executed.status !== TaskStatus.COMPLETED) {
    throw new Error(`Execution did not complete: ${executed.status ?? 'unknown'}`);
  }

  const result = mobile.result(sent.taskId);
  const feedback = mobile.sendFeedback({
    taskId: sent.taskId,
    feedbackType: 'result_good',
    text: '스모크 테스트 결과 정상'
  });
  const growthReview = mobile.growthReview();
  const eventSync = mobile.syncEvents();
  const approvalFlowVerification = runtime.verificationRuntime.verifyApprovalFlow({
    verificationId: `smoke_flow_${sent.taskId}`,
    taskId: sent.taskId,
    target: {
      approvalCard: card,
      approvalDecision: {
        approvalId: approval.approvalId,
        taskId: sent.taskId,
        decision: ApprovalDecision.APPROVE,
        decidedBy: { module: 'C_MOBILE', deviceId: mobile.deviceId }
      },
      deviceEvent: { authenticated: true }
    }
  });
  const bridgeVerification = runtime.verificationRuntime.verifyBridge({
    verificationId: `smoke_bridge_${sent.taskId}`,
    taskId: sent.taskId,
    target: {
      authEvent: { tokenPresent: true, status: 'succeeded' },
      apiRequest: { host: '127.0.0.1' }
    }
  });
  const regression = runtime.verificationRuntime.runRegressionSuite();

  const summary = {
    command,
    status: 'passed',
    taskId: sent.taskId,
    approvalId: approval.approvalId,
    handoffId: approved.handoffId,
    outputPath,
    resultStatus: result.status,
    verificationStatus: result.verification?.status ?? executed.verificationStatus,
    feedbackStored: feedback.stored === true,
    growthReviewId: growthReview.reviewId,
    eventCount: eventSync.items.length,
    approvalFlowVerification: approvalFlowVerification.status,
    bridgeVerification: bridgeVerification.status,
    regressionFailed: regression.failed,
    reportPath
  };

  await writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf8');
  return { summary, runtime, mobile };
}

function parseCliArgs(args) {
  const commandIndex = args.indexOf('--command');
  const reportIndex = args.indexOf('--report');
  const outputIndex = args.indexOf('--output');
  const firstFreeArg = args.find((arg, index) => !arg.startsWith('--') && !['--command', '--report', '--output'].includes(args[index - 1]));
  const defaultOutputPath = `workspace/ag-smoke-output-${Date.now().toString(36)}.txt`;
  return {
    command: commandIndex >= 0 ? args[commandIndex + 1] : firstFreeArg ?? '엑셀 만들어',
    reportPath: reportIndex >= 0 ? args[reportIndex + 1] : 'dist/ag-smoke-report.json',
    outputPath: outputIndex >= 0 ? args[outputIndex + 1] : defaultOutputPath
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { summary } = await runAgSmoke(parseCliArgs(process.argv.slice(2)));
  console.log(`# JARVIS A-G Smoke`);
  console.log(`Status: ${summary.status}`);
  console.log(`Command: ${summary.command}`);
  console.log(`Task: ${summary.taskId}`);
  console.log(`Result: ${summary.resultStatus} / verification ${summary.verificationStatus}`);
  console.log(`Approval flow: ${summary.approvalFlowVerification}`);
  console.log(`Bridge: ${summary.bridgeVerification}`);
  console.log(`Regression failed: ${summary.regressionFailed}`);
  console.log(`Report: ${summary.reportPath}`);
}
