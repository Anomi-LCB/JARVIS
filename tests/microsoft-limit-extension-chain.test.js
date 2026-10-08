import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {MicrosoftCollectionTaskReceipts} from '../packages/core/src/mission/microsoft-collection-task-receipts.js';
for(const attack of ['none','reorder','prior-hash','goal-change'])test('signed page-limit amendment chain '+attack,()=>{
 const db=new DatabaseSync(':memory:'),sign=body=>createHmac('sha256','synthetic-test-key').update(body).digest('hex');
 try{
  const receipts=new MicrosoftCollectionTaskReceipts({store:{db},signer:{keyId:'synthetic',sign,verify:(body,signature)=>sign(body)===signature},readOperationReceipt(){throw Error('NOT_USED');},authorizeArchive:()=>false});
  const m={missionId:'synthetic',objective:'full metadata',constraints:[],goalContract:{revision:1},microsoftCollection:{maxPages:1},authorizationRevision:1,authorization:{ownerSessionId:'synthetic'},executionMandateId:null};
  const add=(expectedMaxPages,maxPages)=>{const row=receipts.signLimitExtension(m,{extensionId:'ms_limit_'+maxPages,expectedMaxPages,maxPages,observedAt:'2026-10-08T00:00:00.000Z'});(m.microsoftCollectionLimitExtensions??=[]).push(row);};
  add(1,2);add(2,3);assert.equal(receipts.effectiveLimit(m),3);
  if(attack==='reorder')m.microsoftCollectionLimitExtensions.reverse();
  if(attack==='prior-hash'){const row=m.microsoftCollectionLimitExtensions[1],data=JSON.parse(row.body);data.previous='foreign';row.body=JSON.stringify(data);row.signature=sign(row.body);}
  if(attack==='goal-change')m.authorization.ownerSessionId='foreign';
  if(attack!=='none')assert.throws(()=>receipts.effectiveLimit(m),/A_MICROSOFT_LIMIT_PROOF_INVALID/);
 }finally{db.close();}
});
