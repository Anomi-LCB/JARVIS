import { createHash } from 'node:crypto';
import { PersonalMandateBudget } from './mandate-budget.js';
import { ucpCanonicalJson } from './ucp-checkout-read.js';
import {MissionCommerceSourceGate} from '../mission/mission-commerce-source-gate.js';

const hash = value => createHash('sha256').update(ucpCanonicalJson(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(`A_COMMERCE_${code}`), { code: `A_COMMERCE_${code}` }); };
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/u.test(value)) fail('ID_INVALID'); return value; };
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

/** Host-only adapter boundary. This does not enable a supplier or authorize payment.
 * The existing budget reservation is the sole durable dispatch state: any attempt
 * after in_flight is lookup-only, including process death before the network call.
 */
export class CommerceOrderCoordinator {
  constructor(store, { resolveOrder = () => null, authorize = () => false, adapter = null, verifyReceipt = () => null, missionSourceGate = null } = {}) {
    this.store = store;
    this.budget = new PersonalMandateBudget(store);
    this.resolveOrder = resolveOrder; this.authorize = authorize;
    this.adapter = adapter; this.verifyReceipt = verifyReceipt;
    if(missionSourceGate!==null&&(!(missionSourceGate instanceof MissionCommerceSourceGate)||missionSourceGate.operationsStore!==store))fail('MISSION_SOURCE_AUTHORITY_REQUIRED');
    this.missionSourceGate=missionSourceGate;
    store.db.exec(`CREATE TABLE IF NOT EXISTS personal_commerce_orders(
      reservation_id TEXT PRIMARY KEY REFERENCES personal_budget_reservations(id),
      provider_id TEXT NOT NULL, binding_hash TEXT NOT NULL, order_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, evidence_hash TEXT, verified_at TEXT);`);
    if(!store.db.prepare('PRAGMA table_info(personal_commerce_orders)').all().some(c=>c.name==='mission_source_json'))
      store.db.exec('ALTER TABLE personal_commerce_orders ADD COLUMN mission_source_json TEXT');
  }
  status() { return { configured: !!this.adapter, executionAuthority: false, liveSupplierVerified: false }; }
  async prepare(input) {
    if (!fields(input, ['mandateId', 'requestId', 'checkoutId','missionId'])) fail('REQUEST_INVALID');
    const { mandateId, requestId, checkoutId } = input;
    id(mandateId); id(requestId); id(checkoutId);
    if(input.missionId!==undefined){if(typeof input.missionId!=='string'||!/^mission_[\p{L}\p{N}_-]{1,200}$/u.test(input.missionId))fail('MISSION_ID_INVALID');if(!this.missionSourceGate)fail('MISSION_SOURCE_GATE_REQUIRED');}
    const order = await this.resolveOrder(checkoutId);
    if (!fields(order, ['active', 'revision', 'providerId', 'binding', 'checkoutId', 'request', 'expected', 'expiresAt', 'quoteEvidenceSha256'])
      || !fields(order.binding, ['endpoint', 'version']) || typeof order.binding.endpoint !== 'string' || !order.binding.endpoint
      || typeof order.binding.version !== 'string' || !order.binding.version
      || !fields(order.request, ['action', 'target', 'currency', 'amountMinor'])
      || !fields(order.expected, ['orderId', 'currency', 'totalMinor'])
      || order.active !== true || !order.revision || !order.providerId
      || order.checkoutId !== checkoutId || !order.request || !order.expected
      || order.request.action !== 'commerce.order' || order.request.target !== `provider:${order.providerId}`
      || order.request.currency !== order.expected.currency || order.request.amountMinor !== order.expected.totalMinor
      || !order.expected.orderId || !/^[a-f0-9]{64}$/u.test(order.quoteEvidenceSha256 ?? '')
      || !Number.isFinite(Date.parse(order.expiresAt)) || Date.parse(order.expiresAt) <= Date.parse(this.store.now())) fail('REVIEWED_ORDER_REQUIRED');
    const snapshot = structuredClone(order);
    const missionSource=input.missionId===undefined?null:this.missionSourceGate.capture(input.missionId,snapshot);
    const fingerprint = hash(missionSource?{order:snapshot,missionSource}:snapshot);
    const reservation = this.budget.reserve({ mandateId, requestId, request: snapshot.request, intentFingerprint: fingerprint });
    // A crash between reservation and binding creates only a held, unstarted
    // budget entry. Repeating prepare repairs it without dispatching anything.
    this.store.db.prepare(`INSERT OR IGNORE INTO personal_commerce_orders
      (reservation_id,provider_id,binding_hash,order_json,idempotency_key,mission_source_json) VALUES(?,?,?,?,?,?)`)
      .run(reservation.id, snapshot.providerId, hash(snapshot.binding), ucpCanonicalJson(snapshot), hash({ reservationId: reservation.id, provider: snapshot.providerId }),missionSource?ucpCanonicalJson(missionSource):null);
    const row = this.row(reservation.id);
    if (row.order_json !== ucpCanonicalJson(snapshot)) fail('ORDER_CONFLICT');
    if(row.mission_source_json!==(missionSource?ucpCanonicalJson(missionSource):null))fail('MISSION_SOURCE_BINDING_CHANGED');
    return this.get(reservation.id);
  }
  row(reservationId) {
    const row = this.store.db.prepare('SELECT * FROM personal_commerce_orders WHERE reservation_id=?').get(id(reservationId));
    if (!row) fail('ORDER_MISSING'); return row;
  }
  assertPersistedIntent(row){
    let order,source,request;
    try{order=JSON.parse(row.order_json);source=row.mission_source_json===null?null:JSON.parse(row.mission_source_json);
      request=JSON.parse(this.store.db.prepare('SELECT request_json FROM personal_budget_reservations WHERE id=?').get(row.reservation_id).request_json);}
    catch{fail('ORDER_BINDING_INVALID');}
    if(request.intentFingerprint!==hash(source?{order,missionSource:source}:order))fail('ORDER_BINDING_CHANGED');
  }
  get(reservationId) {
    const row = this.row(reservationId), reservation = this.budget.get(reservationId);
    return { reservationId, providerId: row.provider_id, state: reservation.state,
      receiptVerified: reservation.state === 'settled' && !!row.evidence_hash,
      evidenceSha256: row.evidence_hash, verifiedAt: row.verified_at,
      executionAuthority: false, fundsSettlementObserved: false,missionSourceBound:row.mission_source_json!==null };
  }
  assertAdapter(row) {
    if (!this.adapter || this.adapter.providerId !== row.provider_id || hash(this.adapter.binding) !== row.binding_hash
      || typeof this.adapter.complete !== 'function' || typeof this.adapter.lookup !== 'function') fail('ADAPTER_UNAVAILABLE_OR_CHANGED');
  }
  assertMissionSource(row,order){
    if(row.mission_source_json===null)return;
    if(!this.missionSourceGate)fail('MISSION_SOURCE_GATE_REQUIRED');
    let binding;try{binding=JSON.parse(row.mission_source_json);}catch{fail('MISSION_SOURCE_BINDING_INVALID');}
    this.missionSourceGate.assertCurrent(binding,order);
  }
  async dispatch(reservationId) {
    const row = this.row(reservationId), state = this.budget.get(reservationId).state;
    this.assertPersistedIntent(row);
    if (state !== 'reserved') fail('LOOKUP_REQUIRED_NO_REDISPATCH');
    this.assertAdapter(row);
    if(this.adapter.supportsBeforeCommit!==true)fail(row.mission_source_json!==null?'MISSION_SOURCE_COMMIT_FENCE_REQUIRED':'COMMIT_FENCE_REQUIRED');
    const order = JSON.parse(row.order_json);
    this.assertMissionSource(row,order);
    if (Date.parse(order.expiresAt) <= Date.parse(this.store.now())) fail('QUOTE_EXPIRED');
    if (hash(await this.resolveOrder(order.checkoutId)) !== hash(order)) fail('ORDER_CHANGED');
    if (Date.parse(order.expiresAt) <= Date.parse(this.store.now())) fail('QUOTE_EXPIRED');
    if (await this.authorize(structuredClone(order)) !== true) fail('POLICY_DENIED');
    // Recheck after asynchronous policy review; begin also checks current mandate.
    if (hash(await this.resolveOrder(order.checkoutId)) !== hash(order)) fail('ORDER_CHANGED');
    if (Date.parse(order.expiresAt) <= Date.parse(this.store.now())) fail('QUOTE_EXPIRED');
    this.assertAdapter(row);
    this.assertMissionSource(row,order);
    const adapter=this.adapter,complete=adapter.complete;
    this.budget.begin(reservationId); // SQL CAS: only one worker can pass.
    try {
      const receipt = await complete.call(adapter,{ order: structuredClone(order), idempotencyKey: row.idempotency_key,
        beforeCommit:async()=>{
          if(hash(await this.resolveOrder(order.checkoutId))!==hash(order))fail('ORDER_CHANGED');
          if(await this.authorize(structuredClone(order))!==true)fail('POLICY_DENIED');
          if(hash(await this.resolveOrder(order.checkoutId))!==hash(order))fail('ORDER_CHANGED');
          const current=this.row(reservationId),reservation=this.budget.get(reservationId);
          if(this.adapter!==adapter||adapter.complete!==complete||adapter.supportsBeforeCommit!==true)fail('ADAPTER_UNAVAILABLE_OR_CHANGED');
          this.assertPersistedIntent(current);this.assertAdapter(current);this.assertMissionSource(current,order);
          if(reservation.state!=='in_flight')fail('COMMIT_STATE_CHANGED');
          const {intentFingerprint,...request}=JSON.parse(reservation.request_json);
          if(!this.store.evaluateMandate(reservation.mandate_id,request).matches)fail('COMMIT_MANDATE_DENIED');
          if(Date.parse(order.expiresAt)<=Date.parse(this.store.now()))fail('QUOTE_EXPIRED');
          return true;
        } });
      return await this.accept(row, receipt);
    } catch {
      if (this.budget.get(reservationId).state === 'in_flight') this.budget.uncertain(reservationId);
      fail('OUTCOME_UNCERTAIN_LOOKUP_REQUIRED');
    }
  }
  async reconcile(reservationId) {
    const row = this.row(reservationId), state = this.budget.get(reservationId).state;
    this.assertPersistedIntent(row);
    if (!['in_flight', 'uncertain', 'settled'].includes(state)) fail('NOT_DISPATCHED');
    this.assertAdapter(row);
    // Revocation prevents a new order, not observation of an existing effect.
    const receipt = await this.adapter.lookup({ order: JSON.parse(row.order_json), idempotencyKey: row.idempotency_key });
    if (!receipt) return { ...this.get(reservationId), nextAction: 'provider-reconciliation-required' };
    return this.accept(row, receipt);
  }
  async accept(row, receipt) {
    const order = JSON.parse(row.order_json);
    const proof = await this.verifyReceipt(receipt, structuredClone(order));
    if (!proof || proof.verified !== true || proof.checkoutId !== order.checkoutId
      || proof.orderId !== order.expected.orderId || proof.currency !== order.expected.currency
      || proof.totalMinor !== order.expected.totalMinor || typeof proof.receiptRef !== 'string'
      || !/^[a-f0-9]{64}$/u.test(proof.evidenceSha256 ?? '')) fail('RECEIPT_INVALID');
    const current = this.row(row.reservation_id);
    if (current.evidence_hash && current.evidence_hash !== proof.evidenceSha256) fail('EVIDENCE_CONFLICT');
    // Settlement records accounting, not funds movement. If the process dies
    // between these two writes, lookup verifies again and repairs the metadata.
    this.budget.settle({ id: row.reservation_id, actualMinor: proof.totalMinor, receiptRef: proof.receiptRef });
    this.store.db.prepare('UPDATE personal_commerce_orders SET evidence_hash=?,verified_at=? WHERE reservation_id=? AND (evidence_hash IS NULL OR evidence_hash=?)')
      .run(proof.evidenceSha256, this.store.now(), row.reservation_id, proof.evidenceSha256);
    if (this.row(row.reservation_id).evidence_hash !== proof.evidenceSha256) fail('EVIDENCE_CONFLICT');
    return this.get(row.reservation_id);
  }
}
