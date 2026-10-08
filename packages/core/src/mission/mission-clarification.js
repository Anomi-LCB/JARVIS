import {createGoalContract} from './goal-contract.js';
import {resolve,relative,isAbsolute,sep,extname} from 'node:path';
import {realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Only reviewed local observations may run while a user decision is pending.
const localReads = new Set(['filesystem.listFiles', 'filesystem.readText','document.readPdf','excel.readWorkbook']);
export function clarificationQuestions(plan) {
  if (plan.questions === undefined) return null;
  if (!Array.isArray(plan.questions) || !plan.questions.length || plan.questions.length > 8) throw new Error('A_MISSION_QUESTIONS_INVALID');
  const questions = plan.questions.map(q => {
    if (typeof q !== 'string' || !q.trim() || q.length > 500) throw new Error('A_MISSION_QUESTIONS_INVALID');
    return q.trim();
  });
  if (new Set(questions).size !== questions.length) throw new Error('A_MISSION_QUESTIONS_INVALID');
  return questions;
}
export function independentClarificationRead(action) {
  return action?.clarificationIndependent === true && localReads.has(action.expectedToolName)
    && Array.isArray(action.dependencies) && action.dependencies.length === 0;
}
export function clarificationDispatchAllowed(wave, action, profile) {
  return !(wave.clarificationGateId || wave.clarificationContextResolved) || (localReads.has(action.expectedToolName)
    && action.actualToolName === action.expectedToolName && profile.contractReadOnly === true
    && profile.readOnly === true && profile.mutatesSystem === false
    && profile.externalTransfer === false && profile.externalNetwork === false
    && profile.executionClass === 'read_only');
}

// Validate structural answer completeness without claiming semantic correctness.
export function clarificationAnswerBatch(gate, answers) {
  if (answers === undefined) return null;
  if (gate.type !== 'clarification' || !Array.isArray(gate.questions) || !gate.questions.length
    || !Array.isArray(answers) || answers.length !== gate.questions.length) throw new Error('A_MISSION_CLARIFICATION_ANSWERS_INVALID');
  const normalized = answers.map(answer => {
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 500) throw new Error('A_MISSION_CLARIFICATION_ANSWERS_INVALID');
    return answer.trim();
  });
  const responseText = normalized.map((answer, index) => `${index + 1}. ${answer}`).join('\n');
  if (responseText.length > 2000) throw new Error('A_MISSION_CLARIFICATION_ANSWERS_INVALID');
  return { answers: normalized, responseText, coverage: 'all-fields-present', semanticVerification: 'unverified' };
}

// A model's independence label is not source authority. Bind only reviewed,
// recognized explicit local reads; unresolved purposes wait for clarification.
export function clarificationReadBinding(mission, toolName, args, allowedRoots) {
  try {
    const requestedPath=toolName==='filesystem.listFiles'?args?.directory:args?.path;
    if (!localReads.has(toolName) || mission.goalContract?.objective !== mission.objective
      || typeof requestedPath !== 'string' || !requestedPath || !allowedRoots?.length) return null;
    // The reviewed parsers read only their native local formats. A model label
    // cannot route an arbitrary file through a more permissive observation path.
    if(toolName==='document.readPdf'&&extname(requestedPath).toLowerCase()!=='.pdf'
      ||toolName==='excel.readWorkbook'&&extname(requestedPath).toLowerCase()!=='.xlsx')return null;
    const hash=createHash('sha256').update(mission.objective).digest('hex');
    if(mission.goalContract.objectiveSha256 && mission.goalContract.objectiveSha256!==hash)return null;
    const contract=createGoalContract({objective:mission.objective});
    if(contract.contradictions?.length)return null;
    const actual=resolve(allowedRoots[0],requestedPath),physical=realpathSync(actual);
    const inside=(root,path)=>{const r=relative(root,path);return r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r));};
    if(!allowedRoots.some(root=>inside(resolve(root),actual)&&inside(realpathSync(root),physical)))return null;
    const kind=toolName==='filesystem.listFiles'?'list':'read';
    const matching=contract.requirements.filter(r=>r.interpretation.status==='recognized'
      &&r.interpretation.polarity==='required'&&r.interpretation.action===kind
      &&!r.interpretation.hasExclusion&&!r.interpretation.hasProhibition
      &&typeof r.interpretation.target==='string'
      &&resolve(allowedRoots[0],r.interpretation.target)===actual);
    if(!matching.length)return null;
    return {version:'a-clarification-read-source-v1',objectiveSha256:hash,toolName,path:actual,physicalPath:physical,
      requirementIds:matching.map(r=>r.requirementId),sourceBindings:matching.map(r=>({requirementId:r.requirementId,sourceSpan:r.sourceSpan,sourceText:r.text}))};
  } catch { return null; }
}
export function sameClarificationReadBinding(before,after){
  return Boolean(before&&after&&JSON.stringify(before)===JSON.stringify(after));
}
