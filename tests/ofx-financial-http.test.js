import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CoreFacade} from '../packages/core/src/core-facade.js';import {createCoreServer} from '../packages/core/src/main.mjs';import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
test('actual OFX HTTP import then source-bound classification and budget reconciliation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-ofx-http-'));const core=new CoreFacade({workspaceRoot:root});const server=createCoreServer(core,{adminToken:'admin',adminTokens:[{token:'reader',scopes:['read_diagnostics']}]});await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});t.after(async()=>{await new Promise(r=>server.close(r));core.cognition?.close();rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const xml='<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>KRW</CURDEF><BANKACCTFROM><BANKID>test</BANKID><ACCTID>A</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261001</DTPOSTED><TRNAMT>-700</TRNAMT><FITID>one</FITID></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
 const post=(path,body,token='admin')=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const input={xml,currencyExponents:{KRW:0}};
 assert.equal((await post('/financial-records/ofx/import',input,null)).status,401);assert.equal((await post('/financial-records/ofx/import',input,'reader')).status,403);
 const response=await post('/financial-records/ofx/import',input);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.status,200);const imported=await response.json();assert.equal(imported.records[0].signedAmountMinor,-700);
 const body={...input,classifications:[{transactionId:imported.records[0].id,sourceSha256:imported.sourceSha256,kind:'charge',category:'자료',paymentRef:'p'}],receipts:[],budgets:[{id:'b',category:'자료',currency:'KRW',limitMinor:600}]};
 const result=await post('/financial-records/ofx/reconcile',body);assert.equal(result.status,200);const report=await result.json();assert.equal(report.reconciliation.summary[0].netMinor,700);assert.equal(report.coverage.imported,1);assert.equal(report.executionAuthority,false);
 const failed=await post('/financial-records/ofx/reconcile',{...body,xml:'PRIVATE_INVALID_XML'});assert.equal(failed.status,400);assert.ok(!JSON.stringify(await failed.json()).includes('PRIVATE_INVALID_XML'));
 assert.equal((await post('/financial-records/ofx/import',{...input,extra:true})).status,400);
 const spec=await(await fetch(base+'/openapi.json')).json();assert.equal(spec.paths['/financial-records/ofx/import'].post.operationId,'importSuppliedOfxBankStatement');
});
