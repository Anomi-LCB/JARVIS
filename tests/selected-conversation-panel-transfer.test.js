import test from 'node:test';
import assert from 'node:assert/strict';
import {createSelectedConversationPanel} from '../src/ui/selected-conversations.js';
import {selectConversationDocument} from '../packages/shared/src/chatgpt-export-conversion.js';

function panelFixture(){
 const handlers={},requests=[];let completion;
 const host={addEventListener:(type,fn)=>handlers[type]=fn,querySelector:()=>({open:true})};
 const panel=createSelectedConversationPanel({escape:value=>String(value??''),request:async(path,options)=>{requests.push({path,...options});return {selectedMessages:1,documentHash:'a'.repeat(64),imported:1,replayed:0,withdrawn:0};},
  changed:()=>{if(!panel.render().includes('처리 중입니다.'))completion?.();}});
 panel.attach(host);
 const perform=async fn=>{const settled=new Promise(resolve=>completion=resolve);fn();await settled;completion=null;};
 const load=document=>perform(()=>handlers.change({target:{matches:s=>s==='[data-archive-file]',files:[{name:'test.json',size:100,arrayBuffer:async()=>new TextEncoder().encode(JSON.stringify(document)).buffer}]}}));
 const select=index=>handlers.change({target:{matches:s=>s==='[data-archive-select]',dataset:{archiveSelect:String(index)},checked:true,closest:()=>({open:true})}});
 const click=selector=>perform(()=>handlers.click({target:{closest:s=>s===selector?{}:null}}));
 return {panel,requests,load,select,click};
}
const document={format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:[
 {id:'chosen',messages:[{id:'m',speaker:'user',text:'SELECTED_ONLY',spokenAt:'2026-10-03T00:00:00Z'}]},
 {id:'other',messages:[{id:'other-message',speaker:'user',text:'UNSELECTED_PRIVATE_MARKER',spokenAt:'2026-10-03T00:00:00Z'}]}]};
test('actual panel events send only chosen legacy conversations and retain original byte provenance',async()=>{
 const f=panelFixture();await f.load(document);assert.equal(f.requests.length,0);f.select(0);
 await f.click('[data-archive-preview]');
 assert.equal(f.requests.length,1);
 assert.deepEqual(f.requests[0].body.document.conversations.map(c=>c.id),['chosen']);
 assert.equal(JSON.stringify(f.requests).includes('UNSELECTED_PRIVATE_MARKER'),false);
 assert.match(f.requests[0].body.sourceRef,/export-sha256:[a-f0-9]{64}$/u);
 await f.click('[data-archive-commit]');
 assert.deepEqual(f.requests[1].body.document.conversations.map(c=>c.id),['chosen']);
 assert.equal(f.requests[1].body.expectedDocumentHash,'a'.repeat(64));
 assert.equal(JSON.stringify(f.requests).includes('UNSELECTED_PRIVATE_MARKER'),false);
});
test('selection never hides validation-relevant fields or ambiguous identities',()=>{
 const extra={...document,unknownAuthority:'must-reject'};
 assert.equal(selectConversationDocument(extra,['chosen']).unknownAuthority,'must-reject');
 assert.equal(document.conversations.length,2);
 for(const selection of [[],['missing'],['chosen','chosen'],Array(21).fill('chosen')])assert.throws(()=>selectConversationDocument(document,selection));
 assert.throws(()=>selectConversationDocument({...document,conversations:[document.conversations[0],document.conversations[0]]},['chosen']));
});
