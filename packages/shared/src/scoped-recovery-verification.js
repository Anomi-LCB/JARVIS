const tools = ['filesystem.createTextFile', 'filesystem.readText', 'workflow.execute'];
export const supportsScopedRecoveryTool = tool => tools.includes(tool);

// These built-in routes re-hash all declared files in recovery, and G only
// consumes their proofs and stats outputs. Other format readers need their own fences.
export function supportsScopedVerificationTarget(result, evidence) {
  const tool = result?.executedBy?.toolName;
  return supportsScopedRecoveryTool(tool) && (!evidence?.toolName || evidence.toolName === tool)
    && !result.xlsxRead && !result.pdfRead && !result.pdfExport && !result.evidence?.workbook;
}
