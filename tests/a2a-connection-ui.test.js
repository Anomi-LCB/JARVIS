import test from 'node:test';
import assert from 'node:assert/strict';
import {renderA2aServices} from '../src/ui/connections/a2a.js';
import {escape} from '../src/ui/connections/connection-center.js';
test('A2A page distinguishes declared metadata from execution and preserves escaped text drafts',()=>{
 const service={id:'id',label:'<img src=x onerror=alert(1)>',source:'https://example.org',card:{name:'외부 이름',version:'1.0',description:'<script>authority()</script>',supportedInterfaces:[],defaultInputModes:['text/plain'],defaultOutputModes:['text/plain']},skills:[{skillId:'research',status:'review-required'}]};
 const html=renderA2aServices({services:[service]},{escape,auth:true,draft:{label:'입력 유지',source:'https://example.org'}});
 assert.match(html,/입력 유지/);assert.match(html,/입력·출력·실행 효과의 로컬 검토 필요/);assert.match(html,/업무 실행 연결은 준비되지 않았습니다/);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src='));
 assert.match(renderA2aServices(null,{escape}),/상태를 확인하지 못했습니다/);
 assert.match(renderA2aServices({services:[]},{escape}),/아직 등록한 전문 서비스가 없습니다/);
});
