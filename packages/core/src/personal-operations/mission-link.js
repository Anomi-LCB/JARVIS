import { randomUUID,createHash } from 'node:crypto';

/** Receives only the server-owned runtime, never client-provided completion evidence. */
export class PersonalOperationsMissionLink {
  constructor({ store, missionRuntime }) {
    this.store = store;
    this.runtime = missionRuntime;
    missionRuntime.personalDependencyGuard=this;
    store.db.exec(`CREATE TABLE IF NOT EXISTS personal_ops_identity(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_mission_links(followup_id TEXT PRIMARY KEY REFERENCES personal_followups(id), request_json TEXT NOT NULL, mission_id TEXT UNIQUE, last_status TEXT, updated_at TEXT NOT NULL);`);
    if(!store.db.prepare('PRAGMA table_info(personal_mission_links)').all().some(c=>c.name==='commitment_revision'))store.db.exec('ALTER TABLE personal_mission_links ADD COLUMN commitment_revision INTEGER');
    if(!store.db.prepare('PRAGMA table_info(personal_mission_links)').all().some(c=>c.name==='source_hash'))store.db.exec('ALTER TABLE personal_mission_links ADD COLUMN source_hash TEXT');
    store.db.exec('CREATE TABLE IF NOT EXISTS personal_mission_link_history(id INTEGER PRIMARY KEY,followup_id TEXT NOT NULL,commitment_revision INTEGER,record TEXT NOT NULL,archived_at TEXT NOT NULL)');
    store.db.prepare('INSERT OR IGNORE INTO personal_ops_identity VALUES(1,?)').run(randomUUID());
    this.identity = store.db.prepare('SELECT value FROM personal_ops_identity WHERE id=1').get().value;
  }
  describeFollowup(id){
    const row=this.row(id),link=this.link(id);if(!link)return null;
    const mission=link.mission_id?this.runtime.getMission(link.mission_id):null;
    const source=this.sourceDependency(row,link);
    return {followUpId:id,missionId:link.mission_id,status:mission?.status??'UNAVAILABLE',requestFingerprint:createHash('sha256').update(link.request_json).digest('hex'),request:JSON.parse(link.request_json),expectedRevision:row.commitment_revision,dependencyCurrent:link.commitment_revision===row.commitment_revision&&source.current,
      sourceDependency:source,
      dependencyImpact:this.deadlineImpact(row,link,mission),cancelAllowed:!!mission&&['CREATED','RUNNING','PAUSED','WAITING_APPROVAL','BLOCKED','FAILED'].includes(mission.status),replanAllowed:(!source.required||(!!source.currentSourceHash&&source.status!=='withdrawn'))&&row.state==='pending'&&row.commitment_state==='open'&&!!mission&&['COMPLETED','CANCELLED'].includes(mission.status),executionAuthority:false};
  }
  sourceDependency(row,link=null){
    return this.store.commitmentSourceDependency(row.commitment_id,link?link.source_hash:undefined);
  }
  deadlineImpact(row,link,mission){
    const changed=link.commitment_revision!==row.commitment_revision;
    const receipt=changed?this.store.db.prepare("SELECT receipt FROM personal_deadline_changes WHERE commitment_id=? AND json_extract(receipt,'$.revision')=?").get(row.commitment_id,link.commitment_revision+1):null;
    const previousDueAt=changed?(receipt?JSON.parse(receipt.receipt).previousDueAt:null):row.due_at;
    const delta=previousDueAt===null?null:Date.parse(row.due_at)-Date.parse(previousDueAt);
    const current=!changed&&row.commitment_state==='open'&&row.state==='pending';
    return {kind:'linked-commitment-deadline',observedAt:this.store.now(),
      commitmentId:row.commitment_id,missionId:link.mission_id,linkedRevision:link.commitment_revision,currentRevision:row.commitment_revision,
      previousDueAt,currentDueAt:row.due_at,shiftMilliseconds:Number.isFinite(delta)?delta:null,
      status:current?'current':'requires-review',requiresReplan:!current&&row.commitment_state==='open'&&row.state==='pending',
      completedActionCount:mission?.metrics?.successfulActions??null,
      nextAction:current?null:row.commitment_state==='open'&&row.state==='pending'
        ?'이미 실행된 결과를 확인하고 현재 기한에 맞게 작업을 다시 계획하세요.'
        :'약속이나 후속 작업이 종료되어 기존 계획을 계속 실행할 수 없습니다.',
      executionAuthority:false,scope:'explicit-linked-work-only'};
  }
  assertCurrentMission(mission){
    const link=this.store.db.prepare('SELECT * FROM personal_mission_links WHERE mission_id=?').get(mission.missionId);
    if(!link){
      if(this.store.db.prepare("SELECT 1 FROM personal_mission_link_history WHERE json_extract(record,'$.mission_id')=? LIMIT 1").get(mission.missionId))throw Object.assign(new Error('A_PERSONAL_LINK_DEPENDENCY_CHANGED'),{code:'A_PERSONAL_LINK_DEPENDENCY_CHANGED'});
      return;
    }
    const row=this.row(link.followup_id);
    if(link.commitment_revision!==row.commitment_revision||row.commitment_state!=='open'||row.state!=='pending'||!this.sourceDependency(row,link).current){
      const error=new Error('A_PERSONAL_LINK_DEPENDENCY_CHANGED');error.code='A_PERSONAL_LINK_DEPENDENCY_CHANGED';throw error;
    }
  }
  row(id) {
    if (typeof id !== 'string' || id.length > 150) throw new Error('A_PERSONAL_LINK_INVALID_ID');
    const row=this.store.db.prepare(`SELECT f.*, c.due_at,c.state AS commitment_state,c.revision AS commitment_revision FROM personal_followups f JOIN personal_commitments c ON c.id=f.commitment_id WHERE f.id=?`).get(id);
    if (!row) throw new Error('A_PERSONAL_LINK_NOT_FOUND');
    return row;
  }
  link(id) { return this.store.db.prepare('SELECT * FROM personal_mission_links WHERE followup_id=?').get(id); }
  normalizeRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k=>!['objective','successCriteria','constraints','budgets'].includes(k))) throw new Error('A_PERSONAL_LINK_REQUEST_INVALID');
    if (typeof request.objective !== 'string' || !request.objective.trim() || request.objective.length>4000) throw new Error('A_PERSONAL_LINK_OBJECTIVE_REQUIRED');
    if (!Array.isArray(request.successCriteria) || !request.successCriteria.length || request.successCriteria.some(x=>typeof x!=='string'||!x.trim())) throw new Error('A_PERSONAL_LINK_CRITERIA_REQUIRED');
    if (request.constraints !== undefined && (!Array.isArray(request.constraints) || request.constraints.some(x=>typeof x!=='string'))) throw new Error('A_PERSONAL_LINK_CONSTRAINTS_INVALID');
    if (request.budgets !== undefined && (!request.budgets || typeof request.budgets!=='object' || Array.isArray(request.budgets))) throw new Error('A_PERSONAL_LINK_BUDGETS_INVALID');
    return { objective:request.objective, successCriteria:request.successCriteria, constraints:request.constraints??[], budgets:request.budgets??{}, authorization:{mode:'supervised',grants:['read_only']} };
  }
  replan(id, input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['expectedRevision','expectedSourceHash','request'].includes(k))||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1
      ||(input.expectedSourceHash!==undefined&&!/^[a-f0-9]{64}$/u.test(input.expectedSourceHash)))throw new Error('A_PERSONAL_LINK_REPLAN_INVALID');
    const normalized=this.normalizeRequest(input.request),json=JSON.stringify(normalized),db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try{
      const followup=this.row(id),old=this.link(id);
      if(followup.state!=='pending'||followup.commitment_state!=='open')throw new Error('A_PERSONAL_LINK_NOT_OPEN');
      if(followup.commitment_revision!==input.expectedRevision)throw new Error('A_PERSONAL_LINK_REVISION_CONFLICT');
      if(!old)throw new Error('A_PERSONAL_LINK_NOT_DISPATCHED');
      const source=this.sourceDependency(followup,old);
      if(source.required){
        if(!source.currentSourceHash||source.status==='withdrawn')throw new Error('A_PERSONAL_SOURCE_NOT_AVAILABLE');
        if((!source.current||input.expectedSourceHash!==undefined)&&input.expectedSourceHash!==source.currentSourceHash)throw new Error('A_PERSONAL_SOURCE_REVISION_CONFLICT');
      }else if(input.expectedSourceHash!==undefined)throw new Error('A_PERSONAL_LINK_REPLAN_INVALID');
      if(old.commitment_revision===followup.commitment_revision&&source.current){if(old.request_json!==json)throw new Error('A_PERSONAL_LINK_REQUEST_CONFLICT');}
      else{
        const previous=old.mission_id?this.runtime.getMission(old.mission_id):null;
        if(!previous||!['COMPLETED','CANCELLED'].includes(previous.status))throw new Error('A_PERSONAL_LINK_PREVIOUS_NOT_TERMINAL');
        db.prepare('INSERT INTO personal_mission_link_history(followup_id,commitment_revision,record,archived_at) VALUES(?,?,?,?)').run(id,old.commitment_revision,JSON.stringify(old),this.store.now());
        db.prepare('UPDATE personal_mission_links SET request_json=?,mission_id=NULL,last_status=NULL,updated_at=?,commitment_revision=?,source_hash=? WHERE followup_id=?').run(json,this.store.now(),followup.commitment_revision,source.currentSourceHash??null,id);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return this.dispatch(id,input.request);
  }
  dispatch(id, request) {
    const followup=this.row(id);
    if (followup.state !== 'pending' || followup.commitment_state !== 'open') throw new Error('A_PERSONAL_LINK_NOT_OPEN');
    const input=this.normalizeRequest(request);
    const json=JSON.stringify(input),db=this.store.db;
    const source=this.sourceDependency(followup);
    db.prepare('INSERT OR IGNORE INTO personal_mission_links(followup_id,request_json,updated_at,commitment_revision,source_hash) VALUES(?,?,?,?,?)').run(id,json,this.store.now(),followup.commitment_revision,source.boundSourceHash??null);
    const record=this.link(id);
    if(record.commitment_revision!==followup.commitment_revision)throw new Error('A_PERSONAL_LINK_REPLAN_REQUIRED');
    if(record.request_json!==json)throw new Error('A_PERSONAL_LINK_REQUEST_CONFLICT');
    if(record.mission_id) {
      const prior=this.runtime.getMission(record.mission_id);
      if(!prior)throw new Error('A_PERSONAL_LINK_MISSION_MISSING');
      return prior;
    }
    // Reservation precedes creation; creation key is durably stored by Mission.
    const mission=this.runtime.createMission({...input,idempotencyKey:`personal:${this.identity}:${id}${followup.commitment_revision>1?`:revision:${followup.commitment_revision}`:''}${record.source_hash?`:source:${record.source_hash}`:''}`});
    if(!mission?.missionId)throw new Error(mission?.error?.code??'A_PERSONAL_LINK_CREATION_FAILED');
    db.prepare('UPDATE personal_mission_links SET mission_id=?,last_status=?,updated_at=? WHERE followup_id=?').run(mission.missionId,mission.status,this.store.now(),id);
    return mission;
  }
  refresh(id) {
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try {
      // Read dependencies under the same writer lock as the resolution. Another
      // connection cannot change the deadline between comparison and commit.
      const row=this.row(id),link=this.link(id);
      if(!link?.mission_id)throw new Error('A_PERSONAL_LINK_NOT_DISPATCHED');
      const mission=this.runtime.getMission(link.mission_id);
      if(!mission)throw new Error('A_PERSONAL_LINK_MISSION_MISSING');
      const completion=mission.completion;
      const dependencyCurrent=link.commitment_revision===row.commitment_revision&&row.commitment_state==='open'&&this.sourceDependency(row,link).current;
      const verified=dependencyCurrent && mission.status==='COMPLETED' && completion?.status==='verified'
        && completion.successfulActionCount>0 && completion.criteria?.length>0
        && completion.criteria.every(c=>c.status==='satisfied' && c.evidenceActionIds?.length>0)
        && !(mission.pendingGates?.length);
      db.prepare('UPDATE personal_mission_links SET last_status=?,updated_at=? WHERE followup_id=?').run(mission.status,this.store.now(),id);
      if(verified)db.prepare("UPDATE personal_followups SET state='done',resolution=? WHERE id=? AND state='pending' AND commitment_id IN (SELECT id FROM personal_commitments WHERE state='open' AND revision=?)").run(`G-verified mission ${mission.missionId}`,id,link.commitment_revision);
      db.exec('COMMIT');
      return {followUpId:id,mission,verified,dependencyCurrent,requiresReplan:!dependencyCurrent&&row.commitment_state==='open',commitmentAutomaticallyCompleted:false};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  async run(id) {
    const row=this.row(id);if(row.state!=='pending'||row.commitment_state!=='open')throw new Error('A_PERSONAL_LINK_NOT_OPEN');
    const link=this.link(id);if(!link?.mission_id)throw new Error('A_PERSONAL_LINK_NOT_DISPATCHED');
    if(link.commitment_revision!==row.commitment_revision)throw new Error('A_PERSONAL_LINK_REPLAN_REQUIRED');
    const result=await this.runtime.runMission(link.mission_id);
    if(result?.error) return result;
    return this.refresh(id);
  }
  cancel(id,expected={}) {
    if(!expected||typeof expected!=='object'||Array.isArray(expected)||Object.keys(expected).some(k=>!['expectedMissionId','expectedRevision'].includes(k)))throw new Error('A_PERSONAL_LINK_CANCEL_INVALID');
    const checked=Object.keys(expected).length>0;
    if(checked&&(typeof expected.expectedMissionId!=='string'||!Number.isSafeInteger(expected.expectedRevision)||expected.expectedRevision<1))throw new Error('A_PERSONAL_LINK_CANCEL_INVALID');
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');let targetMissionId;
    try{
      const row=this.row(id),link=this.link(id);if(!link?.mission_id)throw new Error('A_PERSONAL_LINK_NOT_DISPATCHED');
      if(checked&&(expected.expectedMissionId!==link.mission_id||expected.expectedRevision!==row.commitment_revision))throw new Error('A_PERSONAL_LINK_CANCEL_CONFLICT');
      targetMissionId=link.mission_id;db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    const result=this.runtime.cancelMission(targetMissionId);
    if(result?.error)return result;return this.refresh(id);
  }
}
