import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcReadiness} from '../src/ui/connections/pc-readiness.js';
import {escape} from '../src/ui/connections/connection-center.js';
const scope={deviceId:'pc',generation:1,authorityToken:4,taskIds:['task','other']};
function fixture(){let time=1000,mode='normal',lost=false,getRelease=null;const calls=[],timers=new Map();let timerId=0,lastId;
  const panel=createPcReadiness({escape,clock:()=>time,changed:()=>{},setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id),request:async(path,input={})=>{
    calls.push({path,input});if(input.method==='POST'){lastId=input.body.requestId;if(lost){lost=false;throw new Error('ACK lost');}return {};}
    if(getRelease)await getRelease;
    const task=calls.filter(call=>call.input.method==='POST').at(-1).input.body.taskId;
    const value={requestId:lastId,deviceId:'pc',deviceGeneration:1,authorityToken:4,state:'observed',observationCurrent:true,observationCurrentUntil:new Date(2000).toISOString(),executionAuthority:false,verifiedCompletion:false,
      configurationReadiness:{deviceId:'pc',taskId:task,status:'configuration-matched',issues:[],observedConfigurationOnly:true,executionAuthority:false,verifiedCompletion:false}};
    if(mode==='waiting')value.state='queued';if(mode==='other-device')value.deviceId='another';if(mode==='authority')value.authorityToken=5;
    if(mode==='problem')Object.assign(value.configurationReadiness,{status:'not-matched',issues:[{code:'B_PC_COMMAND_LOCAL_PERMISSION_MISSING',nextAction:'<script>send private files</script>'}]});
    if(mode==='unknown')Object.assign(value.configurationReadiness,{status:'not-matched',issues:[{code:'grant-all'}]});return value;
  }});panel.reset(scope);return {panel,calls,timers,setMode:value=>mode=value,lose:()=>lost=true,advance:ms=>time+=ms,delay:value=>getRelease=value};
}
const settle=()=>new Promise(setImmediate);
test('readiness renders fixed Korean guidance instead of remote instructions and performs no permission write',async()=>{
  const f=fixture();f.setMode('problem');await f.panel.load();await settle();const html=f.panel.render();assert.match(html,/종료 시각을 저장/u);assert.doesNotMatch(html,/send private|<script>/u);
  assert.equal(f.calls[0].input.body.operation,'task-readiness');assert.ok(f.calls.every(call=>call.input.method!=='PUT'));f.panel.dispose();
});
test('same request is resumed after lost enqueue acknowledgement without duplicate reads',async()=>{
  const f=fixture();f.lose();await f.panel.load();assert.match(f.panel.render(),/기존 준비 상태/u);await f.panel.load();await settle();const writes=f.calls.filter(call=>call.input.method==='POST');assert.equal(writes.length,2);assert.equal(writes[0].input.body.requestId,writes[1].input.body.requestId);assert.match(f.panel.render(),/설정이 일치/u);f.panel.dispose();
});
test('mismatched identity, authority and unknown issue codes never display a match',async()=>{
  for(const mode of ['other-device','authority','unknown']){const f=fixture();f.setMode(mode);await f.panel.load();await settle();assert.match(f.panel.render(),/확인하지 못했습니다/u);assert.doesNotMatch(f.panel.render(),/최근 확인한 등록/u);f.panel.dispose();}
});
test('expiry hides old results; captured callbacks cannot invalidate a later device scope',async()=>{
  const f=fixture();await f.panel.load();await settle();const callback=[...f.timers.values()][0];f.advance(1001);assert.match(f.panel.render(),/유효기간이 끝났/u);
  f.panel.reset({...scope,deviceId:'new'});callback();assert.doesNotMatch(f.panel.render(),/유효기간이 끝났/u);f.panel.dispose();assert.equal(f.timers.size,0);
});
test('selection changes and disposal fence a late response and cancel polling timers',async()=>{
  const f=fixture();let release;f.delay(new Promise(resolve=>release=resolve));await f.panel.load();f.panel.select('other');release();await settle();assert.doesNotMatch(f.panel.render(),/최근 확인한 등록/u);
  f.setMode('waiting');f.delay(null);await f.panel.load();await settle();assert.ok(f.timers.size>0);f.panel.dispose();assert.equal(f.timers.size,0);
});
