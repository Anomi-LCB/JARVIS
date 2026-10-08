const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const version = 'a-mission-capability-availability-v1';

function normalizeBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('binding-invalid');
  const output = {};
  for (const key of ['capabilityId', 'providerId', 'accountRef', 'deviceRef']) {
    const value = input[key] ?? null;
    if (value === null && ['accountRef', 'deviceRef'].includes(key)) output[key] = null;
    else if (typeof value === 'string' && referencePattern.test(value)) output[key] = value;
    else throw new Error('binding-invalid');
  }
  if (!Array.isArray(input.scopes ?? []) || (input.scopes ?? []).length > 200
    || (input.scopes ?? []).some(scope => typeof scope !== 'string' || !scope || scope.length > 200
      || /[\s\u0000-\u001f?#]/u.test(scope))) throw new Error('binding-invalid');
  output.scopes = [...new Set(input.scopes ?? [])].sort();
  return output;
}

// A planner may claim a binding, but cannot provide availability or execution authority.
export function capturePlannedCapabilityBinding(value) {
  if (value === undefined || value === null) return null;
  try { return normalizeBinding(value); } catch { return { invalid: true }; }
}

export function requiresCapabilityAvailability(toolName, contract = {}) {
  return contract.requiresAvailabilityBinding === true || Boolean(contract.availabilityBinding)
    || typeof contract.resolveAvailability === 'function';
}

const sameBinding = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function boundedRead(callback) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('availability-read-timeout')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Checks prerequisites only; E policy, owner mandate and action approvals remain authoritative. */
export class MissionCapabilityAvailabilityGuard {
  constructor({ registry = null, resolver = null, probe = null, clock = () => new Date() } = {}) {
    this.registry = registry;
    this.resolver = resolver;
    this.probe = probe;
    this.clock = clock;
  }

  async assess({ mission, action, task = null, toolName, contract = {}, phase }) {
    const checkedAt = this.clock().toISOString();
    const snapshot = action.availabilityBindingSnapshot;
    const base = { guardVersion: version, phase, checkedAt, required: true, available: false,
      executionAuthorized: false, requiresPolicyCheck: true };
    const blocked = (code, nextAction = '연결할 계정·기기·필수 권한을 확인한 후 같은 작업을 다시 시작하세요.') => ({
      ...base, status: 'blocked', reasons: [{ code, nextAction }], nextAction
    });
    let resolved;
    try {
      resolved = this.resolver
        ? await boundedRead(() => this.resolver({ mission, action, task, toolName, phase }))
        : contract.availabilityBinding ? { required: true, binding: contract.availabilityBinding } : null;
      // Only installed local adapter code may provide this hook. An explicit
      // resolver result (including a denial) is authoritative and never bypassed.
      if (resolved == null && typeof contract.resolveAvailability === 'function') {
        resolved = await boundedRead(() => contract.resolveAvailability({ phase, registry: this.registry }));
      }
    } catch { return blocked('binding-resolution-failed'); }
    const required = requiresCapabilityAvailability(toolName, contract) || resolved?.required === true
      || Boolean(resolved?.binding) || Boolean(snapshot) || Boolean(action.plannedCapabilityBinding);
    if (!required) return { ...base, required: false, available: true, status: 'not-required', reasons: [], nextAction: null };
    if (!resolved?.binding) return blocked(snapshot ? 'binding-removed' : 'binding-required');
    let binding;
    try { binding = normalizeBinding(resolved.binding); }
    catch { return blocked('binding-invalid'); }
    if (action.plannedCapabilityBinding && !sameBinding(action.plannedCapabilityBinding, binding)) {
      return blocked('planner-binding-mismatch');
    }
    if (snapshot && !sameBinding(snapshot.binding, binding)) return blocked('binding-changed');
    if (snapshot && !Object.hasOwn(snapshot, 'resolvedPermissionRevision')) {
      return blocked('binding-snapshot-refresh-required', '이전 버전의 연결 확인 기록입니다. 현재 계정·권한으로 작업 계획을 다시 확인하세요.');
    }
    if (resolved.permissionRevision != null && (typeof resolved.permissionRevision !== 'string'
      || !referencePattern.test(resolved.permissionRevision))) return blocked('permission-revision-invalid');
    // The resolver's explicit revision is a separate prerequisite from a cached
    // registry observation. Losing it must not inherit the old observation.
    if (snapshot?.resolvedPermissionRevision && !resolved.permissionRevision) {
      return blocked('permission-revision-removed');
    }
    if(snapshot && snapshot.resolvedPermissionRevision !== (resolved.permissionRevision ?? null)) {
      return blocked('permission-revision-changed');
    }
    if (snapshot?.permissionRevision && resolved.permissionRevision
      && snapshot.permissionRevision !== resolved.permissionRevision) return blocked('permission-revision-changed');
    if (!snapshot) action.availabilityBindingSnapshot = { binding,
      permissionRevision: resolved.permissionRevision ?? null,
      resolvedPermissionRevision: resolved.permissionRevision ?? null, codeVersion: null, plannedAt: checkedAt };
    if (typeof this.registry?.availabilityFor !== 'function') return blocked('availability-registry-unavailable');
    const options = { minimumVerification: 'live-probe', permissionRevision: snapshot?.permissionRevision ?? resolved.permissionRevision ?? null };
    let availability;
    try { availability = this.registry.availabilityFor(binding, options); }
    catch { return blocked('availability-evaluation-failed'); }
    if (this.probe && (phase === 'dispatch' || availability.available !== true)) {
      try {
        const observation = await boundedRead(() => this.probe({ binding: structuredClone(binding), toolName, phase }));
        if (!observation || !sameBinding(normalizeBinding(observation), binding)) return blocked('probe-binding-mismatch');
        // Only the availability registry validates and records a probe. Its boolean alone is never trusted.
        this.registry.recordAvailability(observation);
        availability = this.registry.availabilityFor(binding, options);
      } catch { return blocked('availability-probe-failed', '연결 상태 읽기 검사를 다시 실행하세요. 실행 요청은 아직 전달하지 않았습니다.'); }
    }
    if (snapshot?.codeVersion && availability.codeVersion !== snapshot.codeVersion) return blocked('code-version-changed');
    if (availability.available && (!snapshot || !snapshot.codeVersion)) {
      action.availabilityBindingSnapshot = {
        binding, permissionRevision: availability.permissionRevision ?? resolved.permissionRevision ?? null,
        resolvedPermissionRevision: snapshot?.resolvedPermissionRevision ?? resolved.permissionRevision ?? null,
        codeVersion: availability.codeVersion, plannedAt: checkedAt
      };
    }
    return { ...availability, ...base, available: availability.available === true,
      status: availability.status, binding, reasons: availability.reasons, nextAction: availability.nextAction };
  }
}
