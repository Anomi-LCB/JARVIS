const roleIds = new Set(['researcher', 'editor', 'verifier']);
const sourceTools = new Set(['browser.search', 'news.fetchHeadlines', 'news.fetchPublisherFeed', 'news.fetchArticle',
  'filesystem.listFiles', 'filesystem.searchFiles', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook', 'capability.describe']);
const localReadTools = new Set(['filesystem.listFiles', 'filesystem.searchFiles', 'filesystem.readText', 'document.readPdf', 'excel.readWorkbook']);
const localArtifactWriteTools = new Set(['excel.createWorkbook','excel.exportPdf', 'word.create', 'powerpoint.create',
  'hwp.create', 'filesystem.createTextFile', 'visual.createCards', 'archive.createZip']);

/**
 * Validate the tool boundary for an explicitly role-assigned mission action.
 * This is an authorization guard, not proof of separate model processes or memory.
 */
export function validateMissionRoleTool({ roleId, toolName, contract = {} } = {}) {
  if (!roleIds.has(roleId)) return denied('unknown-role');
  if (typeof toolName !== 'string' || !toolName) return denied('tool-missing');
  if (contract.externalTransfer === true) return denied('external-transfer-out-of-role-scope');

  if (roleId === 'researcher') {
    if (!sourceTools.has(toolName)
      || contract.readOnly !== true || contract.mutatesSystem === true || contract.writesLocalFiles === true) {
      return denied('researcher-requires-allowlisted-read-tool');
    }
  } else if (roleId === 'editor') {
    if (!localArtifactWriteTools.has(toolName) || contract.writesLocalFiles !== true
      || contract.externalTransfer === true) {
      return denied('editor-requires-local-artifact-write');
    }
  } else if (roleId === 'verifier') {
    if (!localReadTools.has(toolName) || contract.readOnly !== true
      || contract.externalNetwork === true || contract.mutatesSystem === true || contract.writesLocalFiles === true) {
      return denied('verifier-requires-local-read-only-tool');
    }
  }
  return { allowed: true, roleId, toolName, policyVersion: 'mission-role-tool-scope-v1' };
}

export function normalizeMissionRoleAssignment(action = {}) {
  const roleId = action.workerRole ?? null;
  const collaborationGroupId = action.collaborationGroupId ?? null;
  if (roleId === null && collaborationGroupId === null) return { valid: true, assignment: null };
  if (typeof collaborationGroupId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(collaborationGroupId)
    || !roleIds.has(roleId)) return { valid: false, reason: 'role-assignment-invalid' };
  return { valid: true, assignment: { workerRole: roleId, collaborationGroupId } };
}

function denied(reason) {
  return { allowed: false, reason, policyVersion: 'mission-role-tool-scope-v1' };
}
