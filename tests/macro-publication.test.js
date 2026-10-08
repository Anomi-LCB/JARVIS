import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MacroStore } from '../packages/core/src/macro-store.js';
import { MacroSaveToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'jarvis-macro-publication-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MacroStore({path:join(root,'macros.json')});
  assert.equal(store.save('old','preserve original'),true);
  return {store,adapter:new MacroSaveToolAdapter({store}),args:{rawText:'파일 목록 확인을 일일목록으로 저장해줘'}};
}

test('prepared macro is serialized across a new actual process and whole store verified',async t=>{
  const f=await fixture(t),prepared=await f.adapter.preparePublication(f.args);
  const code="import {MacroStore} from './packages/core/src/macro-store.js';import {MacroSaveToolAdapter} from './apps/pc-agent/src/pc-agent-runtime.js';const [path,args,prepared]=process.argv.slice(1);const result=await new MacroSaveToolAdapter({store:new MacroStore({path})}).execute(JSON.parse(args),{},{macroPublication:JSON.parse(prepared)});console.log(JSON.stringify({pid:process.pid,result}));";
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,f.store.path,JSON.stringify(f.args),JSON.stringify(prepared)],{windowsHide:true,timeout:10000});
  const {pid,result}=JSON.parse(stdout);
  assert.notEqual(pid,process.pid);assert.equal(result.status,'success');
  assert.deepEqual(result.macroPublication,prepared);
  assert.equal(result.macroObservation.sha256,prepared.expectedSha256);
  assert.equal(f.store.inspectPublication(prepared).record.createdAt,prepared.record.createdAt);
  assert.equal(new MacroStore({path:f.store.path}).resolveRun('old').command,'preserve original');
});

test('another saved command after preparation blocks original publication without losing it',async t=>{
  const f=await fixture(t),prepared=await f.adapter.preparePublication(f.args);
  assert.equal(f.store.save('other','new intervening command'),true);
  const before=await readFile(f.store.path);
  const result=await f.adapter.execute(f.args,{},{macroPublication:prepared});
  assert.equal(result.status,'failed');assert.equal(result.uncertain,false);
  assert.deepEqual(await readFile(f.store.path),before);
});

test('changed name, command, path, digest and raw request cannot publish the prepared store',async t=>{
  const f=await fixture(t),prepared=await f.adapter.preparePublication(f.args),before=await readFile(f.store.path);
  const changes=[p=>p.record.command='altered',p=>p.record.name='altered',p=>p.path+='x',p=>p.expectedSha256='0'.repeat(64),p=>p.rawText+=' 그리고 메일 발송',p=>p.expectedSize++];
  for(const change of changes){const p=structuredClone(prepared);change(p);const result=await f.adapter.execute(f.args,{},{macroPublication:p});assert.notEqual(result.status,'success');assert.deepEqual(await readFile(f.store.path),before);}
});

test('current observation refuses whole-store tampering even when saved macro survives',async t=>{
  const f=await fixture(t),prepared=await f.adapter.preparePublication(f.args);
  assert.equal((await f.adapter.execute(f.args,{},{macroPublication:prepared})).status,'success');
  const changed=JSON.parse(await readFile(f.store.path,'utf8'));delete changed.old;
  await writeFile(f.store.path,JSON.stringify(changed,null,2));
  assert.throws(()=>f.store.inspectPublication(prepared),/MACRO_PUBLICATION_UNVERIFIED/);
});

test('postpublication observation failure remains uncertain and retains actual published file',async t=>{
  const f=await fixture(t),prepared=await f.adapter.preparePublication(f.args);
  f.store.inspectPublication=()=>{throw Error('fixture-unavailable');};
  const result=await f.adapter.execute(f.args,{},{macroPublication:prepared});
  assert.equal(result.status,'failed');assert.equal(result.uncertain,true);
  assert.deepEqual(result.outputPaths,[f.store.path]);
  assert.equal(new MacroStore({path:f.store.path}).resolveRun(prepared.record.name).command,prepared.record.command);
});

test('prepared publication checks final current authority and abort while retaining original bytes',async t=>{
  const f=await fixture(t),prepared=await f.adapter.preparePublication(f.args),before=await readFile(f.store.path);let checks=0;
  const result=await f.adapter.execute(f.args,{},{macroPublication:prepared,assertAccess(){if(++checks===4)throw Error('revoked');}});
  assert.equal(result.status,'failed');assert.equal(result.uncertain,false);assert.deepEqual(await readFile(f.store.path),before);
  const controller=new AbortController();controller.abort();
  assert.equal((await f.adapter.execute(f.args,{},{macroPublication:prepared,signal:controller.signal})).status,'blocked');
});

test('preparation does not silently replace a corrupt existing macro store',async t=>{
  const f=await fixture(t);await writeFile(f.store.path,'{corrupt');
  await assert.rejects(f.adapter.preparePublication(f.args));
  assert.equal(await readFile(f.store.path,'utf8'),'{corrupt');
});

test('ordinary adapter execution prepares and rereads current whole-store publication evidence',async t=>{
  const f=await fixture(t),result=await f.adapter.execute(f.args);
  assert.equal(result.status,'success');
  assert.equal(result.macroPublication.rawText,f.args.rawText);
  assert.equal(result.macroObservation.sha256,result.macroPublication.expectedSha256);
  assert.deepEqual(f.store.inspectPublication(result.macroPublication),result.macroObservation);
});

test('invalid UTF-8 in an existing command is never silently replaced during publication',async t=>{
  const f=await fixture(t),bytes=Buffer.concat([Buffer.from('{"old":{"name":"old","command":"'),Buffer.from([0xff]),Buffer.from('"}}')]);
  await writeFile(f.store.path,bytes);
  await assert.rejects(f.adapter.preparePublication(f.args));
  const result=await f.adapter.execute(f.args);
  assert.equal(result.status,'failed');assert.equal(result.uncertain,false);
  assert.deepEqual(await readFile(f.store.path),bytes);
});
