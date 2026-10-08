import { createHash } from 'node:crypto';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function executionPacketFingerprint(packet = {}, { dryRun = false } = {}) {
  const action = packet?.action ?? {};
  const canonicalPayload = {
    taskId: packet?.taskId ?? null,
    requestedMode: dryRun || packet?.requestedMode === 'shadow' ? 'shadow' : (packet?.requestedMode ?? 'execute'),
    action: {
      actionType: action.actionType ?? null,
      toolName: action.toolName ?? null,
      skillId: action.skillId ?? null,
      arguments: action.arguments ?? {}
    }
  };
  return createHash('sha256').update(canonicalJson(canonicalPayload)).digest('hex');
}

