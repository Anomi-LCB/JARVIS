import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CoreFacade} from '../packages/core/src/core-facade.js';import {createCoreServer} from '../packages/core/src/main.mjs';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
test('actual Core financial analysis requires ADMIN and exposes supplied-record findings without granting transaction rights',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-financial-http-'));const core=new CoreFacade({workspaceRoot:root});
 const server=createCoreServer(core,{adminToken:'synthetic-admin',adminTokens:[{token:'reader',scopes:['read_diagnostics']}]});
 await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(async()=>{await new Promise(r=>server.close(r));core.cognition?.close();rmSync(root,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}/financial-records/reconcile`,body={transactions:[{id:'synthetic-charge',accountRef:'opaque',paymentRef:'reference',kind:'charge',amountMinor:10000,currency:'KRW',category:'자료',source:'synthetic-file'}],receipts:[],budgets:[{id:'limit',category:'자료',currency:'KRW',limitMinor:5000}]};
 const post=(token,value=body)=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal((await post('reader')).status,403);
 const response=await post('synthetic-admin');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();assert.equal(result.findings[0].status,'receipt-missing');assert.equal(result.summary[0].overBudget,true);assert.equal(result.executionAuthority,false);assert.equal(result.sourceAuthenticated,false);
 const failed=await post('synthetic-admin',{...body,transactions:[{...body.transactions[0],amountMinor:-1,source:'PRIVATE_INVALID_MARKER'}]});assert.equal(failed.status,400);assert.equal(JSON.stringify(await failed.json()).includes('PRIVATE_INVALID_MARKER'),false);
});
