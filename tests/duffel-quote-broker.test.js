import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {IntegrationConnectorRegistry} from '../packages/core/src/personal-operations/integration-security.js';
import {createDuffelQuoteBroker,createDuffelBrokerQuoteClient,normalizeDuffelTestOffer,
  DUFFEL_CONNECTOR_ID,DUFFEL_READ_SCOPE,DUFFEL_READ_CAPABILITY} from '../packages/core/src/personal-operations/duffel-quote-broker.js';

const now='2026-10-03T00:00:00.000Z';
const raw=()=>({data:{id:'off_fixture',live_mode:false,partial:false,total_amount:'45.00',total_currency:'GBP',
  expires_at:'2026-10-03T00:30:00.000Z',updated_at:now,passengers:[{id:'pas_fixture',given_name:'Fixture'}],
  slices:[{origin:{iata_code:'LHR'},destination:{iata_code:'CDG'},segments:[{id:'seg_fixture'}]}],
  conditions:{refund_before_departure:null,change_before_departure:{allowed:true,penalty_amount:'20.00',penalty_currency:'GBP'}},
  available_services:[{id:'ase_fixture',type:'baggage',total_amount:'10.00',total_currency:'GBP'}]}});
const request={connectionId:'duffel-fixture',expectedRevision:'revision-one',offerId:'off_fixture'};
function fixture({fetchImpl}={}) {
  const state={reads:0,calls:[],body:raw(),now,hook:null,afterHook:null,token:'duffel_test_synthetic_fixture_key'};
  state.rows=[{connectionId:request.connectionId,connectorId:DUFFEL_CONNECTOR_ID,authMethod:'api-key',
    status:'credentials-stored-unverified',updatedAt:request.expectedRevision,scopes:[DUFFEL_READ_SCOPE],grants:[DUFFEL_READ_CAPABILITY]}];
  const vault={list:()=>structuredClone(state.rows),async withCredentials(id,callback){
    state.reads++;
    const result=await callback({apiKey:state.token},structuredClone(state.rows[0]));
    state.afterHook?.();return result;
  }};
  const broker=createDuffelQuoteBroker({registry:new IntegrationConnectorRegistry(),vault,clock:()=>new Date(state.now),
    fetchImpl:async(url,options)=>{
      state.calls.push({url,method:options.method,redirect:options.redirect});
      assert.equal(options.headers.authorization,`Bearer ${state.token}`);
      const response=fetchImpl?await fetchImpl(url,options):new Response(JSON.stringify(state.body),{headers:{'content-type':'application/json'}});
      state.hook?.();return response;
    }});
  const client=createDuffelBrokerQuoteClient({connectionMetadata:vault.list,execute:input=>broker.execute(input)});
  return {state,broker,client};
}

test('facade sends only an offer ID through a fixed GET broker and does not claim all-in price',async()=>{
  const f=fixture();const result=await f.client.offer('off_fixture');
  assert.equal(result.offerTotalMinor,4500);
  assert.equal(result.allInTotalVerified,false);
  assert.equal(result.ancillarySelectionVerified,false);
  assert.equal(result.availableServices[0].total_amount,'10.00');
  assert.equal(result.bookingAvailable,false);
  assert.equal(result.executionAuthority,false);
  assert.equal(result.passengerRefs.length,1);
  assert.equal(JSON.stringify(result).includes('given_name'),false);
  assert.equal(f.client.withCredentials,undefined);
  assert.equal(f.broker.withCredentials,undefined);
  assert.deepEqual(f.state.calls,[{url:'https://api.duffel.com/air/offers/off_fixture?return_available_services=true',method:'GET',redirect:'error'}]);
  assert.equal(f.client.readiness().ready,false);
  assert.equal(f.client.readiness().reason,'provider-call-unverified');
});

test('missing or ambiguous account gives a readiness reason without retrieving a key',async()=>{
  const f=fixture();f.state.rows=[];
  assert.equal(f.client.readiness().reason,'connection-required');
  await assert.rejects(f.client.offer('off_fixture'),/A_DUFFEL_CONNECTION_REQUIRED/);
  assert.equal(f.state.reads,0);
  const g=fixture();g.state.rows.push({...g.state.rows[0],connectionId:'second'});
  assert.equal(g.client.readiness().reason,'account-selection-required');
  await assert.rejects(g.client.offer('off_fixture'),/A_DUFFEL_CONNECTION_AMBIGUOUS/);
  assert.equal(g.state.reads,0);
});

for(const patch of [{url:'https://example.test'},{headers:{authorization:'other'}},{method:'POST'},
  {offerId:'../orders'},{expectedRevision:'wrong'}])test(`invalid operation is rejected before secret access: ${JSON.stringify(patch)}`,async()=>{
  const f=fixture();await assert.rejects(f.broker.execute({...request,...patch}),/A_DUFFEL_(REQUEST_INVALID|REVISION_CONFLICT)/);
  assert.equal(f.state.reads,0);assert.equal(f.state.calls.length,0);
});

test('live token and missing JARVIS read grant never reach the provider',async()=>{
  const f=fixture();f.state.token='duffel_live_synthetic_fixture_key';
  await assert.rejects(f.broker.execute(request),/A_DUFFEL_TEST_TOKEN_REQUIRED/);assert.equal(f.state.calls.length,0);
  const g=fixture();g.state.rows[0].grants=[];
  await assert.rejects(g.broker.execute(request),/A_DUFFEL_CONNECTION_REQUIRED/);assert.equal(g.state.reads,0);
});

