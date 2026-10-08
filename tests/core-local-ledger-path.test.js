import test from 'node:test';
import assert from 'node:assert/strict';
import {coreServiceRuntimeOptionsFromEnv} from '../scripts/core-service-runtime.mjs';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {assertLedgerPathSyntax,assertLocalLedgerStorage,localLedgerVolumeAllowed} from '../packages/core/src/runtime/local-ledger-storage.js';
import {mkdtemp,mkdir,rm,symlink,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
for(const key of ['JARVIS_CORE_ROOT','JARVIS_PERSONAL_OPERATIONS_DB','JARVIS_CORE_GROWTH_DB','JARVIS_CORE_COGNITION_DB','JARVIS_CORE_MISSION_STORE'])
 for(const path of ['\\\\server.invalid\\share\\ledger.sqlite','//server.invalid/share/ledger.sqlite','file://server.invalid/share/ledger.sqlite'])
  test('Core rejects shared ledger config before filesystem access '+key+' '+path,()=>{
   assert.throws(()=>coreServiceRuntimeOptionsFromEnv({env:{JARVIS_TEST_MODE:'1',[key]:path}}),{code:'A_CORE_LEDGER_LOCAL_STORAGE_REQUIRED'});
  });
test('filesystem classifiers reject remote, unknown and shared cluster volumes',()=>{
 for(const driveType of [0,1,4,5])assert.equal(localLedgerVolumeAllowed('win32',{driveType,format:'NTFS'}),false);
 for(const format of ['CsvFS','SMB','CIFS','NFS'])assert.equal(localLedgerVolumeAllowed('win32',{driveType:3,format}),false);
 assert.equal(localLedgerVolumeAllowed('win32',{driveType:3,format:'NTFS'}),true);
 for(const type of [0,0x6969,0xff534d42,0x517b])assert.equal(localLedgerVolumeAllowed('linux',{type}),false);
 for(const type of [0xef53,0x794c7630,0x01021994])assert.equal(localLedgerVolumeAllowed('linux',{type}),true);
 assert.equal(localLedgerVolumeAllowed('darwin',{type:0xef53}),false);
 for(const path of ['\\\\?\\UNC\\server\\share\\db','\\\\.\\pipe\\db','https://host/db','file:db','x\u0000y'])assert.throws(()=>assertLedgerPathSyntax(path),{code:'A_CORE_LEDGER_LOCAL_STORAGE_REQUIRED'});
});
test('actual local disk, alias and Core SQLite reopen preserve the central ledger',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ledger-local-')),runtimes=[];
 t.after(async()=>{for(const runtime of runtimes)await runtime.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const physical=join(root,'physical');await mkdir(physical);const alias=join(root,'alias');await symlink(physical,alias,process.platform==='win32'?'junction':'dir');
 const proof=assertLocalLedgerStorage([join(alias,'new','operations.sqlite')]);assert.equal(proof.localVolumeObserved,true);assert.equal(proof.exclusiveHostOwnershipVerified,false);
 const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_TEST_AUDIT_ROOT:join(root,'audit'),JARVIS_PERSONAL_OPERATIONS_DB:join(alias,'ops.sqlite'),
  JARVIS_CORE_MISSION_STORE_BACKEND:'sqlite',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0'};
 const first=await createConfiguredCoreServiceRuntime({env});runtimes.push(first);assert.equal(first.ledgerStorageObservation.checkedPaths,6);
 const mission=first.missionRuntime.createMission({objective:'로컬 원장 보존 시험',successCriteria:['자료 보존'],authorization:{mode:'supervised'}});await first.close();
 const second=await createConfiguredCoreServiceRuntime({env});runtimes.push(second);assert.equal(second.missionRuntime.getMission(mission.missionId).objective,'로컬 원장 보존 시험');
 assert.ok((await readFile(join(physical,'ops.sqlite'))).length>0);
 console.log(JSON.stringify({actualLocalLedgerStorage:{platform:process.platform,proof:second.ledgerStorageObservation,actualSqliteReopen:true,actualLocalAlias:true,networkMountTested:false}}));
});
test('bad network syntax fails before constructing an actual service or local files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-ledger-block-'));t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 await assert.rejects(createConfiguredCoreServiceRuntime({env:{JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_PERSONAL_OPERATIONS_DB:'\\\\server.invalid\\share\\db.sqlite'}}),{code:'A_CORE_LEDGER_LOCAL_STORAGE_REQUIRED'});
 assert.deepEqual(await readdir(root),[]);
});
