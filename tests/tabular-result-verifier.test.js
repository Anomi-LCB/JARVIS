import test from 'node:test';import assert from 'node:assert/strict';
import {verifyTabularProcedureResult} from '../apps/verification/src/tabular-result-verifier.js';
const definition={groupAliases:['Team'],valueAliases:['Amount']};
const rows=[{Team:'A',Amount:3},{Team:'A',Amount:'2'},{Team:'B',Amount:7}];
const result={success:true,groupColumn:'Team',valueColumn:'Amount',resultRows:[{group:'A',count:2,total:5},{group:'B',count:1,total:7}]};
test('G independently checks source groups, counts and totals and rejects tampered results',()=>{
 assert.equal(verifyTabularProcedureResult({definition,rows,result}).status,'passed');
 for(const patch of [{resultRows:[{group:'A',count:2,total:6},result.resultRows[1]]},{resultRows:[result.resultRows[0]]},{resultRows:[result.resultRows[0],result.resultRows[0]]},{resultRows:[{group:'A',count:1,total:5},result.resultRows[1]]},{valueColumn:'Team'}])assert.equal(verifyTabularProcedureResult({definition,rows,result:{...result,...patch}}).status,'failed');
 assert.equal(verifyTabularProcedureResult({definition,rows:rows.map(row=>({...row,amount:99})),result}).status,'failed');
 assert.equal(verifyTabularProcedureResult({definition,rows:[{Team:'A',Amount:'0x10'}],result}).status,'failed');
});
