import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyUcpCheckout,ucpCanonicalJson,UCP_READ_VERSION as version} from '../packages/core/src/personal-operations/ucp-checkout-read.js';
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const caps={'dev.ucp.shopping.checkout':[{version}],'dev.ucp.common.payment.ap2_mandate':[{version}]};
const profile={keys:[{...publicKey.export({format:'jwk'}),kid:'total-test',alg:'ES256',use:'sig'}]};
function check(totals){
 const value={ucp:{version,capabilities:caps},id:'cost-test',status:'ready_for_complete',currency:'KRW',line_items:[{id:'line',item:{id:'sku',price:8000},quantity:1}],totals};
 const header=Buffer.from(JSON.stringify({alg:'ES256',kid:'total-test'})).toString('base64url');
 const signature=sign('sha256',Buffer.from(`${header}.${Buffer.from(ucpCanonicalJson(value)).toString('base64url')}`),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return verifyUcpCheckout({...value,ap2:{merchant_authorization:`${header}..${signature}`}},profile,{checkoutId:value.id});
}
const row=(type,amount,extra={})=>({type,amount,...extra});
for(const [name,totals,total] of [
 ['tax+shipping',[row('subtotal',8000),row('tax',800),row('fulfillment',1200),row('total',10000)],10000],
 ['discount+credit',[row('subtotal',10000),row('discount',-1500),row('tax',680),row('account_credit',-2500,{display_text:'Credit'}),row('total',6680)],6680],
 ['split-tax',[row('subtotal',5750),row('fulfillment',899),row('tax',332),row('tax',465),row('total',7446)],7446],
 ['sub-lines',[row('subtotal',4999),row('fee',549,{lines:[{display_text:'Service',amount:399},{display_text:'Recycling',amount:150}]}),row('tax',444),row('total',5992)],5992],
 ['items-discount',[row('subtotal',10000),row('items_discount',-1000),row('discount',-500),row('total',8500)],8500],
 ['tax-inclusive-no-extra-tax',[row('subtotal',8000,{display_text:'Tax included'}),row('total',8000)],8000],
 ['safe-boundary',[row('subtotal',Number.MAX_SAFE_INTEGER),row('discount',-1),row('total',Number.MAX_SAFE_INTEGER-1)],Number.MAX_SAFE_INTEGER-1]
])test('signed declared total arithmetic '+name,()=>{
 const before=JSON.stringify(totals),result=check(totals);
 assert.equal(result.totalArithmetic.verified,true);assert.equal(result.totalArithmetic.computedTotalMinor,total);
 assert.equal(result.totalMinor,total);assert.equal(result.allInTotalVerified,false,'undeclared costs and actual payment are not proved by arithmetic');
 assert.equal(result.paymentReceiptVerified,false);assert.equal(JSON.stringify(totals),before);
});
for(const [name,totals,reason] of [
 ['missing-cost',[row('subtotal',8000),row('tax',800),row('fulfillment',1200),row('total',8000)],'total-mismatch'],
 ['missing-subtotal',[row('total',10000)],'subtotal-required'],
 ['duplicate-subtotal',[row('subtotal',5000),row('subtotal',5000),row('total',10000)],'subtotal-not-unique'],
 ['bad-sub-lines',[row('subtotal',8000),row('fee',500,{lines:[{display_text:'Fee',amount:499}]}),row('total',8500)],'sub-lines-mismatch'],
 ['overflow',[row('subtotal',Number.MAX_SAFE_INTEGER),row('fee',1),row('total',Number.MAX_SAFE_INTEGER)],'total-out-of-range'],
 ['negative-result',[row('subtotal',100),row('discount',-200),row('total',0)],'total-out-of-range']
])test('signed mismatch remains visible but not order-eligible '+name,()=>{
 const result=check(totals);assert.equal(result.totalArithmetic.verified,false);assert.ok(result.totalArithmetic.reasons.includes(reason));
 assert.equal(result.totalMinor,totals.at(-1).amount,'do not rewrite merchant-presented total');
});
for(const [name,totals] of [
 ['positive-discount',[row('subtotal',100),row('discount',1),row('total',101)]],
 ['negative-tax',[row('subtotal',100),row('tax',-1),row('total',99)]],
 ['unknown-label-missing',[row('subtotal',100),row('custom_fee',1),row('total',101)]],
 ['fractional-sub-line',[row('subtotal',100),row('fee',1,{lines:[{display_text:'Fee',amount:0.5}]}),row('total',101)]]
])test('invalid signed amount structure '+name,()=>assert.throws(()=>check(totals),/A_UCP_CHECKOUT_CONTENT_INVALID/));
