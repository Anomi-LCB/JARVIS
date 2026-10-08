const MAX_OFFERS = 100;

/** Deterministic, synthetic quote source for isolated travel-comparison evaluations only. */
export class TravelQuoteSandbox {
  constructor({ offers = [], clock = () => new Date() } = {}) {
    if (!Array.isArray(offers) || offers.length < 1 || offers.length > MAX_OFFERS) throw travelError('A_TRAVEL_SANDBOX_OFFERS_INVALID');
    this.clock = clock;
    this.offers = new Map();
    for (const offer of offers) {
      validateOffer(offer);
      if (this.offers.has(offer.offerId)) throw travelError('A_TRAVEL_SANDBOX_DUPLICATE_OFFER');
      this.offers.set(offer.offerId, structuredClone(offer));
    }
  }

  search(query) {
    validateQuery(query);
    return {
      mode: 'synthetic-sandbox',
      query: structuredClone(query),
      offers: [...this.offers.values()].filter(offer => matchesQuery(offer, query)).map(toQuote),
      checkedAt: this.clock().toISOString(),
      bookingAvailable: false,
      capabilities: ['quote.read', 'quote.refresh']
    };
  }

  refresh(offerIds) {
    if (!Array.isArray(offerIds) || offerIds.length < 1 || offerIds.length > MAX_OFFERS
      || new Set(offerIds).size !== offerIds.length || offerIds.some(id => !this.offers.has(id))) {
      throw travelError('A_TRAVEL_SANDBOX_REFRESH_INVALID');
    }
    return {
      mode: 'synthetic-sandbox',
      offers: offerIds.map(id => toQuote(this.offers.get(id))),
      checkedAt: this.clock().toISOString(),
      bookingAvailable: false,
      capabilities: ['quote.read', 'quote.refresh']
    };
  }

  /** Test-only supplier event: advances an offer to its next immutable price revision. */
  injectPriceChange(offerId) {
    const offer = this.offers.get(offerId);
    if (!offer) throw travelError('A_TRAVEL_SANDBOX_OFFER_NOT_FOUND');
    if (offer.priceHistory.length < 2) throw travelError('A_TRAVEL_SANDBOX_NO_PRICE_CHANGE_FIXTURE');
    const current = offer.priceHistory.findIndex(item => item.version === offer.currentVersion);
    if (current < 0 || current + 1 >= offer.priceHistory.length) throw travelError('A_TRAVEL_SANDBOX_PRICE_CHANGE_EXHAUSTED');
    offer.currentVersion = offer.priceHistory[current + 1].version;
    return toQuote(offer);
  }
}

export function compareTravelQuotes(offers) {
  if (!Array.isArray(offers) || offers.length > MAX_OFFERS) throw travelError('A_TRAVEL_QUOTE_LIST_INVALID');
  if (new Set(offers.map(quote => quote?.offerId)).size !== offers.length
    || offers.some(quote => !Number.isSafeInteger(quote?.priceVersion) || quote.priceVersion < 1)) {
    throw travelError('A_TRAVEL_QUOTE_IDENTITY_INVALID');
  }
  const quotes = offers.map(quote => {
    // The quote is a point-in-time snapshot; its provider revision can be >1,
    // while the single-entry validation envelope is intentionally local version 1.
    validateOffer({ ...quote, priceHistory: [{ version: 1, fees: quote.fees }], currentVersion: 1 });
    const totalMinor = checkedTotal(quote.fees);
    return { ...structuredClone(quote), totalMinor };
  });
  if (new Set(quotes.map(quote => quote.currency)).size > 1) throw travelError('A_TRAVEL_QUOTE_CURRENCY_MISMATCH');
  return quotes.sort((a, b) => a.totalMinor - b.totalMinor || a.offerId.localeCompare(b.offerId));
}

