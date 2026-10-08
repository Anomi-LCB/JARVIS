import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TravelQuoteSandbox,compareTravelQuotes} from '../packages/core/src/personal-operations/travel-quote-sandbox.js';
const fixture=JSON.parse(readFileSync('packages/core/fixtures/travel-quote-price-change-sandbox.json','utf8'));
for(const mode of ['departure-calendar','arrival-calendar','arrival-before','arrival-equal','hour24','minute60','passengers10','bags10'])test(`travel quote rejects invalid temporal or party contract ${mode}`,()=>{
 const offer=structuredClone(fixture.offers[0]);
 if(mode==='departure-calendar')offer.departureLocal='2026-02-30T12:00+09:00';
 if(mode==='arrival-calendar')offer.arrivalLocal='2026-04-31T12:00+09:00';
 if(mode==='arrival-before')offer.arrivalLocal='2020-01-01T12:00+09:00';
 if(mode==='arrival-equal')offer.arrivalLocal=offer.departureLocal;
 if(mode==='hour24')offer.departureLocal='2026-10-12T24:00+09:00';
 if(mode==='minute60')offer.departureLocal='2026-10-12T12:60+09:00';
 if(mode==='passengers10')offer.passengers=10;
 if(mode==='bags10')offer.bags=10;
 assert.throws(()=>new TravelQuoteSandbox({offers:[offer]}),{code:'A_TRAVEL_SANDBOX_OFFER_INVALID'});
 const quote={...offer,priceVersion:1,fees:offer.priceHistory[0].fees};delete quote.priceHistory;delete quote.currentVersion;
 assert.throws(()=>compareTravelQuotes([quote]),{code:'A_TRAVEL_SANDBOX_OFFER_INVALID'});
});
test('travel query rejects nonexistent Gregorian dates before matching offers',()=>{
 const source=new TravelQuoteSandbox({offers:fixture.offers});
 for(const departureDate of ['2026-02-30','2025-02-29','2026-04-31'])assert.throws(()=>source.search({...fixture.query,departureDate}),{code:'A_TRAVEL_SANDBOX_QUERY_INVALID'});
});
test('valid leap day, cross-day arrival and differing explicit offsets compare by absolute time',()=>{
 const offer=structuredClone(fixture.offers[0]);offer.departureLocal='2028-02-29T23:00+09:00';offer.arrivalLocal='2028-02-29T15:00+00:00';
 const source=new TravelQuoteSandbox({offers:[offer]});assert.equal(source.refresh([offer.offerId]).offers.length,1);
 assert.equal(source.search({...fixture.query,departureDate:'2028-02-29'}).offers.length,1);
 offer.arrivalLocal='2028-03-01T01:00+09:00';assert.doesNotThrow(()=>new TravelQuoteSandbox({offers:[offer]}));
});
