import test from 'node:test';import assert from 'node:assert/strict';
import {parseFinancialDecimalMinor as parse,financialScopedTransactionId as id} from '../packages/shared/src/financial-import-primitives.js';
test('decimal import preserves signed integer units without floating point or rounding',()=>{
 assert.equal(parse('0.29',2),29);assert.equal(parse('-1234.56',2),-123456);assert.equal(parse('700.00',0),700);assert.equal(parse('1.2300',2),123);assert.equal(parse('90071992547409.91',2),Number.MAX_SAFE_INTEGER);
 for(const value of ['1.001','-0.009'])assert.throws(()=>parse(value,2),{code:'FINANCIAL_PRECISION_LOSS'});
 for(const value of ['1e2',' 1','1,000','NaN','Infinity','1.','+1'])assert.throws(()=>parse(value,2),{code:'FINANCIAL_DECIMAL_INVALID'});
 assert.throws(()=>parse('90071992547409.92',2),{code:'FINANCIAL_TOTAL_OVERFLOW'});assert.throws(()=>parse('1',-1),{code:'FINANCIAL_DECIMAL_INVALID'});
});
test('equal OFX FITIDs in different institution/account scopes never alias',()=>{
 const a={institutionId:'synthetic-bank',accountId:'account-A',transactionId:'same-fitid'};
 assert.equal(id(a),id({...a}));assert.notEqual(id(a),id({...a,accountId:'account-B'}));assert.notEqual(id(a),id({...a,institutionId:'other-bank'}));assert.ok(!id(a).includes('account-A'));
 assert.throws(()=>id({...a,transactionId:'line\nbreak'}),{code:'FINANCIAL_SOURCE_ID_INVALID'});
});
