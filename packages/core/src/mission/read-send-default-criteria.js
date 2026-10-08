import {createGoalContract} from './goal-contract.js';
import {externalSourceClauseBound} from './external-source-clause.js';

// Infer only a complete, bounded read/send request. Explicit caller criteria
// and the separate source/dispatch coverage guard remain authoritative.
export function readSendDefaultCriteria(objective) {
  let contract;
  try { contract=createGoalContract({objective}); } catch { return null; }
  const requirements=contract.requirements;
  if(requirements.length<2 || requirements.length>20 || contract.constraints.length
    || contract.amounts.length || contract.times.length || contract.contradictions.length
    || !requirements.some(r=>r.interpretation.action==='send')) return null;
  if(!requirements.every(r=>externalSourceClauseBound({objective,goalContract:contract},r)))return null;
  if(requirements.some(({interpretation:i})=>i.status!=='recognized' || i.polarity!=='required'
    || i.correction || i.hasExclusion || i.hasProhibition
    || !['read','send'].includes(i.action) || typeof i.target!=='string'
    || !/^[^'"\r\n]+\.(?:txt|md|csv|json|xlsx|docx|pdf|hwpx|pptx)$/iu.test(i.target)
    || (i.action==='send' && !['address','self'].includes(i.emailRecipient?.mode)))) return null;
  return requirements.map((r,index)=>({criterionId:`read_send_${index+1}`,
    requirementId:r.requirementId,sourceSpan:r.sourceSpan,
    statement:r.interpretation.action==='read'?`'${r.interpretation.target}'를 읽는다`:'이메일 공급자가 발송을 수락했다'}));
}
