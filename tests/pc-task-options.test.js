import test from 'node:test';
import assert from 'node:assert/strict';
import {pcTaskOptions,pcTaskLabels} from '../packages/core/src/client/pc-task-options.js';

const records=count=>new Map(Array.from({length:count},(_,i)=>{const id=`task-${String(i).padStart(4,'0')}`;return [id,{taskId:id,status:'WAITING_APPROVAL',plan:{title:`문서 업무 ${i}`,action:{arguments:{secret:'must-not-return'}}},request:{command:'private raw input'},approvalCard:{capabilityToken:'private-token'}}];}));

test('bounded label lookup preserves request identities, includes unknowns and never returns other task data',()=>{
  const labels=pcTaskLabels(records(205),{taskIds:['task-0204','unknown','task-0000']});
  assert.deepEqual(labels.items,[{taskId:'task-0204',title:'문서 업무 204',found:true},{taskId:'unknown',title:null,found:false},{taskId:'task-0000',title:'문서 업무 0',found:true}]);
  assert.equal(labels.executionAuthority,false);assert.equal(labels.deviceAvailabilityVerified,false);assert.equal(labels.verifiedCompletion,false);
  assert.doesNotMatch(JSON.stringify(labels),/private|secret|arguments/u);
  for(const input of [{taskIds:[]},{taskIds:['task','task']},{taskIds:['bad/id']},{taskIds:['task'],extra:1},{taskIds:Array.from({length:1001},(_,i)=>`t${i}`)}])assert.throws(()=>pcTaskLabels(records(1),input),/INPUT_INVALID/u);
  const missions=new Map([['mission-one',missionRecord()]]);
  assert.equal(pcTaskLabels(new Map(),{taskIds:['saved-task']},missions).items[0].title,'저장된 자료 확인');
});

test('Core task options page projected planning records in stable order without execution claims or secrets',()=>{
  const source=records(205),first=pcTaskOptions(source);
  assert.equal(first.items.length,100);assert.equal(first.totalEntries,205);assert.equal(first.hasMore,true);
  assert.deepEqual(Object.keys(first.items[0]),['taskId','title','status']);
  assert.equal(first.executionAuthority,false);assert.equal(first.verifiedCompletion,false);assert.equal(first.deviceAvailabilityVerified,false);
  const all=[...first.items];let page=first;
  while(page.hasMore){page=pcTaskOptions(source,new URLSearchParams({offset:String(page.nextOffset),snapshot:first.snapshot}));all.push(...page.items);}
  assert.equal(all.length,205);assert.equal(new Set(all.map(t=>t.taskId)).size,205);
  assert.equal(page.hasMore,false);assert.doesNotMatch(JSON.stringify(first),/private|secret|arguments|capabilityToken/u);
  assert.equal(pcTaskOptions(new Map([...source].reverse())).snapshot,first.snapshot);
});

test('task changes invalidate later pages and malformed or unbounded queries are rejected',()=>{
  for(const change of ['add','remove','title','status']){
    const source=records(101),first=pcTaskOptions(source);
    if(change==='add')source.set('new',{taskId:'new',status:'CREATED'});
    if(change==='remove')source.delete('task-0000');
    if(change==='title')source.get('task-0000').plan.title='변경된 업무';
    if(change==='status')source.get('task-0000').status='FAILED';
    assert.throws(()=>pcTaskOptions(source,new URLSearchParams({offset:'100',snapshot:first.snapshot})),/TASK_OPTIONS_CHANGED/u);
  }
  for(const query of ['offset=100','offset=-1','offset=01','offset=1.5','limit=0','limit=101','limit=2&limit=3','taskIds=secret','snapshot=invalid','offset=100001'])assert.throws(()=>pcTaskOptions(records(2),new URLSearchParams(query)),/INPUT_INVALID/u,query);
});

test('invalid task identity fails closed and titles/status are bounded plain data',()=>{
  assert.throws(()=>pcTaskOptions(new Map([['task',{taskId:'other'}]])),/TASK_OPTIONS_INVALID/u);
  assert.throws(()=>pcTaskOptions(new Map([['../bad',{taskId:'../bad'}]])),/TASK_OPTIONS_INVALID/u);
  const source=new Map([['task',{taskId:'task',plan:{title:'a\u0000\u202E'+'x'.repeat(200)},status:'<unsafe>'}]]);
  const value=pcTaskOptions(source).items[0];assert.equal(value.title.length,120);assert.doesNotMatch(value.title,/[\p{Cc}\p{Cf}]/u);assert.equal(value.status,'UNKNOWN');
  assert.equal(pcTaskOptions(new Map()).items.length,0);
});


const missionRecord=(id='mission-one',taskId='saved-task',actionId='action-one')=>({missionId:id,waves:[{actions:[{actionId,taskId,title:'저장된 자료 확인',status:'succeeded',command:'private command',operation:{dispatch:{arguments:{secret:'private'}}}}]}]});

test('persisted Mission task identities merge without claiming current completion or reconstructing executable tasks',()=>{
  const missions=new Map([['mission-one',missionRecord()]]),current=new Map();
  const saved=pcTaskOptions(current,new URLSearchParams(),missions);
  assert.equal(saved.source,'core-runtime-and-mission-records');assert.equal(saved.items[0].taskId,'saved-task');
  assert.equal(saved.items[0].status,'HISTORICAL');assert.equal(saved.items[0].recordSource,'saved-mission');
  assert.equal(saved.items[0].missionId,'mission-one');assert.equal(saved.verifiedCompletion,false);assert.equal(current.size,0);
  assert.doesNotMatch(JSON.stringify(saved),/private|secret|command|arguments/u);
  current.set('saved-task',{taskId:'saved-task',status:'VERIFYING',plan:{title:'현재 작업'}});
  const merged=pcTaskOptions(current,new URLSearchParams(),missions);assert.equal(merged.items.length,1);
  assert.equal(merged.items[0].status,'VERIFYING');assert.equal(merged.items[0].recordSource,'current-core-mission');
  assert.equal(merged.items[0].title,'저장된 자료 확인');
  assert.notEqual(merged.snapshot,saved.snapshot);
});

test('ambiguous Mission task ownership is rejected and uncreated actions never get invented task IDs',()=>{
  const one=missionRecord(),two=missionRecord('mission-two');
  assert.throws(()=>pcTaskOptions(new Map(),new URLSearchParams(),new Map([['mission-one',one],['mission-two',two]])),/TASK_OPTIONS_AMBIGUOUS/u);
  one.waves[0].actions[0].taskId=null;assert.equal(pcTaskOptions(new Map(),new URLSearchParams(),new Map([['mission-one',one]])).items.length,0);
  assert.throws(()=>pcTaskOptions(new Map(),new URLSearchParams(),new Map([['wrong-id',one]])),/TASK_OPTIONS_INVALID/u);
});
