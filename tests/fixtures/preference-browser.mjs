import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreServer } from '../../packages/core/src/main.mjs';
import { CoreFacade } from '../../packages/core/src/core-facade.js';
import { GrowthRuntime } from '../../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
const root = mkdtempSync(join(tmpdir(), 'jarvis-preference-browser-'));
const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
const growth = new GrowthRuntime({ memoryStore: store, auditRoot: root });
const scope = { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null };
for (let i=1;i<=3;i++) growth.ingestor.ingest({ eventId: `evt-${i}`, taskId: `task-${i}`, eventType: 'approval.edited', source: { module: 'CORE', memoryScope: scope }, payload: { editRequest: '회의자료를 표로 정리해줘' }, learningFlags: { canBeUsedForPreference: true }, trustBoundary: { userProvided: true } });
const candidate = growth.query('회의자료', { scope }).find(item=>item.hypothesisId);
const confirmed = growth.decidePreference({ hypothesisId: candidate.hypothesisId });
const id = confirmed.item.preferenceId;
const backup = store.backup({ backupId: 'browser-baseline' });
const savePreference = store.saveConfirmedPreference.bind(store);
let restoreBeforeSave = false;
store.saveConfirmedPreference = (item, options) => {
  if (restoreBeforeSave) { restoreBeforeSave = false; store.restore({ backupPath: backup.filePath }); }
  return savePreference(item, options);
};
const core = createCoreServer(new CoreFacade({ memoryStore: growth, workspaceRoot: root }), { adminToken: 'synthetic-browser-admin' });
await new Promise(r=>core.listen(0,'127.0.0.1',r));
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>격리 기억 정정 시험</title><style>body{font-family:Arial,sans-serif;background:#f7fafc;color:#152c40;margin:24px}main{max-width:850px;margin:auto}.panel{background:white;border:1px solid #cddce5;border-radius:14px;padding:20px}summary{cursor:pointer}summary span{display:block;color:#466575;margin-top:8px}.personal-inbox-item{border:1px solid #d2dce3;border-radius:12px;padding:16px;margin:12px 0;overflow-wrap:anywhere}textarea{display:block;width:100%;box-sizing:border-box;min-height:100px;font:inherit}button{min-height:44px;margin:8px 8px 8px 0;padding:8px 14px}button:disabled{opacity:.6}</style><main id="app"></main><script type="module">
import { createPreferenceManagementPanel } from '/panel.js';
const app=document.querySelector('#app');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const panel=createPreferenceManagementPanel({escape,canManage:()=>true,changed:()=>app.innerHTML=panel.render(),request:async(path,options={})=>{const response=await fetch(path,{method:options.method??'GET',headers:{'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});const payload=await response.json();if(!response.ok)throw {payload};return payload;}});
panel.attach(app);app.innerHTML=panel.render();await panel.refresh();
</script></html>`;
const outer = createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(html);}
  if(req.url==='/panel.js'){res.setHeader('content-type','text/javascript;charset=utf-8');return res.end(readFileSync(new URL('../../src/ui/preference-management.js',import.meta.url)));}
  if(req.url==='/fixture/restore-race'&&req.method==='POST'){restoreBeforeSave=true;return res.end('{}');}
  if(req.url==='/fixture/restore-now'&&req.method==='POST'){store.restore({backupPath:backup.filePath});return res.end('{}');}
  if(req.url==='/fixture/change'&&req.method==='POST'){const item=store.getConfirmedPreference(id);growth.updatePreference(id,{expectedRevision:item.revision,patch:{statement:'다른 창에서 먼저 정정한 합성 선호'}});return res.end('{}');}
  if(req.url==='/fixture/retract'&&req.method==='POST'){growth.decideHygiene({targetId:'evt-1',action:'delete'});return res.end('{}');}
  if(req.url.startsWith('/memory/preferences')){let body='';for await(const chunk of req)body+=chunk;const response=await fetch(`http://127.0.0.1:${core.address().port}${req.url}`,{method:req.method,headers:{authorization:'Bearer synthetic-browser-admin','content-type':'application/json'},...(['GET','HEAD'].includes(req.method)?{}:{body})});res.statusCode=response.status;res.setHeader('content-type','application/json');return res.end(await response.text());}
  res.statusCode=404;res.end();
});
await new Promise(r=>outer.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({url:`http://127.0.0.1:${outer.address().port}/`}));
async function close(){outer.closeAllConnections();core.closeAllConnections();await Promise.all([new Promise(r=>outer.close(r)),new Promise(r=>core.close(r))]);store.close();rmSync(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
process.stdin.resume(); process.stdin.on('data', () => close());
