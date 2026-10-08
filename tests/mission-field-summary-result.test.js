import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
import {extractLiteralSourceFields} from '../packages/core/src/mission/literal-source-fields.js';
import {verifyFieldSummaryResult} from '../packages/core/src/mission/mission-field-summary-result.js';
import {verifyFieldSummaryResultAsync} from '../packages/core/src/mission/field-summary-async.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const verifier of [verifyFieldSummaryResult,verifyFieldSummaryResultAsync])for(const mode of ['valid','changed-source','changed-output','rebound-receipt','missing-receipt','other-criterion',...(verifier===verifyFieldSummaryResultAsync?['async-guard']:[])])test('current field-summary result verifier '+verifier.name+' '+mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-field-result-'));try{
 const objective="'source.txt' 파일에서 항목 '실제 지출액'의 '원' 단위 숫자, '승인 여부'의 승인 상태를 정리해 'result.json'에 JSON으로 저장하고 다시 읽어 확인해줘";
 const compiled=compileNaturalWorkflowObjective(objective,{workspaceRoot:root}),nodes=compiled.spec.nodes;
 const source='실제 지출액은 0원이다. 승인 여부: 미승인.';
 const output={...extractLiteralSourceFields({source,...nodes[1].args}),sourceSha256:hash(source)};
 const serialized=JSON.stringify(output);writeFileSync(join(root,'source.txt'),source);writeFileSync(join(root,'result.json'),serialized);
 const receipts=nodes.map(n=>({nodeId:n.id,op:n.op,status:'success',...(n.op==='text.read'?{source:{path:join(root,'source.txt'),sha256:hash(source)}}:n.op==='text.extractFields'?{sourceSha256:hash(source)}:n.op==='data.readJson'?{source:{path:join(root,'result.json'),sha256:hash(serialized)}}:{})}));
 if(mode==='changed-source')writeFileSync(join(root,'source.txt'),source+' 실제 지출액은 5원이다.');
 if(mode==='changed-output')writeFileSync(join(root,'result.json'),serialized.replace('"0"','"450000"'));
 if(mode==='rebound-receipt')receipts[0].source.path=join(root,'other.txt');
 if(mode==='missing-receipt')receipts.pop();
 const statement=mode==='other-criterion'?'실제 지출액은 450000원이다':`${objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`;
 let accesses=0;
 const options=mode==='async-guard'?{beforeAccess:async({path,kind})=>{accesses++;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(kind,'read');return `file:${path}`;}}:undefined;
 const result=await verifier({objective,statement,allowedRoots:[root],observations:[{toolName:'workflow.execute',outcome:'success',verification:{status:'passed'},data:{workflow:{workflowId:compiled.spec.workflowId,specSha256:hash(JSON.stringify(compiled.spec)),nodeCount:nodes.length,receipts}}}]},options);
 if(mode==='other-criterion')assert.equal(result.applicable,false);else assert.equal(result.passed,mode==='valid'||mode==='async-guard');
 if(mode==='async-guard')assert.equal(accesses,8);
 }finally{rmSync(root,{recursive:true,force:true});}
});
