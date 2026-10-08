import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createBrowserGymClient} from '../scripts/benchmarks/browsergym-client.mjs';
const python=resolve('artifacts/external-benchmarks-20261008/venv311/Scripts/python.exe');
for(const invalid of [false,true])test('owned worker cleanup after '+(invalid?'protocol failure':'ignored close'),{skip:!existsSync(python)},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-browsergym-cleanup-')),worker=join(root,'worker.py');let client;
 try{
  const code=invalid?'import time\nprint("invalid protocol",flush=True)\ntime.sleep(60)\n':'import json,sys,time\nfor line in sys.stdin:\n m=json.loads(line)\n if m["op"]=="observe":print(json.dumps({"id":m["id"],"result":None}),flush=True)\ntime.sleep(60)\n';
  await writeFile(worker,code,{flag:'wx'});
  client=createBrowserGymClient({python,worker,miniwob:root,chrome:root,stateFile:join(root,'state.json'),browsersPath:root,shutdownTimeoutMs:100});
  if(invalid)await assert.rejects(client.call('observe'),/PROTOCOL_INVALID|UNAVAILABLE/);
  else assert.equal(await client.call('observe'),null);
  await client.close();
  assert.throws(()=>process.kill(client.pid,0),error=>error.code==='ESRCH');
 }finally{
  await client?.close();
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-browsergym-cleanup-'));
  await rm(root,{recursive:true,force:true});
 }
});
