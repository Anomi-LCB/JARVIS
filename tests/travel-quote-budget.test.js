import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {TravelQuoteSandbox} from '../packages/core/src/personal-operations/travel-quote-sandbox.js';
import {reserveRefreshedTravelQuote} from '../packages/core/src/personal-operations/travel-quote-budget.js';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalMandateBudget} from '../packages/core/src/personal-operations/mandate-budget.js';

const fixtureData=JSON.parse(readFileSync('packages/core/fixtures/travel-quote-price-change-sandbox.json','utf8'));
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'jarvis-travel-budget-'));
  const dbPath=join(root,'operations.sqlite');
  const store=new PersonalOperationsStore({dbPath,clock:()=>new Date('2026-10-03T00:00:00Z')});
  const budget=new PersonalMandateBudget(store);
  const offers=structuredClone(fixtureData.offers);
  offers.forEach(offer=>{offer.provider='synthetic-air';});
  const source=new TravelQuoteSandbox({offers,clock:()=>new Date('2026-10-03T00:00:00Z')});
  const quotes=source.search(fixtureData.query).offers;
  const mandate=store.createMandate({action:'travel.quote',target:'provider:synthetic-air',currency:'KRW',maxAmountMinor:200000,
    validFrom:'2026-10-01T00:00:00Z',expiresAt:'2026-11-01T00:00:00Z'});
  budget.configure({mandateId:mandate.id,totalMinor:300000,maxCalls:5});
  t.after(()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  const prepare=(requestId='one',expectedQuote=quotes[0],patch={})=>reserveRefreshedTravelQuote({
    source,budget,mandateId:mandate.id,requestId,expectedQuote,maxTotalMinor:160000,...patch});
  return {root,dbPath,store,budget,source,quotes,mandateId:mandate.id,prepare};
}

test('refreshed full quote is bound to one persistent reservation and cumulative budget',async t=>{
  const f=fixture(t);
  const first=await f.prepare();
  assert.equal(first.quote.totalMinor,150000);
  assert.equal(first.executionAuthority,false);
  assert.equal(first.bookingAvailable,false);
  assert.equal(first.providerChargeVerified,false);
  assert.equal((await f.prepare()).reservation.id,first.reservation.id);
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldMinor,150000);
  const second=await f.prepare('two',f.quotes[1]);
  assert.equal(second.quote.totalMinor,135000);
  await assert.rejects(f.prepare('three',f.quotes[1]),/A_BUDGET_LIMIT_EXCEEDED/);
  const otherStore=new PersonalOperationsStore({dbPath:f.dbPath,clock:()=>new Date('2026-10-03T00:00:00Z')});
  try {
    const reopened=new PersonalMandateBudget(otherStore);
    assert.equal(reopened.summary(f.mandateId).usedOrHeldMinor,285000);
    assert.equal(JSON.parse(reopened.get(first.reservation.id).request_json).intentFingerprint,first.intentFingerprint);
    const begun=reopened.begin(first.reservation.id);
    assert.equal(begun.state,'in_flight');
    assert.equal(begun.executionAuthority,false);
    assert.equal(begun.providerChargeVerified,false);
  } finally {otherStore.close();}
  const evidence={observedAt:new Date().toISOString(),mode:'synthetic-sandbox',actualSqlite:true,
    reservedTotals:[first.quote.totalMinor,second.quote.totalMinor],heldTotal:285000,replayAddsReservation:false,
    quoteFingerprint:first.intentFingerprint,executionAuthority:false,bookingAvailable:false,externalWrites:0,cost:'unmeasured'};
  console.log(JSON.stringify({travelBudgetEvidence:evidence}));
  if(process.env.JARVIS_TRAVEL_BUDGET_EVIDENCE_PATH)writeFileSync(process.env.JARVIS_TRAVEL_BUDGET_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
});

test('same request and total cannot silently select a different offer or different conditions',async t=>{
  const f=fixture(t);
  await f.prepare();
  const changed=structuredClone(f.quotes[0]);
  changed.conditions.refund='환불 불가';
  f.source.offers.get('flight-a').conditions.refund='환불 불가';
  await assert.rejects(f.prepare('one',changed),/A_BUDGET_REQUEST_CONFLICT/);
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldMinor,150000);
});

test('same price at the same provider cannot reuse another offer reservation',async t=>{
  const f=fixture(t);
  await f.prepare();
  const offer=structuredClone(f.source.offers.get('flight-a'));
  offer.offerId='flight-copy';
  f.source.offers.set(offer.offerId,offer);
  const quote=f.source.refresh(['flight-copy']).offers[0];
  await assert.rejects(f.prepare('one',quote),/A_BUDGET_REQUEST_CONFLICT/);
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldCalls,1);
});

for(const change of ['price','conditions','schedule','provider','currency'])test(`refresh change is detected before reserving: ${change}`,async t=>{
  const f=fixture(t),offer=f.source.offers.get('flight-b');
  if(change==='price')f.source.injectPriceChange('flight-b');
  if(change==='conditions')offer.conditions.refund='새 조건';
  if(change==='schedule')offer.departureLocal='2026-10-12T12:00+09:00';
  if(change==='provider')offer.provider='other-air';
  if(change==='currency')offer.currency='USD';
  // The schedule fixture now departs after arrival: invalid supplier data is
  // rejected before it can be compared as an otherwise valid changed quote.
  await assert.rejects(f.prepare('changed',f.quotes[1]),{code:change==='schedule'?'A_TRAVEL_SANDBOX_OFFER_INVALID':'A_TRAVEL_QUOTE_CHANGED'});
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldCalls,0);
});

test('requested cap includes all fees and zero cap is not treated as absent',async t=>{
  const f=fixture(t);
  for(const maxTotalMinor of [149999,0])await assert.rejects(f.prepare('cap',f.quotes[0],{maxTotalMinor}),{code:'A_TRAVEL_QUOTE_LIMIT_EXCEEDED'});
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldCalls,0);
});

test('revocation and released request cannot be returned as ready',async t=>{
  const f=fixture(t),first=await f.prepare();
  f.store.revokeMandate(f.mandateId);
  await assert.rejects(f.prepare(),{code:'A_TRAVEL_QUOTE_MANDATE_DENIED'});
  f.budget.release(first.reservation.id);
  await assert.rejects(f.prepare(),{code:'A_TRAVEL_QUOTE_RESERVATION_CLOSED'});
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldMinor,0);
});

test('unverified provider or oversized response never creates a reservation',async t=>{
  const f=fixture(t);
  for(const response of [{mode:'production',bookingAvailable:true,offers:[f.quotes[0]]},
    {mode:'synthetic-sandbox',bookingAvailable:false,offers:[f.quotes[0],f.quotes[1]]}]) {
    await assert.rejects(f.prepare('source',f.quotes[0],{source:{async refresh(){return response;}}}),{code:'A_TRAVEL_QUOTE_SOURCE_UNVERIFIED'});
  }
  assert.equal(f.budget.summary(f.mandateId).usedOrHeldCalls,0);
});
