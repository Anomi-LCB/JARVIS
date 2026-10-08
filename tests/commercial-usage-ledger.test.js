import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHmac} from 'node:crypto';
import {CommercialUsageLedger,verifyPaddleSignature} from '../packages/core/src/commercial/usage-ledger.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const secret='synthetic-webhook-secret-123',now=1900000000000;
const signature=raw=>`ts=${now/1000};h1=${createHmac('sha256',secret).update(`${now/1000}:`).update(raw).digest('hex')}`;
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=new CommercialUsageLedger({db,webhookSecret:secret,clock:()=>now});ledger.registerCheckout({transactionId:'txn_test',accountId:'owner',priceId:'pri_test',currency:'KRW',credits:100,expiresAt:now+100000});return {ledger,db};}
const event=(id='evt_1')=>Buffer.from(JSON.stringify({event_id:id,event_type:'transaction.completed',data:{id:'txn_test',status:'completed',currency_code:'KRW',items:[{price:{id:'pri_test'},quantity:1}]}}));
test('signature verifies exact bytes with clock tolerance and refuses transformed or stale bodies',()=>{const raw=event();verifyPaddleSignature(raw,signature(raw),secret,now);assert.throws(()=>verifyPaddleSignature(Buffer.from(raw+' '),signature(raw),secret,now));assert.throws(()=>verifyPaddleSignature(raw,signature(raw),secret,now+6000));});
test('same purchase across duplicate notifications grants credits only once',t=>{const {ledger}=fixture(t),raw=event();ledger.webhook(raw,signature(raw));assert.equal(ledger.webhook(raw,signature(raw)).replayed,true);const another=event('evt_2');ledger.webhook(another,signature(another));assert.equal(ledger.summary('owner').included,100);assert.equal(ledger.summary('other').included,0);});
test('price, currency and unbound transactions never activate an entitlement',t=>{const {ledger}=fixture(t);for(const change of [p=>p.data.currency_code='USD',p=>p.data.items[0].price.id='pri_forged',p=>p.data.id='txn_other']){const p=JSON.parse(event());change(p);const raw=Buffer.from(JSON.stringify(p));assert.throws(()=>ledger.webhook(raw,signature(raw)));}assert.equal(ledger.summary('owner').included,0);});
test('idempotent reservations preserve tenant and hash boundaries and never allow overage',t=>{const {ledger}=fixture(t),raw=event();ledger.webhook(raw,signature(raw));const input={accountId:'owner',requestId:'r1',requestHash:'a'.repeat(64),maxCredits:70};ledger.reserve(input);assert.equal(ledger.reserve(input).replayed,true);assert.throws(()=>ledger.reserve({...input,accountId:'other'}));assert.throws(()=>ledger.reserve({...input,requestId:'r2',maxCredits:40}));assert.equal(ledger.summary('owner').remaining,30);});
test('dispatch is once-only; lost outcomes hold usage and actual zero cannot be guessed',t=>{const {ledger}=fixture(t),raw=event();ledger.webhook(raw,signature(raw));ledger.reserve({accountId:'owner',requestId:'r1',requestHash:'b'.repeat(64),maxCredits:60});assert.equal(ledger.transition('owner','r1',{operation:'begin'}).dispatchAllowed,true);assert.equal(ledger.transition('owner','r1',{operation:'begin'}).dispatchAllowed,false);assert.equal(ledger.transition('owner','r1',{operation:'cancel'}).status,'uncertain');assert.equal(ledger.summary('owner').remaining,40);assert.throws(()=>ledger.transition('owner','r1',{operation:'settle'}));ledger.transition('owner','r1',{operation:'settle',actualCredits:20});assert.equal(ledger.summary('owner').remaining,80);assert.throws(()=>ledger.transition('owner','r1',{operation:'settle',actualCredits:21}));});
test('cancellation before dispatch releases only the reserved allocation',t=>{const {ledger}=fixture(t),raw=event();ledger.webhook(raw,signature(raw));ledger.reserve({accountId:'owner',requestId:'r1',requestHash:'c'.repeat(64),maxCredits:60});ledger.transition('owner','r1',{operation:'cancel'});assert.equal(ledger.summary('owner').remaining,100);assert.throws(()=>ledger.transition('other','r1',{operation:'begin'}));});

test('persistent reopen keeps uncertain dispatch and prevents a second grant or dispatch',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-usage-test-')),path=join(root,'usage.sqlite');let db=new DatabaseSync(path);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 let ledger=new CommercialUsageLedger({db,webhookSecret:secret,clock:()=>now});
 ledger.registerCheckout({transactionId:'txn_test',accountId:'owner',priceId:'pri_test',currency:'KRW',credits:100,expiresAt:now+100000});
 const raw=event();ledger.webhook(raw,signature(raw));ledger.reserve({accountId:'owner',requestId:'persisted',requestHash:'d'.repeat(64),maxCredits:80});ledger.transition('owner','persisted',{operation:'begin'});db.close();
 db=new DatabaseSync(path);ledger=new CommercialUsageLedger({db,webhookSecret:secret,clock:()=>now});
 assert.equal(ledger.webhook(raw,signature(raw)).replayed,true);assert.equal(ledger.summary('owner').remaining,20);
 assert.equal(ledger.transition('owner','persisted',{operation:'begin'}).dispatchAllowed,false);
});
test('a signed conflicting replay cannot change previously granted account credits',t=>{
 const {ledger}=fixture(t),raw=event();ledger.webhook(raw,signature(raw));const altered=JSON.parse(raw);altered.data.currency_code='USD';const other=Buffer.from(JSON.stringify(altered));
 assert.throws(()=>ledger.webhook(other,signature(other)),error=>error.code==='C_WEBHOOK_REPLAY_CONFLICT');assert.equal(ledger.summary('owner').included,100);
});
