import { createHash, randomUUID } from 'node:crypto';
import { PersonalMandateBudget } from '../personal-operations/mandate-budget.js';
import {normalizeComparisonAcceptanceBounds} from './comparative-capability-evaluator.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ACTION = 'capability.evaluate', TARGET = 'jarvis:capability-evaluation';
const request = (amountMinor = 0) => ({ action: ACTION, target: TARGET, currency: 'KRW', amountMinor });

/** Host-owned accounting. Neither a reservation nor a cost claim grants execution authority. */
export class PersistentEvaluationBudget {
  #store; #budget; #mandateId; #suiteSha256; #maxTimeoutMs; #requirementHash; #monetary;
  #preparations=new WeakMap();
  static createMonetaryQuota({ store, validFrom, expiresAt, maxCalls, totalMinor, maxCostMinor }) {
    if (!Number.isSafeInteger(totalMinor) || totalMinor < 1 || !Number.isSafeInteger(maxCostMinor) || maxCostMinor < 1 || maxCostMinor > totalMinor
      || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100000) fail('A_EVALUATION_MONETARY_CONFIG_INVALID');
    const budget = new PersonalMandateBudget(store);
    return budget.transaction(() => {
      const mandate = store.createMandate({ validFrom, expiresAt, maxAmountMinor: maxCostMinor, action: ACTION, target: TARGET, currency: 'KRW' });
      store.db.prepare('INSERT INTO personal_budget_limits VALUES(?,?,?)').run(mandate.id, totalMinor, maxCalls);
      return mandate;
    });
  }
  static createCountQuota({ store, validFrom, expiresAt, maxCalls }) {
    const budget = new PersonalMandateBudget(store);
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100000) fail('A_BUDGET_CALL_LIMIT_INVALID');
    return budget.transaction(() => {
      const mandate = store.createMandate({ validFrom, expiresAt, maxAmountMinor: 0,
        action: ACTION, target: TARGET, currency: 'KRW' });
      store.db.prepare('INSERT INTO personal_budget_limits VALUES(?,?,?)').run(mandate.id, 0, maxCalls);
      return mandate;
    });
  }
  constructor({ store, mandateId, suiteSha256, maxTimeoutMs = 15000, requirementContractSha256 = null, monetaryPolicy = null }) {
    if (!store?.db || typeof mandateId !== 'string' || !hex(suiteSha256)
      || (requirementContractSha256 !== null && !hex(requirementContractSha256))
      || !Number.isInteger(maxTimeoutMs) || maxTimeoutMs < 100 || maxTimeoutMs > 120000) fail('A_EVALUATION_PERSISTENT_CONFIG_INVALID');
    this.#store = store; this.#budget = new PersonalMandateBudget(store); this.#mandateId = mandateId;
    this.#suiteSha256 = suiteSha256; this.#maxTimeoutMs = maxTimeoutMs;
    this.#requirementHash = requirementContractSha256;
    if (monetaryPolicy !== null && (!Number.isSafeInteger(monetaryPolicy.maxCostMinor) || monetaryPolicy.maxCostMinor < 1
      || typeof monetaryPolicy.costPolicyId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(monetaryPolicy.costPolicyId))) fail('A_EVALUATION_MONETARY_CONFIG_INVALID');
    this.#monetary = monetaryPolicy === null ? null : Object.freeze({ maxCostMinor: monetaryPolicy.maxCostMinor, costPolicyId: monetaryPolicy.costPolicyId });
    this.#assertCountQuota();
    store.db.exec(`CREATE TABLE IF NOT EXISTS capability_evaluation_policies(mandate_id TEXT PRIMARY KEY REFERENCES personal_budget_limits(mandate_id),suite_sha256 TEXT NOT NULL,max_timeout_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_evaluation_receipts(reservation_id TEXT PRIMARY KEY REFERENCES personal_budget_reservations(id),result_json TEXT NOT NULL,result_sha256 TEXT NOT NULL,recorded_at TEXT NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS capability_evaluation_preparations(reservation_id TEXT PRIMARY KEY REFERENCES personal_budget_reservations(id),preparation_id TEXT NOT NULL,initial_fingerprint TEXT NOT NULL,bound_stage_id TEXT,bound_fingerprint TEXT,created_at TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS capability_comparison_receipts(mandate_id TEXT NOT NULL,stage_id TEXT NOT NULL,identity_sha256 TEXT NOT NULL,result_json TEXT NOT NULL,result_sha256 TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(mandate_id,stage_id))');
    this.#budget.transaction(() => {
      if (!store.db.prepare('PRAGMA table_info(capability_evaluation_policies)').all().some(c=>c.name==='requirement_hash'))
        store.db.exec('ALTER TABLE capability_evaluation_policies ADD COLUMN requirement_hash TEXT');
      if (!store.db.prepare('PRAGMA table_info(capability_evaluation_policies)').all().some(c=>c.name==='cost_policy_json'))
        store.db.exec('ALTER TABLE capability_evaluation_policies ADD COLUMN cost_policy_json TEXT');
      const prior = store.db.prepare('SELECT * FROM capability_evaluation_policies WHERE mandate_id=?').get(mandateId);
      const costPolicyJson = this.#monetary === null ? null : JSON.stringify(this.#monetary);
      if (prior && (prior.suite_sha256 !== suiteSha256 || prior.max_timeout_ms !== maxTimeoutMs || prior.requirement_hash !== requirementContractSha256 || prior.cost_policy_json !== costPolicyJson)) fail('A_EVALUATION_PERSISTENT_POLICY_IMMUTABLE');
      store.db.prepare('INSERT OR IGNORE INTO capability_evaluation_policies(mandate_id,suite_sha256,max_timeout_ms,requirement_hash,cost_policy_json) VALUES(?,?,?,?,?)').run(mandateId, suiteSha256, maxTimeoutMs, requirementContractSha256, costPolicyJson);
    });
  }
  #assertCountQuota() {
    const row = this.#store.db.prepare('SELECT body FROM personal_mandates WHERE id=?').get(this.#mandateId);
    const body = row ? JSON.parse(row.body) : null;
    if (!body || body.action !== ACTION || body.target !== TARGET || body.currency !== 'KRW'
      || body.maxAmountMinor !== (this.#monetary?.maxCostMinor ?? 0) || body.scope
      || (this.#monetary ? this.#budget.summary(this.#mandateId).totalMinor < this.#monetary.maxCostMinor : this.#budget.summary(this.#mandateId).totalMinor !== 0)) fail('A_EVALUATION_COUNT_QUOTA_REQUIRED');
  }
  status() {
    return Object.freeze({ ...this.#budget.summary(this.#mandateId), scope: 'persistent-mandate',
      eligibleNow:this.#store.evaluateMandate(this.#mandateId,request(this.#monetary?.maxCostMinor)).matches,
      suiteSha256: this.#suiteSha256, requirementContractSha256: this.#requirementHash, maxTimeoutMs: this.#maxTimeoutMs,
      monetaryPolicy: this.#monetary, costMeaning: this.#monetary ? 'host-observed-monetary-accounting' : 'evaluation-count-only', actualCost: null });
  }
  start(input, timeoutMs) {
    this.#assertCountQuota();
    if ((input.requirementContractSha256 ?? null) !== this.#requirementHash) fail('A_EVALUATION_REQUIREMENT_CONTRACT_CHANGED');
    if (timeoutMs > this.#maxTimeoutMs) fail('A_EVALUATION_PERSISTENT_TIMEOUT_EXCEEDED');
    if (!hex(input.packageDigest) || !hex(input.artifactSha256) || typeof input.toolName !== 'string' || !input.toolName
      || input.toolName.length > 200 || typeof input.manifest?.packageId !== 'string' || !input.manifest.packageId
      || typeof input.manifest?.version !== 'string') fail('A_EVALUATION_IDENTITY_INVALID');
    const operationId = input.stageId ?? randomUUID();
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(operationId)) fail('A_EVALUATION_OPERATION_ID_INVALID');
    const intentFingerprint = hash(JSON.stringify({ packageDigest: input.packageDigest, artifactSha256: input.artifactSha256,
      toolName: input.toolName, manifest: input.manifest, suiteSha256: this.#suiteSha256, requirementContractSha256: this.#requirementHash, timeoutMs }));
    let reservation;
    try {
      reservation = this.#budget.reserve({ mandateId: this.#mandateId, requestId: `evaluation:${operationId}`,
        request: request(this.#monetary?.maxCostMinor), intentFingerprint });
    } catch (error) {
      if (!error.code && /^A_[A-Z_]+$/.test(error.message)) error.code = error.message;
      throw error;
    }
    if (reservation.eligibleNow === false) fail('A_BUDGET_MANDATE_DENIED');
    if (reservation.state === 'settled') {
      const row = this.#store.db.prepare('SELECT * FROM capability_evaluation_receipts WHERE reservation_id=?').get(reservation.id);
      if (!row || hash(row.result_json) !== row.result_sha256 || reservation.receipt_ref !== `sha256:${row.result_sha256}`) fail('A_EVALUATION_RECEIPT_UNAVAILABLE');
      const cached = JSON.parse(row.result_json);
      if (cached.packageDigest !== input.packageDigest || cached.artifactSha256 !== input.artifactSha256) fail('A_EVALUATION_RECEIPT_CONFLICT');
      return { reservationId: reservation.id, cachedResult: { ...cached, evaluationReplay: { executedNow: false, meaning: 'historical-isolated-evaluation', recordedAt: row.recorded_at } } };
    }
    if (reservation.state !== 'reserved') fail('A_EVALUATION_RECONCILIATION_REQUIRED');
    this.#budget.begin(reservation.id);
    return { reservationId: reservation.id };
  }
  prepare(preparationId){
    this.#assertCountQuota();
    if(typeof preparationId!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(preparationId)||!this.#requirementHash)fail('A_EVALUATION_PREPARATION_INVALID');
    const initialFingerprint=hash(JSON.stringify({kind:'improvement-preparation',preparationId,suiteSha256:this.#suiteSha256,requirementContractSha256:this.#requirementHash}));
    let row;try{row=this.#budget.reserve({mandateId:this.#mandateId,requestId:`preparation:${preparationId}`,request:request(this.#monetary?.maxCostMinor),intentFingerprint:initialFingerprint});}
    catch(error){if(!error.code&&/^A_[A-Z_]+$/.test(error.message))error.code=error.message;throw error;}
    if(row.eligibleNow===false)fail('A_BUDGET_MANDATE_DENIED');
    if(row.state!=='reserved')fail('A_EVALUATION_RECONCILIATION_REQUIRED');
    this.#budget.begin(row.id);
    this.#store.db.prepare('INSERT INTO capability_evaluation_preparations VALUES(?,?,?,NULL,NULL,?)').run(row.id,preparationId,initialFingerprint,this.#store.now());
    const ticket=Object.freeze({reservationId:row.id,preparationId});this.#preparations.set(ticket,{bound:false,initialFingerprint});return ticket;
  }
  assertPreparation(ticket){
    if(!this.#preparations.has(ticket))fail('A_EVALUATION_PREPARATION_INVALID');
    const row=this.#budget.get(ticket.reservationId);
    if(row.mandate_id!==this.#mandateId||row.state!=='in_flight'||!this.#store.evaluateMandate(this.#mandateId,request(this.#monetary?.maxCostMinor)).matches)fail('A_BUDGET_MANDATE_DENIED');
  }
  startPrepared(ticket,input,timeoutMs){
    this.assertPreparation(ticket);const state=this.#preparations.get(ticket);
    if(state.bound)fail('A_EVALUATION_PREPARATION_USED');
    if(!hex(input.packageDigest)||!hex(input.artifactSha256)||typeof input.stageId!=='string'||!/^[a-zA-Z0-9_.-]{1,100}$/.test(input.stageId)
      ||(input.requirementContractSha256??null)!==this.#requirementHash||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>this.#maxTimeoutMs)fail('A_EVALUATION_IDENTITY_INVALID');
    const fingerprint=hash(JSON.stringify({packageDigest:input.packageDigest,artifactSha256:input.artifactSha256,toolName:input.toolName,
      manifest:input.manifest,suiteSha256:this.#suiteSha256,requirementContractSha256:this.#requirementHash,timeoutMs}));
    this.#budget.transaction(()=>{
      this.assertPreparation(ticket);
      const row=this.#budget.get(ticket.reservationId),metadata=this.#store.db.prepare('SELECT * FROM capability_evaluation_preparations WHERE reservation_id=?').get(ticket.reservationId);
      if(!metadata||metadata.bound_stage_id||metadata.initial_fingerprint!==state.initialFingerprint||row.request_id!==`preparation:${ticket.preparationId}`
        ||JSON.parse(row.request_json).intentFingerprint!==state.initialFingerprint)fail('A_EVALUATION_PREPARATION_INVALID');
      this.#store.db.prepare('UPDATE personal_budget_reservations SET request_id=?,request_json=?,updated_at=? WHERE id=?').run(`evaluation:${input.stageId}`,JSON.stringify({...request(this.#monetary?.maxCostMinor),intentFingerprint:fingerprint}),this.#store.now(),ticket.reservationId);
      this.#store.db.prepare('UPDATE capability_evaluation_preparations SET bound_stage_id=?,bound_fingerprint=? WHERE reservation_id=?').run(input.stageId,fingerprint,ticket.reservationId);
    });state.bound=true;
    return{reservationId:ticket.reservationId,preparationId:ticket.preparationId};
  }
  abandonPreparation(ticket){
    if(!this.#preparations.has(ticket))fail('A_EVALUATION_PREPARATION_INVALID');
    if(this.#budget.get(ticket.reservationId).state==='in_flight')this.#budget.uncertain(ticket.reservationId);
  }
  beforeDispatch(ticket, suiteSha256) {
    if (suiteSha256 !== this.#suiteSha256) fail('A_EVALUATION_ORACLE_CONTRACT_CHANGED');
    const reservation = this.#budget.get(ticket.reservationId);
    if (reservation.mandate_id !== this.#mandateId || reservation.state !== 'in_flight'
      || !this.#store.evaluateMandate(this.#mandateId, request(this.#monetary?.maxCostMinor)).matches) fail('A_BUDGET_MANDATE_DENIED');
  }
  readCompleted(input, timeoutMs) {
    // Historical evidence lookup only: no reserve/begin/dispatch and no mandate extension.
    if (typeof input.stageId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.stageId)
      || !hex(input.packageDigest) || !hex(input.artifactSha256)
      || (input.requirementContractSha256 ?? null) !== this.#requirementHash
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > this.#maxTimeoutMs) fail('A_EVALUATION_IDENTITY_INVALID');
    const reservation=this.#store.db.prepare('SELECT * FROM personal_budget_reservations WHERE mandate_id=? AND request_id=?').get(this.#mandateId,`evaluation:${input.stageId}`);
    if (!reservation || reservation.state !== 'settled') fail('A_EVALUATION_RECONCILIATION_REQUIRED');
    const fingerprint=hash(JSON.stringify({packageDigest:input.packageDigest,artifactSha256:input.artifactSha256,
      toolName:input.toolName,manifest:input.manifest,suiteSha256:this.#suiteSha256,requirementContractSha256:this.#requirementHash,timeoutMs}));
    if (JSON.parse(reservation.request_json).intentFingerprint !== fingerprint) fail('A_EVALUATION_RECEIPT_CONFLICT');
    const row=this.#store.db.prepare('SELECT * FROM capability_evaluation_receipts WHERE reservation_id=?').get(reservation.id);
    if (!row || hash(row.result_json)!==row.result_sha256 || reservation.receipt_ref!==`sha256:${row.result_sha256}`) fail('A_EVALUATION_RECEIPT_UNAVAILABLE');
    const result=JSON.parse(row.result_json);
    if (result.packageDigest!==input.packageDigest || result.artifactSha256!==input.artifactSha256
      || result.receipt?.suiteSha256!==this.#suiteSha256
      || (result.receipt?.requirementContractSha256??null)!==this.#requirementHash) fail('A_EVALUATION_RECEIPT_CONFLICT');
    return {...result,evaluationReplay:{executedNow:false,meaning:'historical-isolated-evaluation',recordedAt:row.recorded_at}};
  }
  #comparisonIdentity(input,timeoutMs,configuration){
    if(typeof input.stageId!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(input.stageId)||!hex(input.packageDigest)||!hex(input.artifactSha256)
      ||(input.requirementContractSha256??null)!==this.#requirementHash||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>this.#maxTimeoutMs
      ||!Number.isInteger(configuration?.repeats)||configuration.repeats<3||configuration.repeats>10
      ||!Number.isInteger(configuration.minimumAdditionalPasses)||configuration.minimumAdditionalPasses<1||configuration.minimumAdditionalPasses>100)
      fail('A_COMPARISON_RECEIPT_IDENTITY_INVALID');
    const acceptanceBounds=normalizeComparisonAcceptanceBounds(configuration.acceptanceBounds);
    return hash(JSON.stringify({stageId:input.stageId,toolName:input.toolName,packageDigest:input.packageDigest,artifactSha256:input.artifactSha256,
      manifest:{packageId:input.manifest?.packageId,version:input.manifest?.version},suiteSha256:this.#suiteSha256,
      requirementContractSha256:this.#requirementHash,timeoutMs,repeats:configuration.repeats,minimumAdditionalPasses:configuration.minimumAdditionalPasses,
      ...(Object.keys(acceptanceBounds).length?{acceptanceBounds}:{})}));
  }
  recordComparison(input,timeoutMs,configuration,result){
    const identity=this.#comparisonIdentity(input,timeoutMs,configuration),json=JSON.stringify(result),receipt=result?.receipt;
    if(!json||Buffer.byteLength(json)>4*1024*1024||!['passed','failed'].includes(result?.status)||result.actualIsolatedExecution!==true
      ||result.packageDigest!==input.packageDigest||result.artifactSha256!==input.artifactSha256||receipt?.suiteSha256!==this.#suiteSha256
      ||(receipt.requirementContractSha256??null)!==this.#requirementHash||receipt.status!==result.status
      ||receipt.comparison?.schemaVersion!=='a-capability-comparison-v1'||receipt.comparison.repeats!==configuration.repeats
      ||receipt.comparison.minimumAdditionalPasses!==configuration.minimumAdditionalPasses
      ||JSON.stringify(normalizeComparisonAcceptanceBounds(receipt.comparison.acceptanceBounds))!==JSON.stringify(normalizeComparisonAcceptanceBounds(configuration.acceptanceBounds))
      ||result.evidenceRef!==`sha256:${hash(JSON.stringify(receipt))}`)fail('A_COMPARISON_RECEIPT_INVALID');
    this.#budget.transaction(()=>{
      if(!this.#store.evaluateMandate(this.#mandateId,request(this.#monetary?.maxCostMinor)).matches)fail('A_BUDGET_MANDATE_DENIED');
      const previous=this.#store.db.prepare('SELECT identity_sha256,result_sha256 FROM capability_comparison_receipts WHERE mandate_id=? AND stage_id=?').get(this.#mandateId,input.stageId);
      if(previous&&(previous.identity_sha256!==identity||previous.result_sha256!==hash(json)))fail('A_COMPARISON_RECEIPT_CONFLICT');
      this.#store.db.prepare('INSERT OR IGNORE INTO capability_comparison_receipts VALUES(?,?,?,?,?,?)').run(this.#mandateId,input.stageId,identity,json,hash(json),this.#store.now());
    });
  }
  readComparison(input,timeoutMs,configuration){
    const identity=this.#comparisonIdentity(input,timeoutMs,configuration);
    const row=this.#store.db.prepare('SELECT * FROM capability_comparison_receipts WHERE mandate_id=? AND stage_id=?').get(this.#mandateId,input.stageId);
    if(!row||row.identity_sha256!==identity||hash(row.result_json)!==row.result_sha256)fail('A_COMPARISON_RECEIPT_UNAVAILABLE');
    return{result:JSON.parse(row.result_json),recordedAt:row.recorded_at};
  }
  finish(ticket, result, assertCurrent, costObservation = null) {
    let actualMinor = 0;
    if (this.#monetary) {
      if (!costObservation || costObservation.currency !== 'KRW' || !Number.isSafeInteger(costObservation.amountMinor) || costObservation.amountMinor < 0
        || typeof costObservation.evidenceRef !== 'string' || !costObservation.evidenceRef.trim() || costObservation.evidenceRef.length > 200) fail('A_EVALUATION_COST_UNMEASURED');
      if (costObservation.amountMinor > this.#monetary.maxCostMinor) fail('A_EVALUATION_COST_EXCEEDS_RESERVATION');
      if (result.receipt?.costPolicyId !== this.#monetary.costPolicyId || JSON.stringify(result.receipt?.costObservation) !== JSON.stringify(costObservation)) fail('A_EVALUATION_COST_RECEIPT_MISMATCH');
      actualMinor = costObservation.amountMinor;
    }
    const json = JSON.stringify(result);
    if (!json || Buffer.byteLength(json) > 1024 * 1024 || !['passed', 'failed'].includes(result?.status)
      || !hex(result.packageDigest) || !hex(result.artifactSha256) || result.receipt?.suiteSha256 !== this.#suiteSha256
      || (result.receipt?.requirementContractSha256 ?? null) !== this.#requirementHash) fail('A_EVALUATION_RESULT_INVALID');
    const fingerprint = hash(json);
    this.#budget.transaction(() => {
      assertCurrent?.();
      if (!this.#store.evaluateMandate(this.#mandateId, request(this.#monetary?.maxCostMinor)).matches) fail('A_BUDGET_MANDATE_DENIED');
      const reservation = this.#budget.get(ticket.reservationId);
      if (reservation.mandate_id !== this.#mandateId || reservation.state !== 'in_flight' || reservation.amount_minor !== (this.#monetary?.maxCostMinor ?? 0)) fail('A_EVALUATION_RESERVATION_INVALID');
      this.#store.db.prepare('INSERT INTO capability_evaluation_receipts VALUES(?,?,?,?)').run(ticket.reservationId, json, fingerprint, this.#store.now());
      this.#store.db.prepare("UPDATE personal_budget_reservations SET state='settled',actual_minor=?,receipt_ref=?,updated_at=? WHERE id=? AND state='in_flight'")
        .run(actualMinor, `sha256:${fingerprint}`, this.#store.now(), ticket.reservationId);
      assertCurrent?.();
    });
  }
  failed(ticket) {
    if (ticket && !ticket.cachedResult) this.#budget.uncertain(ticket.reservationId);
  }
}
