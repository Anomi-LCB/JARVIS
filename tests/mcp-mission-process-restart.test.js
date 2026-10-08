import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const execute=promisify(execFile);
test('fresh processes recover MCP proof without tasks or replay; stale/missing proof stays unverified',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-mcp-process-'));
 let calls=0;
 const tool={name:'sum',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}};
 const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const rpc=JSON.parse(raw);const result=rpc.method==='tools/list'?{tools:[tool]}:(calls++,{content:[{type:'text',text:'answer'}],structuredContent:{answer:5}});res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
 const address=await listenOnFetchSafePort(server),endpoint=`http://127.0.0.1:${address.port}/mcp`;
 const run=async phase=>{const {stdout}=await execute(process.execPath,[fileURLToPath(new URL('./fixtures/mcp-mission-process-child.mjs',import.meta.url)),root,endpoint,phase],{windowsHide:true,timeout:20000});return JSON.parse(stdout.trim().split('\n').at(-1));};
 const first=await run('execute');assert.equal(first.status,'COMPLETED');assert.equal(calls,1);
 const restored=await run('verify');assert.notEqual(first.pid,restored.pid);assert.equal(restored.taskAbsent,true);assert.equal(restored.memoryAbsent,true);assert.equal(restored.passed,true);assert.equal(restored.installation.status,'installed');assert.equal(calls,1);
 for(const phase of ['no-package','changed-catalog','tampered-snapshot','missing-snapshot','changed-contract']){
  const result=await run(phase);assert.equal(result.passed,false,phase);assert.equal(calls,1,phase);
 }
 console.log(JSON.stringify({processRestart:first.pid!==restored.pid,providerCalls:calls,recovered:restored.passed,rejectedCases:5}));
});
