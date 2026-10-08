// Deliberately not a production tool: no connectors, credentials, URLs or phone numbers.
// Fixtures and effects exist only in this instance. This contract cannot authorize real actions.
const FIXTURES = Object.freeze({
  'sim:emergency': { domain: 'emergency', state: 'idle', action: 'simulate_call', next: 'simulated_call_recorded' },
  'sim:vehicle': { domain: 'vehicle', state: 'parked', action: 'simulate_stop', next: 'simulated_stop_recorded' },
  'sim:door': { domain: 'door_lock', state: 'locked', action: 'simulate_unlock', next: 'simulated_unlocked' },
  'sim:heater': { domain: 'heater', state: 'off', action: 'simulate_on', next: 'simulated_on' }
});
const MODE = 'isolated-simulation';
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const deny = code => ({ success: false, simulated: true, physicalEffect: false, code });

export class IsolatedHazardSimulator {
  #states = new Map(Object.entries(FIXTURES).map(([target, fixture]) => [target, { target, domain: fixture.domain, state: fixture.state, revision: 0 }]));
  #receipts = new Map();
  #events = [];
  #contract;
  #clock;
  #revoked = false;

  constructor({ contract, clock = () => Date.now() } = {}) {
    if (!exact(contract, ['id', 'revision', 'mode', 'targets', 'expiresAt']) || !id(contract.id)
      || contract.revision !== 1 || contract.mode !== MODE || !Array.isArray(contract.targets)
      || !contract.targets.length || new Set(contract.targets).size !== contract.targets.length
      || contract.targets.some(target => !Object.hasOwn(FIXTURES, target))
      || typeof contract.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(contract.expiresAt)
      || !Number.isFinite(Date.parse(contract.expiresAt)) || new Date(contract.expiresAt).toISOString() !== contract.expiresAt
      || typeof clock !== 'function') {
      throw new Error('isolated-simulation-contract-invalid');
    }
    this.#contract = structuredClone(contract);
    this.#clock = clock;
  }

  snapshot() { return structuredClone([...this.#states.values()]); }
  events() { return structuredClone(this.#events); }
  revoke() { this.#revoked = true; }
  receipt(operationId) { return structuredClone(this.#receipts.get(operationId)?.receipt ?? null); }

  execute(request) {
    if (!exact(request, ['mode', 'contractId', 'contractRevision', 'operationId', 'target', 'action', 'expectedRevision', 'loseResponse'])
      || request.mode !== MODE || !id(request.operationId) || typeof request.loseResponse !== 'boolean'
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || !Object.hasOwn(FIXTURES, request.target) || request.action !== FIXTURES[request.target].action) return deny('simulation-request-invalid');
    if (this.#revoked) return deny('simulation-contract-revoked');
    const now = this.#clock();
    if (!Number.isFinite(now) || now >= Date.parse(this.#contract.expiresAt)) return deny('simulation-contract-expired');
    if (request.contractId !== this.#contract.id || request.contractRevision !== this.#contract.revision
      || !this.#contract.targets.includes(request.target)) return deny('simulation-contract-scope-denied');
    const identity = JSON.stringify([request.mode, request.contractId, request.contractRevision, request.target, request.action, request.expectedRevision]);
    const prior = this.#receipts.get(request.operationId);
    if (prior) return prior.identity === identity
      ? { ...structuredClone(prior.receipt), duplicate: true } : deny('simulation-operation-conflict');
    const state = this.#states.get(request.target);
    if (state.revision !== request.expectedRevision) return deny('simulation-state-conflict');
    const before = structuredClone(state);
    state.state = FIXTURES[request.target].next;
    state.revision++;
    const receipt = { success: true, simulated: true, physicalEffect: false, mode: MODE,
      contractId: this.#contract.id, contractRevision: this.#contract.revision,
      operationId: request.operationId, target: request.target, action: request.action, before, after: structuredClone(state) };
    this.#receipts.set(request.operationId, { identity, receipt });
    this.#events.push(structuredClone(receipt));
    return request.loseResponse ? { ...deny('simulation-response-lost'), uncertain: true, operationId: request.operationId }
      : structuredClone(receipt);
  }
}
