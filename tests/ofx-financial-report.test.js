import test from 'node:test';import assert from 'node:assert/strict';
import {importOfxBankStatement} from '../packages/shared/src/ofx-bank-statement-import.js';
import {buildOfxFinancialReport} from '../packages/shared/src/ofx-financial-report.js';
const xml='<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>synthetic</BANKID><ACCTID>A</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261001</DTPOSTED><TRNAMT>-10.00</TRNAMT><FITID>charge</FITID></STMTTRN><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261002</DTPOSTED><TRNAMT>2.00</TRNAMT><FITID>refund</FITID></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
const currencyExponents={USD:2},imported=importOfxBankStatement(xml,{currencyExponents});
const classifications=imported.records.map((r,i)=>({transactionId:r.id,sourceSha256:imported.sourceSha256,kind:i?'refund':'charge',category:'자료',paymentRef:i?'refund-proof':'purchase-proof'}));
const receipts=imported.records.map((r,i)=>({id:'r'+i,accountRef:r.accountRef,paymentRef:classifications[i].paymentRef,kind:classifications[i].kind,amountMinor:i?200:1000,currency:'USD',source:'synthetic-receipt'}));
const input={xml,currencyExponents,classifications,receipts,budgets:[{id:'b',category:'자료',currency:'USD',limitMinor:700}]};
test('source-bound OFX records reconcile receipts and budget through existing calculator',()=>{
 const before=structuredClone(input),r=buildOfxFinancialReport(input);assert.deepEqual(input,before);assert.equal(r.reconciliation.counts.matched,2);assert.equal(r.reconciliation.summary[0].netMinor,800);assert.equal(r.reconciliation.summary[0].overBudget,true);assert.match(r.reportMarkdown,/\| 자료 \| USD \| 1000 \| 200 \| 800 \| 700 \| 예 \|/);assert.equal(r.sourceAuthenticated,false);
});
test('missing, stale, duplicate, foreign and reversed classifications fail before report output',()=>{
 for(const classifications of [input.classifications.slice(1),[input.classifications[0],input.classifications[0]],[{...input.classifications[0],sourceSha256:'stale'},input.classifications[1]],[{...input.classifications[0],transactionId:'foreign'},input.classifications[1]],[{...input.classifications[0],kind:'refund'},input.classifications[1]]])assert.throws(()=>buildOfxFinancialReport({...input,classifications}));
});

test('other credits are preserved separately and never inflate receipt match counts',()=>{
 const choices=[input.classifications[0],{transactionId:input.classifications[1].transactionId,sourceSha256:imported.sourceSha256,kind:'other',reason:'급여 <tag>|입금'}];
 const result=buildOfxFinancialReport({...input,classifications:choices,receipts:[input.receipts[0]]});
 assert.equal(result.coverage.imported,2);assert.equal(result.coverage.reconciliation,1);assert.equal(result.coverage.other,1);assert.equal(result.reconciliation.counts.matched,1);assert.equal(result.reconciliation.summary[0].netMinor,1000);assert.equal(result.otherRecords[0].signedAmountMinor,200);assert.match(result.reportMarkdown,/기타 1건/);assert.ok(!result.reportMarkdown.includes('<tag>'));
 assert.throws(()=>buildOfxFinancialReport({...input,classifications:[choices[0],{...choices[1],reason:''}]}),{code:'FINANCIAL_CLASSIFICATION_INVALID'});
});
