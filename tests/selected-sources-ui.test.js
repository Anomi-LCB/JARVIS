import test from 'node:test';
import assert from 'node:assert/strict';
import {createSelectedSources} from '../src/ui/connections/selected-sources.js';
const selection={provider:'outlook',streamRef:'a'.repeat(64),itemCount:51};
const escape=s=>String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(){let revoked=false,enabled=true,hold;const calls=[];const panel=createSelectedSources({escape,changed(){},request:async(path,options)=>{
 calls.push({path,options});if(hold&&path.includes('verified-selected-source'))await hold;
 if(path==='/personal-inbox/streams')return {items:[selection],missionEnabled:enabled};
 if(path==='/owner-session')return {session:{status:'active',sessionId:'owner'}};
 if(path==='/personal-inbox/selected-source-history')return {provider:selection.provider,streamRef:selection.streamRef,revision:'b'.repeat(64),total:1,offset:0,nextOffset:null,items:[{missionId:'one',status:'COMPLETED',createdAt:'2026-10-07T00:00:00Z',currentResultVerified:false}]};
 if(path==='/missions')return {missionId:'one'};
 if(path.endsWith('/run'))return {status:'COMPLETED'};
 if(path.endsWith('/cancel'))return {status:'CANCELLED'};
 if(path.endsWith('/verified-selected-source')){if(revoked)return {success:false,status:'unverified'};return {success:true,status:'verified',result:{...selection,total:51,pageCount:1,items:Array.from({length:51},(_,i)=>({id:String(i),title:i?'자료 '+i:'<img src=x onerror=alert(1)>PRIVATE_TITLE'}))}};}
 throw new Error('unexpected '+path);
 }});return {panel,calls,revoke:()=>revoked=true,disable:()=>enabled=false,hold:value=>hold=value};}
test('selection binds actual request, escapes stored text and clears withdrawn results',async()=>{
 const f=fixture();await f.panel.refresh();f.panel.select(selection.streamRef);await f.panel.run();assert.match(f.panel.render(),/전체 51개 검증/);assert.match(f.panel.render(),/&lt;img/);assert.doesNotMatch(f.panel.render(),/<img/);
 const created=f.calls.find(c=>c.path==='/missions');assert.deepEqual(created.options.body.selectedSource,{provider:selection.provider,streamRef:selection.streamRef});assert.equal(created.options.body.authorization.ownerSessionId,'owner');assert.equal(f.calls.some(c=>c.path.includes('activate')),false);
 const revalidated=f.calls.find(c=>c.path.endsWith('/verified-selected-source'));assert.equal(revalidated.options.method,'POST');assert.deepEqual(revalidated.options.body,{ownerSessionId:'owner'});
 f.revoke();await f.panel.refresh();assert.doesNotMatch(f.panel.render(),/PRIVATE_TITLE|전체 51개 검증/);assert.match(f.panel.render(),/숨겼습니다/);
});
test('new panel finds historical Mission without dispatching it again',async()=>{
 const f=fixture();await f.panel.refresh();f.panel.select(selection.streamRef);await f.panel.refresh();
 assert.match(f.panel.render(),/이전 조회 찾기/);assert.doesNotMatch(f.panel.render(),/PRIVATE_TITLE/);
 await f.panel.openHistory('unknown');assert.equal(f.calls.some(c=>c.path.includes('verified-selected-source')),false);
 await f.panel.openHistory('one');assert.match(f.panel.render(),/PRIVATE_TITLE/);
 assert.equal(f.calls.some(c=>c.path==='/missions'||c.path.endsWith('/run')),false);
 f.revoke();await f.panel.openHistory('one');assert.doesNotMatch(f.panel.render(),/PRIVATE_TITLE/);
});
test('selection changes discard an old in-flight result',async()=>{
 const f=fixture();await f.panel.refresh();f.panel.select(selection.streamRef);await f.panel.run();let release;f.hold(new Promise(r=>release=r));const pending=f.panel.refresh();await new Promise(r=>setImmediate(r));assert.doesNotMatch(f.panel.render(),/PRIVATE_TITLE/);f.panel.select('');release();await pending;assert.doesNotMatch(f.panel.render(),/PRIVATE_TITLE/);
});
test('missing capability disables execution; cancel hides content before awaiting server',async()=>{
 const f=fixture();f.disable();await f.panel.refresh();f.panel.select(selection.streamRef);await f.panel.run();assert.equal(f.calls.some(c=>c.path==='/missions'),false);
 const g=fixture();await g.panel.refresh();g.panel.select(selection.streamRef);await g.panel.run();await g.panel.cancel();assert.doesNotMatch(g.panel.render(),/PRIVATE_TITLE/);assert.equal(g.calls.at(-1).path,'/missions/one/cancel');
});
