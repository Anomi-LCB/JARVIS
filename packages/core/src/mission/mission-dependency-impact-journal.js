import {SqliteMissionStore} from './sqlite-mission-store.js';
import {MissionExecutionAuthority} from './mission-execution-authority.js';
import {missionDependencyImpact,dependencyImpactDigest} from './mission-dependency-impact.js';
import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
// Change detection deliberately ignores observation clocks. Stored history must
// instead cover every serialized byte; retain explicitly labelled legacy reads.
const recordDigest=body=>'json-bytes-v2:'+createHash('sha256').update(body).digest('hex');
const recordFormat=(body,digest)=>{
 if(typeof digest==='string'&&digest.startsWith('json-bytes-v2:')){
  if(recordDigest(body)!==digest)fail('A_MISSION_IMPACT_HISTORY_CORRUPTED');
  return 'json-bytes-v2';
 }
 if(!/^[a-f0-9]{64}$/u.test(digest??'')||dependencyImpactDigest(JSON.parse(body))!==digest)fail('A_MISSION_IMPACT_HISTORY_CORRUPTED');
 return 'legacy-semantic-v1';
};
const summary=row=>({status:row.status,reasons:row.reasons,unknownReasons:row.unknownReasons,
  deadline:row.deadline?{kind:row.deadline.kind,commitmentId:row.deadline.commitmentId,
    linkedRevision:row.deadline.linkedRevision,currentRevision:row.deadline.currentRevision,
    previousDueAt:row.deadline.previousDueAt,currentDueAt:row.deadline.currentDueAt,
    shiftMilliseconds:row.deadline.shiftMilliseconds,status:row.deadline.status,
    requiresReplan:row.deadline.requiresReplan,executionAuthority:false}:null,
  budget:{remaining:row.budget.remaining,money:row.budget.money,quota:{status:row.budget.quota.status,remainingCalls:row.budget.quota.remainingCalls??null,
    usedOrHeldCalls:row.budget.quota.usedOrHeldCalls??null,reservationState:row.budget.quota.reservationState??null}},
  affectedActionIds:row.affectedActionIds,unknownActionIds:row.unknownActionIds,
  actions:row.actions.map(a=>({actionId:a.actionId,status:a.status,directReasons:a.directReasons,unknownReasons:a.unknownReasons,affectedBy:a.affectedBy}))});
/** Explicit opt-in reconciliation, never execution/notification authorization. */
export function reconcileMissionDependencyImpacts(runtime){
 const store=runtime.store,authority=runtime.executionAuthority;
 if(!(store instanceof SqliteMissionStore)||!(authority instanceof MissionExecutionAuthority)||authority.store!==store)
   fail('A_MISSION_IMPACT_DURABLE_AUTHORITY_REQUIRED');
 authority.assertActive();
 return store._transaction(()=>{
  const now=store._now();store._assertFence(authority.lease,now);
  if(authority.lease?.resourceKey!=='mission-core-authority'||authority.recoveryOnly)fail('A_MISSION_IMPACT_DURABLE_AUTHORITY_REQUIRED');
  if(store._snapshot().revision!==store.revision)fail('A_MISSION_IMPACT_CORE_SNAPSHOT_STALE');
  const ids=[...runtime.missions.keys()].sort();if(ids.length>5000)fail('A_MISSION_IMPACT_SCAN_LIMIT');
  store.db.exec(`CREATE TABLE IF NOT EXISTS mission_dependency_impact_heads(mission_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,digest TEXT NOT NULL,summary TEXT NOT NULL,summary_digest TEXT NOT NULL,observed_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS mission_dependency_impact_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,mission_id TEXT NOT NULL,revision INTEGER NOT NULL,previous_digest TEXT NOT NULL,current_digest TEXT NOT NULL,body TEXT NOT NULL,body_digest TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(mission_id,revision));`);
  const events=[];let baselines=0,unchanged=0;
  for(const missionId of ids){
   const impact=missionDependencyImpact(runtime,missionId);if(impact.error)fail('A_MISSION_IMPACT_UNAVAILABLE');
   const digest=dependencyImpactDigest(impact),body=JSON.stringify(summary(impact));
   const head=store.db.prepare('SELECT * FROM mission_dependency_impact_heads WHERE mission_id=?').get(missionId);
   if(!head){store.db.prepare('INSERT INTO mission_dependency_impact_heads VALUES(?,?,?,?,?,?)').run(missionId,1,digest,body,recordDigest(body),now.iso);baselines++;continue;}
   const previousIntegrityFormat=recordFormat(head.summary,head.summary_digest);
   if(head.digest===digest){unchanged++;continue;}
   const revision=head.revision+1,event={missionId,revision,createdAt:now.iso,previousIntegrityFormat,previous:JSON.parse(head.summary),current:JSON.parse(body),previousDigest:head.digest,currentDigest:digest,executionAuthority:false};
   const eventBody=JSON.stringify(event);
   store.db.prepare('INSERT INTO mission_dependency_impact_events(mission_id,revision,previous_digest,current_digest,body,body_digest,created_at) VALUES(?,?,?,?,?,?,?)').run(missionId,revision,head.digest,digest,eventBody,recordDigest(eventBody),now.iso);
   const updated=store.db.prepare('UPDATE mission_dependency_impact_heads SET revision=?,digest=?,summary=?,summary_digest=?,observed_at=? WHERE mission_id=? AND revision=? AND digest=?').run(revision,digest,body,recordDigest(body),now.iso,missionId,head.revision,head.digest);
   if(updated.changes!==1)fail('A_MISSION_IMPACT_REVISION_CONFLICT');events.push(event);
  }
  return {observedAt:now.iso,baselines,unchanged,changed:events.length,events,executionAuthority:false,notificationsSent:0,effectsDispatched:0,scope:'explicit-current-dependencies'};
 });
}
export function listMissionDependencyImpactEvents(runtime,{after=0,limit=50}={}){
 if(!(runtime.store instanceof SqliteMissionStore))fail('A_MISSION_IMPACT_SQLITE_REQUIRED');
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('A_MISSION_IMPACT_PAGE_INVALID');
 const db=runtime.store.db;
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_dependency_impact_events'").get())return {items:[],nextAfter:after,executionAuthority:false};
 const rows=db.prepare('SELECT sequence,body,body_digest,created_at FROM mission_dependency_impact_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,limit);
 return {items:rows.map(row=>{const integrityFormat=recordFormat(row.body,row.body_digest),body=JSON.parse(row.body);if(integrityFormat==='json-bytes-v2'&&body.createdAt!==row.created_at)fail('A_MISSION_IMPACT_HISTORY_CORRUPTED');return {...body,sequence:row.sequence,createdAt:row.created_at,integrityFormat};}),nextAfter:rows.at(-1)?.sequence??after,executionAuthority:false};
}
