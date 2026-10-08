import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {resolve} from 'node:path';
import {createGoalContract} from './goal-contract.js';
import {clarificationAnswerBatch,clarificationReadBinding} from './mission-clarification.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const localConstraints=new Set(['허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.','외부 전송과 되돌릴 수 없는 작업은 기존 정책과 유효한 위임을 확인하고 필요한 행동만 확인받는다.']);
/** A conflict explanation, not an implicit criterion-role migration or authority grant. */
export function planReadCriterionRoleClarification({mission,allowedRoots=[],maxActions=4}){
 try{
  const c=mission.goalContract,criteria=mission.successCriteria;
  if(!allowedRoots.length||c?.objective!==mission.objective||c.objectiveSha256!==hash(mission.objective)
   ||c.contradictions?.length||c.times?.length||c.amounts?.length||c.referenceSubstitutionApplied||c.interpretationIssue
   ||c.unresolvedRequirementIds?.length||c.unresolvedCriterionIds?.length||mission.goalRevisionRequest?.state==='pending'
   ||c.revisionChange?.effectConflicts?.length||c.revisionChange?.invalidatedCriterionIds?.length
   ||!criteria?.length||criteria.length>8||(mission.constraints??[]).some(v=>!localConstraints.has(v.statement??v)))return null;
  const fresh=createGoalContract({objective:mission.objective});
  if(!fresh.requirements.length||fresh.requirements.length>20||fresh.requirements.length!==c.requirements.length)return null;
  const reads=[];
  for(const [index,r] of c.requirements.entries()){
   const i=r.interpretation,f=fresh.requirements[index];
   if(r.text!==f.text||!isDeepStrictEqual(r.sourceSpan,f.sourceSpan)||!isDeepStrictEqual(i,f.interpretation)
    ||i.status!=='recognized'||i.compound||i.correction||i.hasExclusion||i.unresolvedReferences?.length||i.unresolvedConditions?.length
    ||typeof i.target!=='string'||!/\.(?:txt|md|csv|json)$/iu.test(i.target))return null;
   if(i.polarity==='required'&&i.action==='read'&&!i.hasProhibition)reads.push(r);
   else if(i.polarity!=='prohibited'||!['delete','change','save'].includes(i.action))return null;
  }
  if(!reads.length||!Number.isSafeInteger(maxActions)||maxActions<1||maxActions>8||reads.length>maxActions||criteria.some(v=>v.verificationSpec?.kind!=='text.equals'||v.verificationSpec.version!==1
   ||typeof v.verificationSpec.path!=='string'||!c.requirements.some(r=>resolve(allowedRoots[0],r.interpretation.target)===resolve(allowedRoots[0],v.verificationSpec.path))))return null;
  const conflicts=criteria.flatMap((v,index)=>v.artifactRole==='input'?[]:[{criterionId:v.criterionId,index}]);
  if(!conflicts.length)return null;
  const questions=conflicts.map(({index})=>`성공 기준 ${index+1}은 새 결과물의 증거를 요구하지만 원문은 읽기·보존만 요청합니다. 기존 자료의 확인 기준으로 수정할까요, 별도 결과물이 필요한가요?`);
  if((mission.gates??[]).some(g=>{
   if(g.type!=='clarification'||g.status!=='approved'||g.goalRevision!==c.revision
    ||g.goalObjectiveSha256!==hash(mission.objective)||!isDeepStrictEqual(g.questions,questions))return false;
   try{return clarificationAnswerBatch(g,g.answers)!==null;}catch{return false;}
  }))return null;
  const actions=[];
  for(const r of reads){
   const prior=(mission.waves??[]).flatMap(w=>w.actions??[]).filter(a=>a.goalRevision===c.revision&&a.requirementIds?.includes(r.requirementId));
   // Prior attempts are history, not completion proof. Do not reread to manufacture output evidence.
   if(prior.length)continue;
   const path=resolve(allowedRoots[0],r.interpretation.target);
   if(!clarificationReadBinding(mission,'filesystem.readText',{path},allowedRoots))continue;
   actions.push({id:`role-independent-read-${r.requirementId}`,command:r.text,expectedToolName:'filesystem.readText',arguments:{path,offset:0,maxChars:50000},
    clarificationIndependent:true,dependencies:[],requirementIds:[r.requirementId],successSignal:'명시된 입력의 G 검증 읽기. 산출물 기준 충족 아님.'});
  }
  return {decision:'ask_user',summary:'기존 자료 읽기는 계속하고 원문과 성공 기준의 역할 차이만 한 번에 확인합니다. 답변만으로 기준·쓰기 권한을 바꾸지 않습니다.',questions,actions,
   criteriaAssessment:[],planning:{mode:'read-criterion-role-clarification',modelRoundTrips:0,criterionIds:conflicts.map(v=>v.criterionId),criteriaChanged:false,executionAuthorized:false}};
 }catch{return null;}
}
