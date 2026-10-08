import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createGoalContract} from './goal-contract.js';
import {evaluateGoalQuantityConstraints} from './goal-quantity-expression.js';
import {verifyArtifactConsistencyCriterion} from './criteria-evidence.js';

// Deliberately bounded literal record format. No inference about recipients,
// documents, pages, deliveries, clinical quantities or record meaning.
export function recordCountSource(mission){
 const match=/^'([^'\r\n]+\.txt)'에 (.+)의 기록을 줄바꿈으로 저장해[.!]?$/u.exec(mission.objective??'');
 if(!match)return null;
 const contract=createGoalContract({objective:mission.objective});
 const quantities=contract.quantities;
 if(quantities.length!==1||quantities[0].text!==match[2]||quantities[0].baseUnit!=='건'||quantities[0].distribution)return null;
 return {path:match[1],contract};
}

export function verifyMissionRecordCount({mission,criterion,observations,evidenceActionIds,allowedRoots,beforeAccess}){
 const source=recordCountSource(mission);
 if(!source||criterion.statement!==mission.objective)return {applicable:false};
 const deny=reason=>({applicable:true,passed:false,status:'unverified',reasons:[reason],checks:[]});
 if(mission.goalContract?.objective!==mission.objective||mission.goalContract.objectiveSha256!==createHash('sha256').update(mission.objective).digest('hex'))return deny('record-count-source-changed');
 if(criterion.artifactRole==='input')return deny('record-count-output-contract-required');
 // Preserve explicit content checks; final Mission completion independently
 // applies the original count even when a different typed criterion passes.
 if(criterion.verificationSpec)return {applicable:false};
 // Remote effects need their own fresh PC oracle; do not use Core's file view.
 if(mission.waves?.flatMap(w=>w.actions).some(a=>evidenceActionIds.includes(a.actionId)&&a.remoteArtifactIntent))return deny('record-count-remote-observation-required');
 const result=verifyArtifactConsistencyCriterion({spec:{},observations,evidenceActionIds,roots:allowedRoots.map(root=>resolve(root)),
  filePaths:{records:source.path},beforeAccess,compare:({files})=>{
   let text;
   try{text=new TextDecoder('utf-8',{fatal:true}).decode(files.records);}catch{return deny('record-count-invalid-utf8');}
   // Permit one conventional terminal newline; blank rows remain invalid rather
   // than disappearing from the count. Mixed CR/LF and control text are rejected.
   const normalized=text.replace(/\r\n/g,'\n').replace(/\n$/u,'');
   const lines=normalized===''?[]:normalized.split('\n');
   if(text!==''&&normalized===''||/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)||lines.some(line=>!line.trim()))return deny('record-count-invalid-record');
   const quantity=source.contract.quantities[0];
   const calculation=evaluateGoalQuantityConstraints(source.contract,[{quantityId:quantity.quantityId,baseUnit:'건',baseUnits:lines.length}]);
   const passed=calculation.passed===true;
   return {passed,status:passed?'passed':'failed',reasons:passed?[]:calculation.checks.map(c=>c.reason),checks:[{
    checkId:'source_quantity_record_count',passed,actualRecordCount:lines.length,quantityId:quantity.quantityId,
    goalRevision:mission.goalContract.revision,sourceObjectiveSha256:mission.goalContract.objectiveSha256,
    artifactContentSha256:createHash('sha256').update(files.records).digest('hex'),
    measurementProvenanceVerified:true,verificationScope:'current-g-bound-utf8-nonblank-lines',
    semanticRecordQualityVerified:false,executionAuthorized:false}]};
  }});
 return {applicable:true,...result};
}
