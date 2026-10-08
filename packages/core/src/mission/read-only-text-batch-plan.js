import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createGoalContract} from './goal-contract.js';
import {inspectTextReadRequirement} from './read-only-text-proof.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const localConstraints=new Set(['허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.','외부 전송과 되돌릴 수 없는 작업은 기존 정책과 유효한 위임을 확인하고 필요한 행동만 확인받는다.']);
const inside=(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');};

/** Explicit typed input reads only. Never invent a read for a prohibited file,
 * reinterpret an output criterion, or resolve an unknown source clause. */
export function planTypedTextInputReads({mission,allowedRoots=[],beforeRead=null}){
 const c=mission.goalContract,requirements=c?.requirements,criteria=mission.successCriteria;
 if(!allowedRoots.length||!requirements?.length||requirements.length>20||!criteria?.length||criteria.length>20
   ||c.objective!==mission.objective||c.objectiveSha256!==sha(mission.objective)||c.contradictions?.length
   ||c.times?.length||c.amounts?.length||c.referenceSubstitutionApplied||c.interpretationIssue
   ||c.unresolvedRequirementIds?.length||c.unresolvedCriterionIds?.length
   ||c.revisionChange?.effectConflicts?.length||c.revisionChange?.invalidatedCriterionIds?.length
   ||mission.goalRevisionRequest?.state==='pending'||mission.goalRevisionConflicts?.length
   ||(mission.constraints??[]).some(item=>!localConstraints.has(item.statement??item)))return null;
 let fresh;try{fresh=createGoalContract({objective:mission.objective});}catch{return null;}
 if(fresh.requirements.length!==requirements.length)return null;
 const roots=allowedRoots.map(root=>resolve(root)),reads=[];
 for(const [index,r] of requirements.entries()){
   const i=r.interpretation,f=fresh.requirements[index];
   if(r.text!==f.text||!isDeepStrictEqual(r.sourceSpan,f.sourceSpan)||!isDeepStrictEqual(i,f.interpretation)
     ||i.status!=='recognized'||i.compound||i.correction||i.hasExclusion||i.unresolvedReferences?.length||i.unresolvedConditions?.length
     ||i.action!==f.interpretation.action||i.target!==f.interpretation.target||i.polarity!==f.interpretation.polarity
     ||typeof i.target!=='string'||!/\.(?:txt|md|csv|json)$/iu.test(i.target))return null;
   const path=resolve(roots[0],i.target);if(!roots.some(root=>inside(root,path)))return null;
   if(i.polarity==='required'&&i.action==='read'&&!i.hasProhibition)reads.push({r,path});
   else if(i.polarity!=='prohibited'||!['delete','change','save'].includes(i.action))return null;
 }
 if(!reads.length||new Set(reads.map(item=>item.path)).size!==reads.length)return null;
 if(criteria.some(item=>item.artifactRole!=='input'||item.verificationSpec?.version!==1||item.verificationSpec.kind!=='text.equals'
   ||typeof item.verificationSpec.path!=='string'||!reads.some(read=>read.path===resolve(roots[0],item.verificationSpec.path))))return null;
 if(reads.some(read=>!criteria.some(item=>resolve(roots[0],item.verificationSpec.path)===read.path)))return null;
 const history=(mission.waves??[]).flatMap(w=>w.actions??[]);
 if(history.some(a=>!Number.isSafeInteger(a.goalRevision)||a.goalRevision<1||a.goalRevision>c.revision))return null;
 // Previous reads remain in history, but only the current revision can prove
 // the corrected request. This matches the independent text-read verifier.
 const actions=history.filter(a=>a.goalRevision===c.revision);
 if(actions.some(a=>(a.actualToolName??a.expectedToolName)!=='filesystem.readText'
   ||a.requirementIds?.length!==1||!reads.some(read=>read.r.requirementId===a.requirementIds[0])))return null;
 for(const read of reads){
   let offset=0;
   if(actions.some(a=>a.requirementIds[0]===read.r.requirementId)){
     const proof=inspectTextReadRequirement({mission,requirement:read.r,allowedRoots:roots,beforeRead});
     if(!proof.applicable||proof.reasons)return null;
     if(proof.passed)continue;
     offset=proof.nextOffset;
   }
   return {decision:'continue',summary:'명시한 입력 파일을 현재 증거에 이어 읽고 검증합니다.',criteriaAssessment:[],
     planning:{mode:'typed-input-read-sequence',modelRoundTrips:0},actions:[{
       id:`input-read-${read.r.requirementId}-${offset}`,command:read.r.text,expectedToolName:'filesystem.readText',
       arguments:{path:read.path,offset,maxChars:50000},dependencies:[],requirementIds:[read.r.requirementId],
       successSignal:'현재 입력 전체 읽기와 독립 typed 내용 검증'}]};
 }
 return null;
}
