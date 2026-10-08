import {createGoalContract} from './goal-contract.js';
import {clarificationQuestions,clarificationAnswerBatch} from './mission-clarification.js';
import {createHash} from 'node:crypto';

// Case inside a question can identify a case-sensitive file/account. Do not
// fold case or paraphrase questions into guessed semantic equivalence.
const key=text=>text.trim().replace(/[?？]+$/u,'');
function requestedField(question) {
  if(/^(?:결과|출력|저장할) 파일(?:의)? (?:이름|파일명)(?:은|을|이)? (?:무엇인가요|알려주세요|정해주세요)[?？.!。]?$/u.test(question))return 'outputFile';
  if(/^(?:원본|입력) 파일(?:의)? (?:이름|파일명)(?:은|을|이)? (?:무엇인가요|알려주세요)[?？.!。]?$/u.test(question))return 'inputFile';
  if(/^(?:메일|이메일) 수신자(?:의)? (?:주소|이메일 주소)(?:는|를|가)? (?:무엇인가요|알려주세요)[?？.!。]?$/u.test(question))return 'recipient';
  return null;
}
function exactSourceFact(mission,question) {
  let contract;try{contract=createGoalContract({objective:mission.objective});}catch{return null;}
  const field=requestedField(question);
  if(contract.contradictions?.length)return null;
  const requirements=contract.requirements.filter(r=>r.interpretation.polarity==='required');
  const selected=requirements.filter(r=>field==='outputFile'?r.interpretation.action==='save':field==='inputFile'?r.interpretation.action==='read':field==='recipient'?r.interpretation.action==='send':false);
  if(!selected.length||selected.some(r=>r.interpretation.status!=='recognized'))return null;
  const values=selected.map(r=>field==='recipient'?r.interpretation.emailRecipient?.mode==='address'?r.interpretation.emailRecipient.address:null:r.interpretation.target);
  // Repeated operations are preserved, but an identical declared target does
  // not become missing information merely because it occurs in several clauses.
  if(new Set(values).size!==1)return null;
  const r=selected[0],answer=values[0];
  if(typeof answer!=='string'||!answer||field!=='recipient'&&!/\.[a-z0-9]{1,16}$/iu.test(answer))return null;
  return {question,answer,source:'exact-original-request',requirementId:r.requirementId,sourceSpan:r.sourceSpan,
    requirementIds:selected.map(r=>r.requirementId),sourceBindings:selected.map(r=>({requirementId:r.requirementId,sourceSpan:r.sourceSpan,sourceText:r.text}))};
}

/** Information reuse only: neither an answer nor a source fact grants execution. */
export function resolveClarificationContext(mission,plan) {
  const questions=clarificationQuestions(plan)??(typeof plan.question==='string'&&plan.question.trim()?[plan.question.trim()]:null);
  if(!questions)return {questions:null,resolved:[]};
  const objectiveSha256=createHash('sha256').update(mission.objective??'').digest('hex');
  if(mission.goalContract?.objective!==mission.objective
    ||mission.goalContract?.objectiveSha256&&mission.goalContract.objectiveSha256!==objectiveSha256)
    return {questions,resolved:[],reason:'goal-source-binding-unavailable'};
  const revision=mission.goalContract?.revision??1,answers=new Map();
  for(const gate of mission.gates??[]) {
    if(gate.type!=='clarification'||gate.status!=='approved'||gate.goalRevision!==revision)continue;
    // Revision numbers alone cannot bind a restored legacy answer to its
    // original request. Preserve that history, but ask the current question
    // when its original objective proof is missing; never synthesize the proof.
    if(gate.goalObjectiveSha256!==objectiveSha256)continue;
    if(gate.questions!==undefined&&gate.questions!==null){
      // Restored history is not proof of a complete answer. Apply the same
      // bounded batch contract as a live approval, without rewriting history.
      try{
        const storedQuestions=clarificationQuestions({questions:gate.questions});
        const batch=clarificationAnswerBatch(gate,gate.answers);
        if(!batch)continue;
        storedQuestions.forEach((q,i)=>answers.set(key(q),{answer:batch.answers[i],source:'user-answer',gateId:gate.gateId}));
      }catch{continue;}
    }
    else if(typeof gate.question==='string'&&gate.question.trim()&&gate.question.length<=500
      &&typeof gate.responseText==='string'&&gate.responseText.trim()&&gate.responseText.length<=2000)
      answers.set(key(gate.question),{answer:gate.responseText,source:'user-answer',gateId:gate.gateId});
  }
  const resolved=[],remaining=[];
  for(const question of questions){const fact=exactSourceFact(mission,question),prior=answers.get(key(question));
    const result=fact??(prior?{question,...prior}:null);
    if(result)resolved.push(result);else remaining.push(question);
  }
  return {questions:remaining,resolved};
}
