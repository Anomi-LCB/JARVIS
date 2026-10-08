import test from 'node:test';import assert from 'node:assert/strict';import {renderPersonalKnowledge} from '../src/ui/workspace/personal-knowledge.js';
test('knowledge UI escapes assertions, labels lifecycle and separates empty, excluded and unavailable',()=>{
 const html=renderPersonalKnowledge({executionAuthority:false,items:[{kind:'decision',status:'conflict',subject:'<script>',predicate:'choice',value:'A',reason:'<img onerror=bad>'}],diagnostics:{excluded:{invalidObservationTime:0,futureObservationTime:1,invalidKnowledge:0}}});
 assert.match(html,/내용 충돌/);assert.match(html,/미래 시각 1건/);assert.match(html,/&lt;script&gt;/);assert.equal(html.includes('<img'),false);
 const error=renderPersonalKnowledge({status:'unavailable',items:[{value:'PRIVATE_STALE'}]});assert.match(error,/이전 내용은 표시하지/);assert.equal(error.includes('PRIVATE_STALE'),false);
 assert.match(renderPersonalKnowledge({items:[],executionAuthority:false}),/조회할 기억이 없습니다/);
 const result={executionAuthority:false,items:[{kind:'fact',status:'active',subject:'합성',predicate:'위치',value:'로컬',sourceEventId:'source',taskId:'task'}]};
 assert.equal(renderPersonalKnowledge(result).includes('data-knowledge-correct'),false);
 assert.equal(renderPersonalKnowledge(result,{editable:true}).includes('data-knowledge-correct'),true);
});
