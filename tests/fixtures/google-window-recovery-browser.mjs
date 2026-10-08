import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {GoogleInboxSync} from '../../packages/core/src/personal-operations/google-sync.js';
import {PersonalOperationsStore} from '../../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../../packages/core/src/personal-operations/source-inbox.js';
import {createCoreServer} from '../../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../../packages/shared/src/http.js';
const root=mkdtempSync(join(tmpdir(),'jarvis-recovery-browser-')),store=new PersonalOperationsStore({dbPath:join(root,'personal.sqlite')}),inbox=new PersonalSourceInbox(store);
let now=new Date('2026-10-08T00:00:00Z'),initial=true,providerCalls=0;
const client={configured:()=>true,account:async()=>{providerCalls++;return 'isolated@example.test';},page:async job=>{providerCalls++;return {items:job.provider==='gmail'?(initial?[{id:'retained',title:'기존 자료'}]:[{id:'retained',title:'기존 자료'},{id:'new',title:'새 자료'}]):[],nextCursor:initial&&job.provider==='gmail'?'pending-cursor':null};}};
const sync=new GoogleInboxSync({inbox,client,clock:()=>now,evidence:{window:(_provider,range)=>range,before:()=>null,failed:()=>{},status:()=>[]}});
await sync.run();const row=store.db.prepare('SELECT id,body FROM personal_google_jobs').all().find(x=>JSON.parse(x.body).provider==='gmail'),job=JSON.parse(row.body);
job.timeMin='2026-09-24T00:00:00.456Z';job.timeMax='2026-10-08T00:00:00.789Z';store.db.prepare('UPDATE personal_google_jobs SET body=? WHERE id=?').run(JSON.stringify(job),row.id);
initial=false;now=new Date('2026-10-08T00:01:00Z');
const core=createCoreServer(undefined,{adminToken:'isolated-ui-admin',googleSync:sync,personalInbox:inbox}),c=await listenOnFetchSafePort(core),base=`http://127.0.0.1:${c.port}`;
const page=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JARVIS 격리 복구 검증</title><style>body{background:#f6f9fb;color:#172b3a;font:17px system-ui;max-width:900px;margin:32px auto;padding:16px}section,details,article{background:white;padding:20px;border:1px solid #dce5eb;border-radius:12px;margin:12px 0}button{padding:12px 20px;background:#087f73;color:white;border:0;border-radius:8px;margin:8px;cursor:pointer}input{display:block;max-width:90%;margin:8px}label{display:block}p{line-height:1.6}</style><h1>Google 메일·일정 연결 · 격리 검증</h1><p>합성 계정과 로컬 SQLite를 사용합니다. 실제 Google 요청은 없습니다.</p><main id="app"></main><p id="proof"></p><script type="module">import {createGoogleSetup} from '/google-setup.js';const root=document.querySelector('#app'),escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function request(path,options={}){const r=await fetch('/api'+path,{method:options.method??'GET',headers:{'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});const v=await r.json();if(!r.ok)throw Object.assign(Error('request'),{payload:v});return v;}const component=createGoogleSetup({request,changed:()=>root.innerHTML=component.render(),refresh,escape,simple:true});async function refresh(){const google=await request('/personal-google/status');component.update({google,connection:{status:'connected',productAuthorizationConfigured:true,credentialLocation:'broker',providerVerified:true}});root.innerHTML=component.render();const proof=await(await fetch('/proof')).json();document.querySelector('#proof').textContent='보존 자료 '+proof.items+'건 · 복구 기록 '+proof.archives+'건 · 상태 '+google.status;}component.attach(root);await refresh();</script></html>`;
const ui=createServer(async(req,res)=>{try{
 if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');res.end(page.replace("const google=await request('/personal-google/status');","const {google}=await request('/personal-inbox');"));return;}
 if(req.url==='/google-setup.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync('src/ui/google-setup.js'));return;}
 if(req.url==='/proof'){res.setHeader('content-type','application/json');res.end(JSON.stringify({items:inbox.list().length,archives:store.db.prepare('SELECT COUNT(*) n FROM personal_google_window_recoveries').get().n,providerCalls,externalCalls:0}));return;}
 if(req.url.startsWith('/api/')){let data='';for await(const chunk of req)data+=chunk;const r=await fetch(base+req.url.slice(4),{method:req.method,headers:{authorization:'Bearer isolated-ui-admin','content-type':'application/json'},...(data?{body:data}:{})});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());return;}
 res.writeHead(404);res.end();
 }catch{res.writeHead(500);res.end();}});
const u=await listenOnFetchSafePort(ui);console.log(JSON.stringify({url:`http://127.0.0.1:${u.port}`,root}));
for await(const command of createInterface({input:process.stdin})){
 if(command==='proof'){console.log(JSON.stringify({items:inbox.list(),archives:store.db.prepare('SELECT COUNT(*) n FROM personal_google_window_recoveries').get().n,providerCalls,status:sync.status()}));continue;}
 if(command==='save'){writeFileSync('artifacts/google-window-recovery-20261008-browser.json',JSON.stringify({observedAt:new Date().toISOString(),items:inbox.list(),archives:store.db.prepare('SELECT COUNT(*) n FROM personal_google_window_recoveries').get().n,providerCalls,externalCalls:0,status:sync.status()},null,2),{flag:'wx',flush:true});continue;}break;
}
await new Promise(r=>ui.close(r));await new Promise(r=>core.close(r));store.close();
