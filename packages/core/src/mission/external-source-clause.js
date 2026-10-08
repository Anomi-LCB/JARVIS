import {createGoalContract,tokenizeGoalSource} from './goal-contract.js';

// A receipt for one file operation cannot discharge arbitrary words preceding
// that operation. Reparse exact source, then consume the entire bounded clause.
export function externalSourceClauseBound(mission,requirement) {
  const objective=mission.goalContract?.objective,span=requirement.sourceSpan;
  if(typeof objective!=='string'||objective!==mission.objective
    ||!Number.isSafeInteger(span?.start)||!Number.isSafeInteger(span?.end)
    ||span.start<0||span.end<=span.start||span.end>objective.length
    ||objective.slice(span.start,span.end)!==requirement.text)return false;
  let parsed,source;
  try{const contract=createGoalContract({objective:requirement.text});
    if(contract.requirements.length!==1)return false;
    parsed=contract.requirements[0].interpretation;source=tokenizeGoalSource(requirement.text);
  }catch{return false;}
  const stored=requirement.interpretation;
  if(parsed.status!=='recognized'||parsed.compound||parsed.correction||parsed.unresolvedReferences.length
    ||parsed.action!==stored?.action||parsed.target!==stored?.target||parsed.polarity!==stored?.polarity)return false;
  if(parsed.action==='send'||parsed.creation===true)return true;
  if(source.strings.length>1)return false;
  const text=source.clauses[0].replace(/§0§/gu,'대상');
  return /^(?:(?:먼저|그리고|다음으로|그다음|이어서|마지막으로)\s+)?(?:대상|[^\s"'“”‘’]+\.[a-z0-9]{1,16})(?:의)?\s*(?:파일(?:의)?\s*)?(?:내용|본문|원문)?(?:을|를|은|는|도)\s+(?:(?:아직|절대|안)\s+)?(?:읽|저장|수정|변경|삭제|제거)(?:어(?:줘|주세요)?|해(?:줘|주세요)?|줘|주세요|지\s*(?:마(?:세요)?|말아|말고)|하지\s*(?:마(?:세요)?|말아|말고))?[.!。!?！？]?$/iu.test(text.trim());
}
