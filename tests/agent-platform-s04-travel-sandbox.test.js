import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TravelQuoteSandbox, compareTravelQuotes } from '../packages/core/src/personal-operations/travel-quote-sandbox.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(resolve(root, 'packages/core/fixtures/travel-quote-price-change-sandbox.json'), 'utf8'));

test('S04 compares complete synthetic travel quotes, refreshes price changes, and never claims booking', () => {
  let tick = 0;
  const sandbox = new TravelQuoteSandbox({ offers: fixture.offers, clock: () => new Date(Date.UTC(2026, 8, 30, 0, 0, tick++)) });
  const initial = sandbox.search(fixture.query);
  const initialSorted = compareTravelQuotes(initial.offers);
  sandbox.injectPriceChange('flight-b');
  const refreshed = sandbox.refresh(initial.offers.map(offer => offer.offerId));
  const refreshedSorted = compareTravelQuotes(refreshed.offers);

  assert.equal(initial.mode, 'synthetic-sandbox');
  assert.deepEqual(initial.query, fixture.query);
  assert.deepEqual(initialSorted.map(item => [item.offerId, item.totalMinor]), [['flight-b', 135000], ['flight-a', 150000]]);
  assert.deepEqual(refreshedSorted.map(item => [item.offerId, item.totalMinor]), [['flight-a', 150000], ['flight-b', 160000]]);
  assert.equal(initial.offers.find(item => item.offerId === 'flight-b').priceVersion, 1);
  assert.equal(refreshed.offers.find(item => item.offerId === 'flight-b').priceVersion, 2);
  assert.equal(refreshedSorted[0].conditions.refund, fixture.offers[0].conditions.refund);
  assert.equal(refreshedSorted[0].departureLocal, fixture.offers[0].departureLocal);
  assert.equal(refreshed.bookingAvailable, false);
  assert.deepEqual(refreshed.capabilities, ['quote.read', 'quote.refresh']);
  assert.equal(typeof sandbox.book, 'undefined');

  const evidence = {
    schemaVersion: 1,
    scenarioId: 'S04',
    fixtureId: 'travel-quote-price-change-v1',
    query: initial.query,
    initialOffers: initial.offers,
    initialSorted: initialSorted.map(({ offerId, totalMinor }) => ({ offerId, totalMinor })),
    refreshedOffers: refreshed.offers,
    refreshedSorted: refreshedSorted.map(({ offerId, totalMinor }) => ({ offerId, totalMinor })),
    priceChanged: initial.offers.find(item => item.offerId === 'flight-b').totalMinor
      !== refreshed.offers.find(item => item.offerId === 'flight-b').totalMinor,
    conditionsAndLocalTimesPreserved: refreshed.offers.every(offer => fixture.offers.some(source =>
      source.offerId === offer.offerId && source.conditions.refund === offer.conditions.refund
      && source.conditions.change === offer.conditions.change && source.departureLocal === offer.departureLocal
      && source.arrivalLocal === offer.arrivalLocal)),
    bookingAvailable: refreshed.bookingAvailable,
    capabilities: refreshed.capabilities,
    bookingClaimed: false,
    networkRequests: 0,
    externalWrites: 0
  };
  const evidencePath = process.env.JARVIS_S04_EVIDENCE_PATH;
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
});

test('S04 quote sandbox rejects malformed fee amounts and stale or duplicate refresh IDs', () => {
  const bad = structuredClone(fixture.offers);
  bad[0].priceHistory[0].fees[0].amountMinor = -1;
  assert.throws(() => new TravelQuoteSandbox({ offers: bad }), { code: 'A_TRAVEL_SANDBOX_OFFER_INVALID' });
  const sandbox = new TravelQuoteSandbox({ offers: fixture.offers });
  assert.throws(() => sandbox.refresh(['flight-a', 'flight-a']), { code: 'A_TRAVEL_SANDBOX_REFRESH_INVALID' });
  assert.throws(() => sandbox.refresh(['unknown']), { code: 'A_TRAVEL_SANDBOX_REFRESH_INVALID' });
});

test('quote comparison never ranks different currencies as raw minor-unit amounts', () => {
  const sandbox = new TravelQuoteSandbox({offers:fixture.offers});
  const offers = sandbox.search(fixture.query).offers;
  offers[1].currency = 'USD';
  assert.throws(() => compareTravelQuotes(offers), {code:'A_TRAVEL_QUOTE_CURRENCY_MISMATCH'});
});

test('quote source rejects unsafe totals before exposing a search or refresh result', () => {
  const offers = structuredClone(fixture.offers);
  offers[0].priceHistory[0].fees = [
    {label:'base',amountMinor:Number.MAX_SAFE_INTEGER}, {label:'tax',amountMinor:1}
  ];
  assert.throws(() => new TravelQuoteSandbox({offers}), {code:'A_TRAVEL_QUOTE_TOTAL_INVALID'});
});

test('quote comparison rejects duplicate identity and missing provider price revision', () => {
  const sandbox = new TravelQuoteSandbox({offers:fixture.offers});
  const offers = sandbox.search(fixture.query).offers;
  assert.throws(() => compareTravelQuotes([offers[0],offers[0]]), {code:'A_TRAVEL_QUOTE_IDENTITY_INVALID'});
  delete offers[0].priceVersion;
  assert.throws(() => compareTravelQuotes(offers), {code:'A_TRAVEL_QUOTE_IDENTITY_INVALID'});
});
