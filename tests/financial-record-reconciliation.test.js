import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileFinancialRecords as reconcile} from '../packages/shared/src/financial-record-reconciliation.js';
const tx=(id,extra={})=>({id,accountRef:'opaque-account',paymentRef:id,kind:'charge',amountMinor:100,currency:'KRW',category:'자료',source:'synthetic-statement',...extra});
const receipt=(id,transaction,extra={})=>({id,accountRef:transaction.accountRef,paymentRef:transaction.paymentRef,kind:transaction.kind,amountMinor:transaction.amountMinor,currency:transaction.currency,source:'synthetic-receipt',...extra});
test('integer reconciliation keeps refunds, currencies, duplicate counts and budget arithmetic separate',()=>{
 const a=tx('a',{amountMinor:900}),refund=tx('r',{kind:'refund',amountMinor:200}),usd=tx('usd',{currency:'USD',amountMinor:20});
 const input={transactions:[a,a,refund,usd],receipts:[receipt('ra',a),receipt('ra',a),receipt('rr',refund),receipt('ru',usd)],budgets:[{id:'krw',category:'자료',currency:'KRW',limitMinor:600},{id:'usd',category:'자료',currency:'USD',limitMinor:25},{id:'unused',category:'교통',currency:'KRW',limitMinor:100}]};
 const frozen=JSON.stringify(input),result=reconcile(input);assert.equal(JSON.stringify(input),frozen);
 assert.equal(result.counts.matched,3);assert.equal(result.counts.duplicateTransactions,1);assert.equal(result.counts.duplicateReceipts,1);
 assert.deepEqual(result.summary.map(x=>[x.currency,x.netMinor,x.overBudget]),[['KRW',700,true],['USD',20,false],['KRW',0,false]]);
 assert.equal(result.executionAuthority,false);assert.equal(result.sourceAuthenticated,false);assert.equal(result.reviewRequired,true);
});
test('missing, ambiguous and mismatched receipts do not silently reconcile',()=>{
 const a=tx('a'),b=tx('b'),c=tx('c'),d=tx('d');
 const result=reconcile({transactions:[a,b,c,d],receipts:[receipt('rb',b,{amountMinor:101}),receipt('rc1',c),receipt('rc2',c),receipt('wrong-account',d,{accountRef:'other'})],budgets:[]});
 assert.deepEqual(result.findings.map(x=>x.status),['receipt-missing','amount-mismatch','ambiguous-reference','receipt-missing']);assert.equal(result.reviewRequired,true);
});
test('conflicting identities, unsafe amounts and total overflow are rejected without guessing',()=>{
 const a=tx('a');assert.throws(()=>reconcile({transactions:[a,{...a,amountMinor:101}],receipts:[],budgets:[]}),{code:'FINANCIAL_DUPLICATE_CONFLICT'});
 for(const amountMinor of [0.1,-1,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>reconcile({transactions:[tx('bad',{amountMinor})],receipts:[],budgets:[]}),{code:'FINANCIAL_RECORD_INVALID'});
 assert.throws(()=>reconcile({transactions:[tx('huge',{amountMinor:Number.MAX_SAFE_INTEGER}),tx('extra')],receipts:[],budgets:[]}),{code:'FINANCIAL_TOTAL_OVERFLOW'});
});
