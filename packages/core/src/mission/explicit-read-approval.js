import {createHash} from 'node:crypto';
import {createGoalContract} from './goal-contract.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
const finalStatement=objective=>`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`;
const localConstraints=new Set(['허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.','외부 전송과 되돌릴 수 없는 작업은 기존 정책과 유효한 위임을 확인하고 필요한 행동만 확인받는다.']);

/** A bounded user-owned permission predicate, not a factual condition oracle.
 * No action/permission is granted here; E/B/G still handle the effective goal.
 */
export function explicitReadApproval(mission){
 try{
  if(mission.goalContract?.objective!==mission.objective||mission.goalContract.objectiveSha256!==sha(mission.objective)
    ||mission.goalRevisionRequest?.state==='pending'||mission.waves?.some(w=>w.actions?.some(a=>a.attempts>0))
    ||mission.constraints?.some(c=>!localConstraints.has(c.statement??c))||mission.selectedSource)return null;
  const match=/^(?:내가\s+승인하면|내\s+승인을\s+받은\s+후)\s+(.+)$/u.exec(mission.objective);
  if(!match)return null;
  const objective=match[1],contract=createGoalContract({objective});
  if(contract.requirements.length!==1||contract.times.length||contract.amounts.length||contract.constraints.length||contract.contradictions.length)return null;
  const i=contract.requirements[0].interpretation;
  if(i.status!=='recognized'||i.action!=='read'||i.polarity!=='required'||i.compound||i.hasExclusion||i.hasProhibition||i.correction
    ||i.unresolvedReferences?.length||i.unresolvedConditions?.length||typeof i.target!=='string'||!/\.(?:txt|md|csv|json)$/iu.test(i.target))return null;
  const criteria=mission.successCriteria;
  if(criteria?.length!==1||criteria[0].verificationSpec||! [mission.objective,finalStatement(mission.objective)].includes(criteria[0].statement))return null;
  return {version:'a-explicit-read-approval-v1',objectiveSha256:sha(mission.objective),goalRevision:mission.goalContract.revision,
    effectiveObjective:objective,target:i.target,question:`“${i.target}” 파일을 지금 읽도록 승인하시겠습니까? 승인한다면 “승인”이라고 답해 주세요.`,
    successCriteria:[finalStatement(objective)],executionAuthority:false};
 }catch{return null;}
}
export function explicitApprovalAnswer({answers,responseText}){
 const value=Array.isArray(answers)&&answers.length===1?answers[0]:answers===undefined?responseText:null;
 return typeof value==='string'&&['승인','승인합니다'].includes(value.trim());
}
