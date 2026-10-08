import {createHash} from 'node:crypto';
import {compareTravelQuotes} from './travel-quote-sandbox.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function fingerprint(quote) {
  return createHash('sha256').update(JSON.stringify(canonical(quote))).digest('hex');
}

/** Quote preparation only. Accounting never authorizes booking or a charge. */
export async function reserveRefreshedTravelQuote({source,budget,mandateId,requestId,expectedQuote,maxTotalMinor}) {
  if(!source||typeof source.refresh!=='function'||!budget||typeof budget.reserve!=='function')fail('A_TRAVEL_QUOTE_SOURCE_UNAVAILABLE');
  if(!Number.isSafeInteger(maxTotalMinor)||maxTotalMinor<0)fail('A_TRAVEL_QUOTE_LIMIT_INVALID');
  const expected=compareTravelQuotes([expectedQuote])[0];
  const response=await source.refresh([expected.offerId]);
  // Until a real provider adapter is independently validated, this integration
  // is expressly limited to the existing synthetic, non-booking source.
  if(response?.mode!=='synthetic-sandbox'||response.bookingAvailable!==false
    ||!Array.isArray(response.offers)||response.offers.length!==1)fail('A_TRAVEL_QUOTE_SOURCE_UNVERIFIED');
  const current=compareTravelQuotes(response.offers)[0];
  const intentFingerprint=fingerprint(current);
  if(intentFingerprint!==fingerprint(expected))fail('A_TRAVEL_QUOTE_CHANGED');
  if(current.totalMinor>maxTotalMinor)fail('A_TRAVEL_QUOTE_LIMIT_EXCEEDED');
  const reservation=budget.reserve({mandateId,requestId,intentFingerprint,request:{
    action:'travel.quote',target:`provider:${current.provider}`,currency:current.currency,amountMinor:current.totalMinor}});
  if(reservation.state!=='reserved')fail('A_TRAVEL_QUOTE_RESERVATION_CLOSED');
  if(reservation.replayed&&reservation.eligibleNow!==true)fail('A_TRAVEL_QUOTE_MANDATE_DENIED');
  return {mode:'synthetic-sandbox',quote:current,intentFingerprint,reservation,
    checkedAt:response.checkedAt,executionAuthority:false,bookingAvailable:false,providerChargeVerified:false};
}