function toQuote(offer) {
  const price = offer.priceHistory.find(item => item.version === offer.currentVersion);
  if (!price) throw travelError('A_TRAVEL_SANDBOX_PRICE_REVISION_INVALID');
  const fees = structuredClone(price.fees);
  return {
    offerId: offer.offerId,
    provider: offer.provider,
    currency: offer.currency,
    passengers: offer.passengers,
    bags: offer.bags,
    priceVersion: price.version,
    origin: offer.origin,
    destination: offer.destination,
    departureLocal: offer.departureLocal,
    arrivalLocal: offer.arrivalLocal,
    conditions: structuredClone(offer.conditions),
    fees,
    totalMinor: checkedTotal(fees)
  };
}

function matchesQuery(offer, query) {
  return offer.origin === query.origin && offer.destination === query.destination
    && offer.departureLocal.slice(0, 10) === query.departureDate
    && offer.passengers === query.passengers && offer.bags === query.bags;
}

function validateQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some(key => !['origin', 'destination', 'departureDate', 'passengers', 'bags'].includes(key))
    || typeof query.origin !== 'string' || !query.origin.trim() || query.origin.length > 100
    || typeof query.destination !== 'string' || !query.destination.trim() || query.destination.length > 100
    || !validTravelDate(query.departureDate)
    || !Number.isSafeInteger(query.passengers) || query.passengers < 1 || query.passengers > 9
    || !Number.isSafeInteger(query.bags) || query.bags < 0 || query.bags > 9) throw travelError('A_TRAVEL_SANDBOX_QUERY_INVALID');
}

function validateOffer(offer) {
  const id = typeof offer?.offerId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(offer.offerId);
  const version = Number.isSafeInteger(offer?.currentVersion) && offer.currentVersion >= 1;
  const history = Array.isArray(offer?.priceHistory) && offer.priceHistory.length > 0 && offer.priceHistory.length <= 20
    && offer.priceHistory.every((item, index) => Number.isSafeInteger(item.version) && item.version === index + 1
      && Array.isArray(item.fees) && item.fees.length > 0 && item.fees.length <= 20
      && item.fees.every(fee => fee && typeof fee.label === 'string' && fee.label.length > 0 && fee.label.length <= 100
        && Number.isSafeInteger(fee.amountMinor) && fee.amountMinor >= 0));
  const time = value => {
    if(typeof value!=='string')return false;
    const match=/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)[+-](\d\d):(\d\d)$/u.exec(value);
    return Boolean(match&&validTravelDate(match[1])&&Number(match[2])<24&&Number(match[3])<60
      &&Number(match[4])<24&&Number(match[5])<60&&Number.isFinite(Date.parse(value)));
  };
  if (!id || typeof offer.provider !== 'string' || !offer.provider.trim() || offer.provider.length > 80
    || !/^[A-Z]{3}$/u.test(offer.currency) || !Number.isSafeInteger(offer.passengers) || offer.passengers < 1 || offer.passengers > 9
    || !Number.isSafeInteger(offer.bags) || offer.bags < 0 || offer.bags > 9 || typeof offer.origin !== 'string' || !offer.origin.trim()
    || typeof offer.destination !== 'string' || !offer.destination.trim() || !time(offer.departureLocal) || !time(offer.arrivalLocal)
    || Date.parse(offer.arrivalLocal) <= Date.parse(offer.departureLocal)
    || !offer.conditions || typeof offer.conditions !== 'object' || Array.isArray(offer.conditions)
    || typeof offer.conditions.refund !== 'string' || typeof offer.conditions.change !== 'string'
    || !history || !offer.priceHistory.some(item => item.version === offer.currentVersion)) throw travelError('A_TRAVEL_SANDBOX_OFFER_INVALID');
  for (const price of offer.priceHistory) checkedTotal(price.fees);
}

function validTravelDate(value){
  const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if(!match)return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  if(year<1||month<1||month>12||day<1)return false;
  const leap=year%4===0&&(year%100!==0||year%400===0);
  return day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}

function checkedTotal(fees) {
  const total = fees.reduce((sum,item) => sum + BigInt(item.amountMinor),0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw travelError('A_TRAVEL_QUOTE_TOTAL_INVALID');
  return Number(total);
}

function travelError(code) { return Object.assign(new Error(code), { code }); }
