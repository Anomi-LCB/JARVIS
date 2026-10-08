import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {MissionGrant} from '../../packages/core/src/mission/mission-runtime.js';

export const acquisitionModes=['none','lookup','question','execute'];
export function boundedChoice(value,ids){return typeof value==='string'&&ids.includes(value)?value:null;}
export function uniqueDeclaredChoice(data,target,ids){
 if(!Array.isArray(data)||data.length!==ids.length||new Set(data.map(r=>r?.id)).size!==ids.length||data.some(r=>!ids.includes(r?.id)||typeof r.region!=='string'))return null;
 const matches=data.filter(r=>r.region===target);return matches.length===1?matches[0].id:null;
}
// Only public request fields enter this adapter. The authored oracle and seeded file contents do not.
export async function acquireInformation({runtime,root,mode,request}){
 if(!acquisitionModes.includes(mode)||typeof request.target!=='string'||!request.target.trim()||request.target.length>100||!Array.isArray(request.candidateIds)||request.candidateIds.length<1||request.candidateIds.length>32||new Set(request.candidateIds).size!==request.candidateIds.length||request.candidateIds.some(id=>typeof id!=='string'||!/^[a-z0-9_-]{1,32}$/.test(id)))throw new Error('INVALID_ACQUISITION_REQUEST');
 let selected=null,result=null,questions=0,answers=0,artifactReads=0;
 if(mode==='none')return {selected:boundedChoice(request.cachedChoice,request.candidateIds),status:'cached-unverified',questions,answers,artifactReads,metrics:{}};
 const authorization={grants:[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE]};
 if(mode==='execute'){
  const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-information-comparison',durationMinutes:5});
  authorization.mode='trusted_session';authorization.ownerSessionId=owner.session.sessionId;
 }
 const created=runtime.missionRuntime.createMission({
  objective:mode==='execute'?"'candidates.json' JSON을 '원본'으로 읽고; '원본'을 'probe.json' JSON으로 저장해":mode==='lookup'?'hint.json 내용을 읽어줘':'후보 식별자를 확인해 주세요',
  authorization,successCriteria:mode==='execute'?[{statement:'첫 후보 식별자 보존',verificationSpec:{version:1,kind:'json.value',path:'probe.json',pointer:'/0/id',equals:request.candidateIds[0]}}]:['실행 검증을 통과한다']
 });
 result=await runtime.missionRuntime.runMission(created.missionId);
 if(mode==='question'){
  const gate=result.pendingGates.find(g=>g.type==='clarification');questions=gate?.questions?.length??(gate?1:0);
  if(gate&&request.userAnswer!==null){
   const accepted=runtime.missionRuntime.decideGate(created.missionId,gate.gateId,{decision:'approve',responseText:request.userAnswer});
   if(!accepted.error){answers=1;result=await runtime.missionRuntime.runMission(created.missionId);}
  }
  // Read the persisted answer observation, not the fixture's expected choice.
  const observation=result.observations.find(o=>o.category==='user_clarification'&&o.outcome==='success');
  selected=boundedChoice(observation?.data?.responseText??result.gates.find(g=>g.type==='clarification'&&g.decision==='approve')?.responseText,request.candidateIds);
 }else if(mode==='lookup'){
  const read=result.observations.find(o=>o.toolName==='filesystem.readText'&&o.outcome==='success'&&o.verification?.status==='passed');
  try{selected=boundedChoice(JSON.parse(read?.data?.textRead?.content).choice,request.candidateIds);}catch{}
 }else if(result.status==='COMPLETED'){
  artifactReads++;try{selected=uniqueDeclaredChoice(JSON.parse(await readFile(join(root,'probe.json'),'utf8')),request.target,request.candidateIds);}catch{}
 }
 return {selected,status:result.status,missionId:created.missionId,questions,answers,artifactReads,metrics:result.metrics,
  actionStatuses:result.waves.flatMap(w=>w.actions.map(a=>({tool:a.actualToolName??a.expectedToolName,status:a.status}))),
  gates:result.gates.map(g=>({type:g.type,decision:g.decision})),observationCount:result.observations.length};
}

export function acquisitionPlanner(mode,root){
 if(mode==='execute')return undefined;
 return {async planNextWave(context){
  if(mode==='question')return context.observations.some(o=>o.category==='user_clarification'&&o.outcome==='success')
   ?{decision:'blocked',blockedReason:'comparison-answer-collected-no-business-effect',actions:[]}
   :{decision:'ask_user',questions:['목표와 일치하는 후보 식별자 하나를 알려주세요.'],actions:[]};
  if(context.observations.some(o=>o.actionId))return {decision:'blocked',blockedReason:'comparison-read-collected-no-business-effect',actions:[]};
  return {decision:'continue',actions:[{id:'read',title:'추가 자료 조회',command:'hint.json 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'hint.json'),maxChars:4000},dependencies:[]}],criteriaAssessment:[]};
 }};
}
