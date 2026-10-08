import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { createMemoryStatusPanel } from '../src/ui/memory-status.js';

test('actual admin status separates unconfigured, unobserved, pending, failed and checked withdrawal without dispatch', async t=>{
  const root=mkdtempSync(join(tmpdir(),'jarvis-retraction-status-'));
  const store=new SqliteMemoryStore({dbPath:join(root,'memory.sqlite'),reviewDir:join(root,'reviews'),backupDir:join(root,'backups')});
  const growth=new GrowthRuntime({memoryStore:store,auditRoot:root});let calls=0;
  const daemon={timer:{},lastSourceRetractionSync:null};
  const server=createCoreServer(new CoreFacade({memoryStore:growth,workspaceRoot:root}),{adminToken:'synthetic-admin',workerDaemon:daemon});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
  const call=async()=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/memory/status`,{headers:{authorization:'Bearer synthetic-admin'}});assert.equal(res.status,200);return res.json();};
  assert.equal((await call()).sourceRetractions.status,'not_configured');
  growth.sourceRetractionHandler=()=>{calls++;return {revoked:true};};
  assert.equal((await call()).sourceRetractions.status,'not_observed');
  daemon.lastSourceRetractionSync={at:'2026-10-03T00:00:00.000Z',success:true,projectionConfigured:true,pendingCount:3,deferredCount:1,preferenceUpdateFailedCount:0,
    deliveries:[{sourceEventId:'PRIVATE_SOURCE'}],rawText:'PRIVATE_PAYLOAD'};
  let value=await call();assert.equal(value.sourceRetractions.status,'retry_pending');assert.equal(value.sourceRetractions.pendingCount,3);
  assert.equal(JSON.stringify(value).includes('PRIVATE_'),false);
  daemon.lastSourceRetractionSync.pendingCount=0;daemon.lastSourceRetractionSync.deferredCount=0;daemon.lastSourceRetractionSync.preferenceUpdateFailedCount=1;
  assert.equal((await call()).sourceRetractions.status,'retry_pending');
  daemon.lastSourceRetractionSync.success=false;value=await call();assert.equal(value.sourceRetractions.status,'unavailable');assert.equal(value.sourceRetractions.pendingCount,null);
  daemon.lastSourceRetractionSync.success=true;daemon.lastSourceRetractionSync.preferenceUpdateFailedCount=0;
  assert.equal((await call()).sourceRetractions.status,'checked');
  growth.sourceRetractionHandler=null;assert.equal((await call()).sourceRetractions.status,'not_configured');assert.equal(calls,0);
});

test('panel uses plain withdrawal states, withholds malformed counts and never calls write paths',async()=>{
  let projection;const paths=[];
  const panel=createMemoryStatusPanel({canManage:()=>true,escape:v=>String(v).replaceAll('<','&lt;'),request:async path=>{paths.push(path);return {success:true,status:'ready',pending:{pendingCount:0,replayAttempts:0},worker:{},sourceRetractions:projection};}});
  const states={not_configured:'削',not_observed:'아직 확인하지',unavailable:'확인할 수 없습니다',retry_pending:'다시 처리할',checked:'대기는 없었습니다'};
  for(const status of Object.keys(states)){
    projection={status,pendingCount:status==='checked'?0:2,deferredCount:status==='checked'?0:1,preferenceUpdateFailedCount:0};await panel.refresh();
    const html=panel.render();assert.match(html,/삭제한 기억의 반영/);
    if(status==='not_configured')assert.match(html,/연결이 준비되지/);else assert.ok(html.includes(states[status]));
    assert.equal(html.includes('전달 대기: 2건'),status==='retry_pending');
  }
  projection={status:'checked',pendingCount:-1,deferredCount:0,preferenceUpdateFailedCount:0,observedAt:'<synthetic>'};await panel.refresh();
  assert.match(panel.render(),/상태가 아직 확인되지/);assert.doesNotMatch(panel.render(),/전달 대기:/);assert.doesNotMatch(panel.render(),/<synthetic>/);
  projection=undefined;await panel.refresh();assert.match(panel.render(),/상태가 아직 확인되지/);
  assert.ok(paths.every(path=>path==='/memory/status'));
});
