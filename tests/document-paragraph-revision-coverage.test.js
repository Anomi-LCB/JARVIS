import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {documentParagraphRevisionCoverage} from '../packages/core/src/mission/document-paragraph-revision-coverage.js';
import {layoutRequirementsSha256} from '../packages/shared/src/artifact-layout-requirements.js';
const root=resolve('artifacts'),expected=['제목','본문'];
function fixture(){const objective='report.docx 워드 문서를 만들어줘. 수정된 제목과 본문 순서를 적용해.';
 const criteria=[{verificationSpec:{kind:'document.paragraphs',path:'report.docx',equals:expected}}];
 return {objective,successCriteria:criteria,goalContract:{objective,revision:2,requirements:[{text:'report.docx 워드 문서를 만들어줘.',requirementId:'r1'},{text:'수정된 제목과 본문 순서를 적용해.',requirementId:'r2'}]},
 goalRevisionRequests:[{state:'applied',targetRevision:2,input:{objective,successCriteria:structuredClone(criteria)}}],
 waves:[{actions:[{actionId:'a',taskId:'t',observationId:'o',actualToolName:'word.create',operation:{dispatch:{taskId:'t',toolName:'word.create',arguments:{path:resolve(root,'report.docx'),title:'제목',blocks:[{type:'paragraph',text:'본문'}]}}}}]}],
 observations:[{observationId:'o',data:{artifactLayoutProofs:[{kind:'document.paragraphs',requirementsSha256:layoutRequirementsSha256('document.paragraphs',expected)}]}}]};}
test('explicit revised body contract covers both bounded creation and application clauses',()=>{
 const proof=documentParagraphRevisionCoverage({mission:fixture(),roots:[root],isVerified:()=>true});assert.equal(proof.allowed,true);assert.deepEqual(proof.coveredRequirementIds,['r1','r2']);assert.equal(proof.resultCriteriaVerificationRequired,true);
});
for(const mode of ['extra-send','prohibition','no-revision','changed-criterion','wrong-target','wrong-body','no-g-proof','unverified-action','extra-action'])test(`paragraph revision rejects ${mode}`,()=>{
 const m=fixture();if(mode==='extra-send')m.goalContract.requirements.push({text:'메일로 보내',requirementId:'r3'});
 if(mode==='prohibition')m.goalContract.requirements[1].text='수정된 제목과 본문 순서를 적용하지 마.';
 if(mode==='no-revision')m.goalRevisionRequests=[];
 if(mode==='changed-criterion')m.successCriteria[0].verificationSpec.equals=['다른 제목','본문'];
 if(mode==='wrong-target')m.waves[0].actions[0].operation.dispatch.arguments.path=resolve(root,'other.docx');
 if(mode==='wrong-body')m.waves[0].actions[0].operation.dispatch.arguments.blocks[0].text='다른 본문';
 if(mode==='no-g-proof')m.observations[0].data={};
 if(mode==='extra-action')m.waves[0].actions.push(structuredClone(m.waves[0].actions[0]));
 assert.equal(documentParagraphRevisionCoverage({mission:m,roots:[root],isVerified:()=>mode!=='unverified-action'}),null);
});
