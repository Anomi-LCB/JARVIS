import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {CoreFacade} from '../../packages/core/src/core-facade.js';
import {GrowthRuntime} from '../../apps/growth-memory/src/growth-runtime.js';
import {SqliteMemoryStore} from '../../apps/growth-memory/src/db/sqlite-store.js';
const root=mkdtempSync(join(tmpdir(),'jarvis-export-ui-'));
if(process.env.JARVIS_TEST_MODE==='1')process.env.JARVIS_TEST_AUDIT_ROOT=root;
const store=new SqliteMemoryStore({dbPath:join(root,'archive.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});
const core=createCoreServer(new CoreFacade({memoryStore:growth,workspaceRoot:root}),{adminToken:'synthetic-admin'});
await new Promise(resolve=>core.listen(0,'127.0.0.1',resolve));
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>대화 가져오기 격리 검사</title>
<style>body{background:#f7fafc;color:#152c40;font-family:Arial,sans-serif;margin:24px}main{max-width:850px;margin:auto}.panel{background:white;border:1px solid #cddce5;border-radius:14px;padding:20px}summary{cursor:pointer}summary span{display:block}p{line-height:1.7;overflow-wrap:anywhere}button{min-height:44px;padding:8px 14px;margin:8px}label{display:block;margin:12px}.personal-inbox-grid{display:grid;gap:12px}</style>
<button id="fixture-file">합성 내보내기 파일 선택</button><button id="fixture-media">지원하지 않는 이미지 사례</button><button id="fixture-legacy">기존 형식 파일 선택</button><main id="app"></main>
<script type="module">import {createSelectedConversationPanel} from '/src/ui/selected-conversations.js';
const root=document.querySelector('#app'),escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const panel=createSelectedConversationPanel({escape,changed:()=>{root.innerHTML=panel.render()},request:async(path,options)=>{const r=await fetch(path,{method:options.method,headers:{'content-type':'application/json'},body:JSON.stringify(options.body)}),data=await r.json();if(!r.ok)throw {code:data.error?.code};return data;}});
root.innerHTML=panel.render();panel.attach(root);
function fixture(media=false,legacy=false){const message={id:'m1',author:{role:'user'},create_time:1790985600,content:{content_type:'text',parts:media?[{image:'unsupported'}]:['선택한 합성 연구 원문']}};
 const data=[{id:'chosen',title:'연구 자료',current_node:'m1',mapping:{m1:{id:'m1',parent:null,message}}},{id:'other',title:'가져오지 않을 대화',current_node:'m2',mapping:{m2:{id:'m2',parent:null,message:{...message,id:'m2',content:{content_type:'text',parts:['UNSELECTED_SYNTHETIC_PRIVATE']}}}}}];
 const documentValue=legacy?{format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations:data.map(c=>({id:c.id,messages:[{id:c.current_node,speaker:'user',text:c.mapping[c.current_node].message.content.parts[0],spokenAt:'2026-10-03T00:00:00Z'}]}))}:data;
 const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(documentValue)],'conversations.json',{type:'application/json'}));const input=document.querySelector('[data-archive-file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
document.querySelector('#fixture-file').onclick=()=>fixture();document.querySelector('#fixture-media').onclick=()=>fixture(true);document.querySelector('#fixture-legacy').onclick=()=>fixture(false,true);
</script></html>`;
let requestCount=0,unselectedSent=false;
const outer=createServer(async(req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(html);}
 const files={'/src/ui/selected-conversations.js':'../../src/ui/selected-conversations.js','/packages/shared/src/chatgpt-export-conversion.js':'../../packages/shared/src/chatgpt-export-conversion.js','/packages/shared/src/chatgpt-export-file.js':'../../packages/shared/src/chatgpt-export-file.js'};
 if(files[req.url]){res.setHeader('content-type','text/javascript');return res.end(readFileSync(new URL(files[req.url],import.meta.url)));}
 if(req.url==='/check'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({requestCount,unselectedSent,stored:store.db.prepare('SELECT COUNT(*) AS n FROM selected_conversation_messages WHERE withdrawn=0').get().n}));}
 if(req.url.startsWith('/memory/selected-conversations/')){const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();requestCount++;unselectedSent ||=body.includes('UNSELECTED_SYNTHETIC_PRIVATE');
  const reply=await fetch('http://127.0.0.1:'+core.address().port+req.url,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body});res.statusCode=reply.status;res.setHeader('content-type','application/json');return res.end(await reply.text());}
 res.statusCode=404;res.end();
});
await new Promise(resolve=>outer.listen(0,'127.0.0.1',resolve));console.log(JSON.stringify({url:'http://127.0.0.1:'+outer.address().port+'/'}));
process.stdin.once('data',async()=>{outer.closeAllConnections();core.closeAllConnections();await Promise.all([new Promise(r=>outer.close(r)),new Promise(r=>core.close(r))]);store.close();rmSync(root,{recursive:true,force:true});process.exit(0);});
