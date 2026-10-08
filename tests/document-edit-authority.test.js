import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {writeFileSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentEditToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {ActionType} from '../packages/shared/src/types.js';
const mod=await import('../apps/pc-agent/node_modules/exceljs/excel.js');const ExcelJS=mod.default??mod;
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-document-edit-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'source.xlsx'),wb=new ExcelJS.Workbook();wb.addWorksheet('Data').getCell('A1').value='original';await wb.xlsx.writeFile(path);return {root,path,original:await readFile(path),adapter:new DocumentEditToolAdapter({allowedRoots:[root]}),args:{targetPath:path,sheet:'Data',edits:[{cell:'A1',value:'edited'}]}};}
test('Document edit checks current authority before modifying source or making backups',async t=>{const f=await fixture(t);const result=await f.adapter.execute(f.args,{}, {assertAccess(){throw Error('fixture-revoked');}});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);assert.deepEqual(await readdir(f.root),['source.xlsx']);});
test('Document edit honors signed path scope for source and backup',async t=>{const f=await fixture(t);const result=await f.adapter.execute(f.args,{capabilityToken:{scope:{allowedPaths:[join(f.root,'different.xlsx')]}}});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);});
test('Requested missing sheet does not silently edit the first sheet',async t=>{const f=await fixture(t);const result=await f.adapter.execute({...f.args,sheet:'Missing'});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);});
test('Missing find target prevents partial modification of other requested cells',async t=>{const f=await fixture(t);const result=await f.adapter.execute({...f.args,edits:[...f.args.edits,{findText:'not present',value:'replacement'}]});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);});
test('Source changed while authoring is preserved rather than overwritten',async t=>{
 const f=await fixture(t);const result=await f.adapter.execute(f.args,{}, {beforeArtifactWrite(){writeFileSync(f.path,'external changes');}});
 assert.equal(result.status,'failed');assert.equal(result.uncertain,false);assert.equal(await readFile(f.path,'utf8'),'external changes');
});
test('Cancelled edit never modifies the source',async t=>{const f=await fixture(t),controller=new AbortController();controller.abort();const result=await f.adapter.execute(f.args,{}, {signal:controller.signal});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);});
test('Revocation after backup creation preserves source and backup',async t=>{
 const f=await fixture(t);const result=await f.adapter.execute(f.args,{}, {assertAccess(){const dir=join(f.root,'.jarvis-backups');if(existsSync(dir)&&readdirSync(dir).length)throw Error('fixture-backup-revoked');}});
 assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);assert.deepEqual(await readFile(result.backupPath),f.original);
});
test('Successful edit creates original byte backup and verifies edited cell',async t=>{
 const f=await fixture(t),result=await f.adapter.execute(f.args,{taskId:'edit'});assert.equal(result.status,'success');assert.deepEqual(await readFile(result.backupPath),f.original);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(f.path);assert.equal(wb.getWorksheet('Data').getCell('A1').value,'edited');
 assert.equal(f.adapter.undoJournal.entries[0].editedFileSnapshot.sha256.length,64);
});
test('Earlier edit removing a later find target never publishes a partial result',async t=>{const f=await fixture(t);const result=await f.adapter.execute({...f.args,edits:[{cell:'A1',value:'different'},{findText:'original',value:'replacement'}]});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);});
async function editedRuntime(t){const f=await fixture(t);const runtime=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'audit'),env:{},workerDaemonEnabled:false});const adapter=runtime.pcAgent.registry.get('document.edit');const result=await adapter.execute(f.args,{taskId:'edit'});assert.equal(result.status,'success');return {...f,agent:runtime.pcAgent,result};}
test('Restore backup preserves user changes made after editing',async t=>{const f=await editedRuntime(t);await writeFile(f.path,'user changed');assert.equal((await f.agent.rollbackTask('edit')).success,false);assert.equal(await readFile(f.path,'utf8'),'user changed');});
test('Restore backup rejects tampered backup bytes',async t=>{const f=await editedRuntime(t),edited=await readFile(f.path);await writeFile(f.result.backupPath,'bad backup');assert.equal((await f.agent.rollbackTask('edit')).success,false);assert.deepEqual(await readFile(f.path),edited);});
test('Restore backup checks again after preview',async t=>{const f=await editedRuntime(t),preview=f.agent.rollbackPlan.bind(f.agent);f.agent.rollbackPlan=async id=>{const plan=await preview(id);await writeFile(f.path,'later change');return plan;};assert.equal((await f.agent.rollbackTask('edit')).success,false);assert.equal(await readFile(f.path,'utf8'),'later change');});
test('Revocation after source publication returns uncertain evidence',async t=>{const f=await fixture(t);const result=await f.adapter.execute(f.args,{}, {assertAccess(){if(!readFileSync(f.path).equals(f.original))throw Error('fixture-published-revoked');}});assert.equal(result.status,'failed');assert.equal(result.uncertain,true);assert.ok(result.outputPaths.includes(f.path));assert.deepEqual(await readFile(result.backupPath),f.original);});
test('Actual staged file cancellation preserves source and removes owned stage',async t=>{const f=await fixture(t),controller=new AbortController();let observed=false;const result=await f.adapter.execute(f.args,{}, {signal:controller.signal,assertAccess(){if(readdirSync(f.root).some(name=>name.startsWith('.jarvis-edit-'))){observed=true;controller.abort();}}});assert.ok(observed);assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.path),f.original);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.jarvis-edit-')),false);});
test('B packet execution observes actual signed capability revocation during edit',async t=>{
 const f=await fixture(t),runtime=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'audit'),env:{},workerDaemonEnabled:false});
 const action={actionType:ActionType.EDIT_DOCUMENT,toolName:'document.edit',skillId:'fixture.edit',arguments:f.args};
 const capabilityToken=runtime.policyRuntime.capabilities.issue({taskId:'task_edit',planId:'plan_edit',approvalId:'approval_edit',action,allowedPaths:[f.root]});
 runtime.pcAgent.registry.get('document.edit').loadExcelJS=async()=>{assert.equal(runtime.policyRuntime.capabilities.revoke({tokenId:capabilityToken.tokenId,reason:'fixture-current-revocation'}).success,true);return ExcelJS;};
 const result=await runtime.pcAgent.receiveExecutionPacket({packetId:'packet_edit',taskId:'task_edit',planId:'plan_edit',action,capabilityToken,requestedMode:'execute',userConfirmation:{confirmed:true,approvalId:'approval_edit'},approvalDecision:{approvalId:'approval_edit',decision:'approve'}});
 assert.notEqual(result.executionResult?.status,'success');assert.deepEqual(await readFile(f.path),f.original);
 assert.equal(existsSync(join(f.root,'.jarvis-backups')),false);
});
test('Mutation during undo recording cannot become successful edit evidence',async t=>{
 const f=await fixture(t),record=f.adapter.undoJournal.record.bind(f.adapter.undoJournal);
 f.adapter.undoJournal.record=action=>{const entry=record(action);writeFileSync(f.path,'foreign after publication');return entry;};
 const result=await f.adapter.execute(f.args,{taskId:'edit'});assert.equal(result.status,'failed');assert.equal(result.uncertain,true);assert.equal(await readFile(f.path,'utf8'),'foreign after publication');
});