for(const patch of [{id:'off_other'},{live_mode:true},{partial:true},{partial:'false'},
  {expires_at:now},{expires_at:'2026-02-30T00:00:00Z'},{updated_at:'2026-10-04T00:00:00Z'},
  {total_currency:'UNKNOWN'},{total_amount:'45.001'},{available_services:null}]) {
  test(`invalid, expired or unsupported quote is not normalized: ${JSON.stringify(patch)}`,()=>{
    const body=raw();Object.assign(body.data,patch);
    assert.throws(()=>normalizeDuffelTestOffer(body,{expectedOfferId:'off_fixture',clock:()=>new Date(now)}),/A_DUFFEL_/);
  });
}

test('KRW exact amount and currency-specific precision use integer arithmetic',()=>{
  const body=raw();body.data.total_currency='KRW';body.data.total_amount='123456789.00';
  assert.equal(normalizeDuffelTestOffer(body,{expectedOfferId:'off_fixture',clock:()=>new Date(now)}).offerTotalMinor,123456789);
  body.data.total_amount='0.50';assert.throws(()=>normalizeDuffelTestOffer(body,{expectedOfferId:'off_fixture',clock:()=>new Date(now)}),/AMOUNT_INVALID/);
});

for(const mutation of ['revoke','revision','expiry'])test(`result is suppressed after asynchronous ${mutation}`,async()=>{
  const f=fixture();
  if(mutation==='revoke')f.state.hook=()=>{f.state.rows[0].status='revoked';};
  if(mutation==='revision')f.state.hook=()=>{f.state.rows[0].updatedAt='revision-two';};
  if(mutation==='expiry')f.state.afterHook=()=>{f.state.now='2026-10-03T00:30:00.000Z';};
  await assert.rejects(f.client.offer('off_fixture'),/A_DUFFEL_(CONNECTION_REQUIRED|REVISION_CONFLICT|OFFER_EXPIRED)/);
});

test('credential echoes, oversized responses and raw network errors do not leak data',async()=>{
  const f=fixture();f.state.body.data.conditions.note=f.state.token;
  await assert.rejects(f.client.offer('off_fixture'),/A_DUFFEL_RESPONSE_DENIED/);
  const g=fixture({fetchImpl:async()=>new Response('x'.repeat(512*1024+1),{headers:{'content-type':'application/json'}})});
  await assert.rejects(g.client.offer('off_fixture'),/A_DUFFEL_RESPONSE_TOO_LARGE/);
  const h=fixture({fetchImpl:async()=>{throw new Error('duffel_test_private_raw_secret');}});
  await assert.rejects(h.client.offer('off_fixture'),error=>error.message==='A_DUFFEL_NETWORK');
});

test('the validated request is snapshotted and an aborted call never reads a secret',async()=>{
  const f=fixture(),input={...request};
  f.state.hook=()=>{input.offerId='off_other';input.expectedRevision='another';};
  assert.equal((await f.broker.execute(input)).offerId,'off_fixture');
  const g=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(g.broker.execute(request,{signal:controller.signal}));
  assert.equal(g.state.reads,0);assert.equal(g.state.calls.length,0);
});

test('invalid clock after asynchronous release cannot make an expired quote look valid',async()=>{
  const f=fixture();f.state.afterHook=()=>{f.state.now='invalid';};
  await assert.rejects(f.client.offer('off_fixture'),/A_DUFFEL_CLOCK_INVALID/);
});

test('actual loopback HTTP validates broker request/response contract with synthetic credentials',async t=>{
  const captured=[];
  const server=createServer((req,res)=>{
    captured.push({method:req.method,path:req.url,version:req.headers['duffel-version']});
    assert.equal(req.headers.authorization,'Bearer duffel_test_synthetic_fixture_key');
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(raw()));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const f=fixture({fetchImpl:(url,options)=>fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}${new URL(url).search}`,options)});
  const result=await f.client.offer('off_fixture');
  assert.equal(result.offerTotalMinor,4500);
  assert.deepEqual(captured,[{method:'GET',path:'/air/offers/off_fixture?return_available_services=true',version:'v2'}]);
  const evidence={observedAt:new Date().toISOString(),transport:'actual-loopback-http',provider:'synthetic-duffel-fixture',
    request:captured[0],amountMinor:4500,currency:'GBP',allInTotalVerified:false,bookingAvailable:false,
    actualProviderApiCalls:0,externalWrites:0,credentialStorage:'synthetic-interface',processIsolationVerified:false};
  console.log(JSON.stringify({duffelBrokerEvidence:evidence}));
  if(process.env.JARVIS_DUFFEL_EVIDENCE_PATH)writeFileSync(process.env.JARVIS_DUFFEL_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
});

test('actual HTTP redirect never forwards the bearer credential to a second endpoint',async t=>{
  const paths=[];
  const server=createServer((req,res)=>{
    paths.push(req.url);
    if(req.url==='/offer'){res.writeHead(302,{location:'/unexpected'});res.end();}
    else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(raw()));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const f=fixture({fetchImpl:(url,options)=>fetch(`http://127.0.0.1:${server.address().port}/offer`,options)});
  await assert.rejects(f.client.offer('off_fixture'),error=>error.message==='A_DUFFEL_NETWORK');
  assert.deepEqual(paths,['/offer']);
});
