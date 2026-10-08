import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreServer } from '../../packages/core/src/main.mjs';
import { CoreFacade } from '../../packages/core/src/core-facade.js';
import { CoreWorkerDaemon } from '../../packages/core/src/runtime/core-worker-daemon.js';
import { GrowthRuntime } from '../../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../../apps/growth-memory/src/db/sqlite-store.js';
const root = mkdtempSync(join(tmpdir(), 'jarvis-memory-status-browser-'));
const store = new SqliteMemoryStore({ dbPath: join(root, 'memory.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
const growth = new GrowthRuntime({ memoryStore: store, auditRoot: root });
store.queueMemoryEvent({ eventId: 'synthetic-private-event', taskId: 'synthetic-task', eventType: 'task.created',
  source: { module: 'CORE', memoryScope: { userId: 'synthetic-owner', workspaceRoot: root, conversationId: null } },
  payload: { rawText: 'SYNTHETIC_NOT_FOR_SCREEN' }, learningFlags: { canBeUsedForWorkflow: true }, trustBoundary: { userProvided: true } });
const daemon = new CoreWorkerDaemon({ worker: { growthRuntime: growth,
  queueStatus: () => ({ total: 0, persistence: { enabled: true }, leases: { persistence: { enabled: true }, activeLeaseCount: 0 } }),
  drain: async () => ({ processed: 0 }) }, intervalMs: 100 });
const core = createCoreServer(new CoreFacade({ memoryStore: growth, workspaceRoot: root }), { adminToken: 'synthetic-admin', workerDaemon: daemon });
await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
let failure = false, acknowledgeRetraction = false;
const originalSync = growth.synchronizeSourceRetractions.bind(growth);
const status = store.pendingMemoryStatus.bind(store);
store.pendingMemoryStatus = () => { if (failure) throw new Error('synthetic status unavailable'); return status(); };
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>격리 기억 상태 검사</title><style>body{font-family:Arial,sans-serif;background:#f7fafc;color:#152c40;margin:24px}main{max-width:850px;margin:auto}.panel{background:white;border:1px solid #cddce5;border-radius:14px;padding:20px}summary{cursor:pointer}summary span{display:block;color:#466575;margin-top:8px}p{overflow-wrap:anywhere;line-height:1.7}button{min-height:44px;padding:8px 14px}</style><main id="app"></main><script type="module">
import { createMemoryStatusPanel } from '/panel.js';
const app=document.querySelector('#app');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const panel=createMemoryStatusPanel({escape,canManage:()=>true,changed:()=>app.innerHTML=panel.render(),request:async(path)=>{const response=await fetch(path);if(!response.ok)throw new Error('unavailable');return response.json();}});
panel.attach(app);app.innerHTML=panel.render();await panel.refresh();
</script></html>`;
const outer = createServer(async (req,res) => {
  if (req.url === '/') { res.setHeader('content-type','text/html;charset=utf-8'); return res.end(html); }
  if (req.url === '/panel.js') { res.setHeader('content-type','text/javascript;charset=utf-8'); return res.end(readFileSync(new URL('../../src/ui/memory-status.js',import.meta.url))); }
  if (req.url === '/fixture/retraction-setup' && req.method === 'POST') {
    growth.ingest({eventId:'synthetic-retraction',taskId:'synthetic-task-retraction',eventType:'task.created',
      source:{module:'CORE',memoryScope:{userId:'synthetic-owner',workspaceRoot:root,conversationId:null}},
      payload:{rawText:'SYNTHETIC_RETRACTION_PRIVATE'},learningFlags:{canBeUsedForWorkflow:true},trustBoundary:{userProvided:true}});
    store.saveHygieneDecision({decisionId:'synthetic-delete',targetType:'memory_event',targetId:'synthetic-retraction',action:'delete',decidedAt:new Date().toISOString()});
    growth.setSourceRetractionHandler(()=>({revoked:acknowledgeRetraction}));return res.end('{}');
  }
  if (req.url === '/fixture/retraction-ack' && req.method === 'POST') { acknowledgeRetraction=true; return res.end('{}'); }
  if (req.url === '/fixture/retraction-fail' && req.method === 'POST') { growth.synchronizeSourceRetractions=()=>{throw new Error('SYNTHETIC_PRIVATE_ERROR');};return res.end('{}'); }
  if (req.url === '/fixture/retraction-recover' && req.method === 'POST') { growth.synchronizeSourceRetractions=originalSync;return res.end('{}'); }
  if (req.url === '/fixture/start'  && req.method === 'POST') { daemon.start(); return res.end('{}'); }
  if (req.url === '/fixture/fail' && req.method === 'POST') { failure=true; return res.end('{}'); }
  if (req.url === '/fixture/recover' && req.method === 'POST') { failure=false; return res.end('{}'); }
  if (req.url === '/memory/status') { const response=await fetch(`http://127.0.0.1:${core.address().port}/memory/status`,{headers:{authorization:'Bearer synthetic-admin'}});res.statusCode=response.status;res.setHeader('content-type','application/json');return res.end(await response.text()); }
  res.statusCode=404;res.end();
});
await new Promise(resolve=>outer.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:`http://127.0.0.1:${outer.address().port}/`}));
process.stdin.once('data', async()=>{daemon.stop();outer.closeAllConnections();core.closeAllConnections();await Promise.all([new Promise(r=>outer.close(r)),new Promise(r=>core.close(r))]);store.close();rmSync(root,{recursive:true,force:true});process.exit(0);});
