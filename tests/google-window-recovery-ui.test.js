import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleSetup} from '../src/ui/google-setup.js';
const option={provider:'gmail',expectedWindowId:'old-window',expectedGeneration:'old-generation',timeMin:'2026-09-24T00:00:01Z',timeMax:'2026-10-08T00:00:00Z'};
function fixture(request){
 const handlers={},calls=[];let refreshes=0;
 const ui=createGoogleSetup({simple:true,escape:x=>String(x).replaceAll('<','&lt;'),request:async(...args)=>{calls.push(args);return request(...args);},changed:()=>{},refresh:async()=>{refreshes++;ui.update({connection:{status:'connected'},google:{status:'ready',recoveryOptions:[]},localConnections:[]});}});
 ui.update({connection:{status:'connected'},google:{status:'degraded',recoveryOptions:[option]},localConnections:[]});
 ui.attach({addEventListener:(event,fn)=>handlers[event]=fn});
 return {ui,calls,refreshes:()=>refreshes,click:()=>handlers.click({target:{closest:selector=>selector==='[data-google-recovery]'?{dataset:{googleRecovery:'old-window'}}:null}})};
}
test('ordinary connection screen offers a clear recovery action outside advanced settings',()=>{
 const f=fixture(()=>{}),html=f.ui.render();assert.match(html,/멈춘 자료 수집 복구/);assert.match(html,/메일 기록 복구하고 수집/);assert.match(html,/이미 저장된 자료와 사용 기록은 삭제하지/);
 assert.ok(html.indexOf('data-google-window-recovery')>html.indexOf('</details></section>'));
});
test('one recovery action sends the observed versions then runs the normal bounded sync only after confirmation',async()=>{
 const f=fixture(path=>path.endsWith('restart-window')?{currentWindowVerified:true,replayed:false}:{status:'ready'});
 await f.click();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],['/personal-google/restart-window',{method:'POST',body:{provider:'gmail',expectedWindowId:'old-window',expectedGeneration:'old-generation'}}]);
 assert.equal(f.calls[1][0],'/personal-google/sync');assert.equal(f.refreshes(),1);assert.match(f.ui.render(),/설정 범위의 자료 수집을 확인/);
});
test('lost recovery response retries exactly the same request and uses its historical receipt without another sync',async()=>{
 let attempt=0;const f=fixture(()=>{if(!attempt++)throw Error('lost-response');return {replayed:true,currentWindowVerified:false};});
 await f.click();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.match(f.ui.render(),/보관된 복구 결과/);
});
test('explicit conflict is not retried and cannot trigger collection',async()=>{
 const f=fixture(()=>{throw {payload:{error:{code:'A_GOOGLE_RECOVERY_CONFLICT'}}};});await f.click();assert.equal(f.calls.length,1);assert.match(f.ui.render(),/기존 자료는 삭제하지/);
});
test('double click cannot dispatch a second recovery while the first is pending',async()=>{
 let release;const held=new Promise(r=>release=r),f=fixture(async()=>{await held;return {replayed:true,currentWindowVerified:false};});
 const pending=f.click();await f.click();assert.equal(f.calls.length,1);release();await pending;assert.equal(f.calls.length,1);
});
