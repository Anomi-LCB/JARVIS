import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeMemoryScope } from '../../../../apps/growth-memory/src/memory-provenance.js';

export const RECOVERED_MEMORY_SCOPE_TTL_MS = 30_000;
const canonical = value => JSON.stringify(sort(value));
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
function eventDigest(event) {
  const copy = structuredClone(event);
  copy.source ??= {};
  delete copy.source.memoryScope; // Worker attaches the separately bound scope.
  return digest(copy);
}
const rejected = reason => ({ valid: false, reason, scope: null });

// Each authority owns its WeakMap. Creating another authority cannot mint a proof
// recognized by the private instance inside mission-action-recovery.js.
export function createRecoveredMemoryScopeAuthority() {
  const grants = new WeakMap();
  return {
    bind(recovered, { request, requestSha256, workspaceRoot, clock = () => new Date() }) {
      const event = recovered?.execution?.memoryEvent;
      const scope = normalizeMemoryScope({ userId: request?.taskRequest?.userId, workspaceRoot,
        conversationId: request?.taskRequest?.metadata?.conversationId ?? null });
      if (!scope || !request?.taskId || digest(request) !== requestSha256 || recovered?.status !== 'recovered'
        || recovered.verification?.status !== 'passed' || !recovered.verification.verificationId
        || !event?.eventId || event.eventType !== 'execution.completed' || event.taskId !== request.taskId
        || recovered.execution?.taskId !== request.taskId || !recovered.execution?.evidence?.evidenceId
        || recovered.execution?.executionResult?.packetId !== recovered.packetId) return false;
      const issuedAt = clock().getTime();
      if (!Number.isFinite(issuedAt)) return false;
      grants.set(recovered, { scope, taskId: request.taskId, eventDigest: eventDigest(event),
        recoveredDigest: digest(recovered), issuedAt, expiresAt: issuedAt + RECOVERED_MEMORY_SCOPE_TTL_MS,
        expiresMonotonic: performance.now() + RECOVERED_MEMORY_SCOPE_TTL_MS, clock, consumed: false });
      return true;
    },
    proofFor(recovered) { return grants.has(recovered) ? recovered : null; },
    consume(proof, { taskId, event, workspaceRoot }) {
      const grant = proof && typeof proof === 'object' ? grants.get(proof) : null;
      if (!grant) return rejected('unrecognized-proof');
      if (grant.consumed) return rejected('proof-consumed');
      const now = grant.clock().getTime();
      if (!Number.isFinite(now) || now < grant.issuedAt || now >= grant.expiresAt || performance.now() >= grant.expiresMonotonic) {
        grant.consumed = true; return rejected('proof-expired');
      }
      const suppliedScope = normalizeMemoryScope(event?.source?.memoryScope);
      const targetScope = normalizeMemoryScope({ ...grant.scope, workspaceRoot });
      if (taskId !== grant.taskId || event?.taskId !== grant.taskId) return rejected('proof-task-mismatch');
      if (!suppliedScope || !targetScope || canonical(suppliedScope) !== canonical(grant.scope)
        || canonical(targetScope) !== canonical(grant.scope)) return rejected('proof-scope-mismatch');
      if (eventDigest(event) !== grant.eventDigest) return rejected('proof-event-mismatch');
      if (digest(proof) !== grant.recoveredDigest) return rejected('proof-result-mismatch');
      grant.consumed = true;
      return { valid: true, scope: structuredClone(grant.scope), reason: 'verified-durable-recovery' };
    }
  };
}
