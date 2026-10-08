import test from 'node:test';
import assert from 'node:assert/strict';
import {compileNaturalWorkflowObjective} from '../packages/core/src/mission/natural-workflow-compiler.js';
const base="'source.txt' 텍스트를 '자료'로 읽어; '자료'에서 '업체'의 '개선율' 주장을 '%' 단위 숫자로 추출해 '주장'으로 만들어; '자료'에서 '기존'을 '초' 단위 숫자로 추출해 '전'으로 만들어; '자료'에서 '변경'을 '초' 단위 숫자로 추출해 '후'으로 만들어; '전'과 '후'을 값 감소율로 비교해 '주장'과 허용오차 0 퍼센트포인트로 대조해 '대조'로 만들어; '대조'를 'comparison.json' JSON으로 저장해";
test('natural comparison preserves all clauses and requires an explicit percentage definition',()=>{
 const result=compileNaturalWorkflowObjective(base,{workspaceRoot:process.cwd()});assert.equal(result.status,'compiled',result.reason);
 const node=result.spec.nodes.find(n=>n.op==='compute.compareChange');assert.equal(node.args.metric,'decrease-percent');assert.equal(node.dependsOn.length,3);
 assert.notEqual(compileNaturalWorkflowObjective(base.replace('값 감소율','개선율'),{workspaceRoot:process.cwd()}).status,'compiled');
 assert.notEqual(compileNaturalWorkflowObjective(base+'; 이 주장이 사실인지 독립 검증해',{workspaceRoot:process.cwd()}).status,'compiled');
});
export {base};
