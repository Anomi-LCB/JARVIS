import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {createCoreServer} from '../packages/core/src/main.mjs';

test('lost creation response resolves exact durable request over HTTP, beyond the recent list and after restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-workspace-reconcile-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const options={allowedRoots:[root],auditRoot:join(root,'audit'),cwd:()=>root,env:{},workerDaemonEnabled:false};
 const runtime=createAgRuntime(options);const key='workspace_original';
 const created=runtime.missionRuntime.createMission({objective:'격리 폴더 점검',successCriteria:['파일 목록 관측'],idempotencyKey:key});
 for(let n=0;n<52;n++)runtime.missionRuntime.createMission({objective:`별도 평가 작업 ${n}`,successCriteria:['실제 관측']});
 const restored=createAgRuntime(options);
 assert.equal(restored.missionRuntime.findMissionByRequestId(key).missionId,created.missionId);
 const server=createCoreServer(restored.coreFacade,{adminToken:'synthetic-admin',missionRuntime:restored.missionRuntime});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/missions`,headers={authorization:'Bearer synthetic-admin'};
 assert.equal((await fetch(url+'?requestId='+key)).status,401);
 const result=await (await fetch(url+'?requestId='+key,{headers})).json();assert.equal(result.items.length,1);assert.equal(result.items[0].missionId,created.missionId);
 assert.equal((await fetch(url+'?requestId=bad%20key',{headers})).status,400);
 assert.deepEqual((await (await fetch(url+'?requestId=not_found',{headers})).json()).items,[]);
 assert.equal(restored.missionRuntime.createMission({objective:'격리 폴더 점검',successCriteria:['파일 목록 관측'],idempotencyKey:key}).missionId,created.missionId);
});
