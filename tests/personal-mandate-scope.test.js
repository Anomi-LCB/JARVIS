import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalOperationsStore } from '../packages/core/src/personal-operations/operations-store.js';
import { PersonalMandateBudget } from '../packages/core/src/personal-operations/mandate-budget.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';
import {mandateScopeReasons} from '../packages/core/src/personal-operations/mandate-scope.js';

test('recursive metadata inheritance preserves exact bytes and subtree exclusions',()=>{
 const root=join(tmpdir(),'synthetic-tree'),child=join(root,'nested'),metadata=p=>`file-tree:${p}`,bytes=p=>`file:${p}`;
 const mandate={revision:1,scope:{accountRef:null,dataRefs:[metadata(root),metadata(child),bytes(join(child,'source.txt'))],deniedDataRefs:[metadata(child)]}};
 const check=ref=>mandateScopeReasons(mandate,{accountRef:null,mandateRevision:1,dataRefs:[ref]});
 assert.deepEqual(check(metadata(join(root,'allowed','x.txt'))),[]);
 assert.deepEqual(check(bytes(join(root,'allowed','x.txt'))),['data-scope-exceeded']);
 assert.ok(check(metadata(join(child,'deep'))).includes('data-exception-denied'));
 assert.ok(check(bytes(join(child,'source.txt'))).includes('data-exception-denied'));
 assert.deepEqual(check(metadata(root+'-sibling')),['data-scope-exceeded']);
 assert.deepEqual(check('source:unrelated'),['data-scope-exceeded']);
});

const base = { action: 'document.process', target: 'synthetic:report', currency: 'KRW', maxAmountMinor: 50,
  validFrom: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
const scope = { accountRef: 'synthetic-account-a', dataRefs: ['source:a','source:b','source:private'], deniedDataRefs: ['source:private'] };
const request = { action: base.action, target: base.target, currency: 'KRW', amountMinor: 10,
  accountRef: scope.accountRef, dataRefs: ['source:b','source:a'], mandateRevision: 1 };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-mandate-scope-'));
  const path = join(root,'db.sqlite'), store = new PersonalOperationsStore({ dbPath: path }), budget = new PersonalMandateBudget(store);
  const mandate = store.createMandate({ ...base, scope }); budget.configure({ mandateId: mandate.id, totalMinor: 50, maxCalls: 5 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, budget, mandate, path };
}

test('scoped mandate preserves exact account/data exceptions and does not grant execution permission', t => {
  const f=fixture(t); assert.equal(f.mandate.revision,1);
  const result=f.store.evaluateMandate(f.mandate.id,request);
  assert.equal(result.matches,true); assert.equal(result.executionAuthority,false); assert.equal(result.requiresExistingPolicyEvaluation,true);
  for (const [patch,code] of [[{accountRef:'synthetic-account-b'},'account-ref-mismatch'],
    [{dataRefs:['source:c']},'data-scope-exceeded'],[{dataRefs:['source:private']},'data-exception-denied'],
    [{mandateRevision:2},'mandate-revision-mismatch'],[{target:'synthetic:other'},'target-mismatch'],
    [{action:'document.send'},'action-mismatch'],[{amountMinor:51},'amount-exceeded']]) {
    const result=f.store.evaluateMandate(f.mandate.id,{...request,...patch});
    assert.equal(result.matches,false); assert.ok(result.reasons.includes(code));
  }
  const missing=f.store.evaluateMandate(f.mandate.id,{action:base.action,target:base.target,currency:'KRW',amountMinor:0});
  assert.deepEqual(missing.reasons,['mandate-revision-mismatch','account-ref-required','data-refs-required']);
});

test('reservation stores scope, canonicalizes data order and never replays changed account or data as the same intent', t => {
  const f=fixture(t), input={mandateId:f.mandate.id,requestId:'one',request};
  const first=f.budget.reserve(input); assert.deepEqual(JSON.parse(first.request_json).dataRefs,['source:a','source:b']);
  assert.equal(f.budget.reserve({...input,request:{...request,dataRefs:['source:a','source:b']}}).id,first.id);
  assert.throws(()=>f.budget.reserve({...input,request:{...request,dataRefs:['source:a']}}),/REQUEST_CONFLICT/);
  assert.throws(()=>f.budget.reserve({...input,request:{...request,accountRef:'other'}}),/REQUEST_CONFLICT/);
  assert.equal(f.budget.summary(f.mandate.id).usedOrHeldCalls,1);
  assert.equal(f.budget.begin(first.id).state,'in_flight');
});

test('scope survives a real DB reopen; revoked reservation cannot begin and missing scope cannot consume a count', t => {
  const f=fixture(t), saved=f.budget.reserve({mandateId:f.mandate.id,requestId:'one',request});
  const second=new PersonalOperationsStore({dbPath:f.path});
  try {
    assert.equal(second.evaluateMandate(f.mandate.id,request).matches,true);
    second.revokeMandate(f.mandate.id);
    assert.throws(()=>f.budget.begin(saved.id),/MANDATE_DENIED/);
    assert.equal(f.budget.get(saved.id).state,'reserved');
  } finally { second.close(); }
  const g=fixture(t);
  const {accountRef,dataRefs,mandateRevision,...missing}=request;
  assert.throws(()=>g.budget.reserve({mandateId:g.mandate.id,requestId:'missing',request:missing}),/MANDATE_DENIED/);
  assert.equal(g.budget.summary(g.mandate.id).usedOrHeldCalls,0);
});

test('scope schema rejects unknown fields, implicit accounts, duplicate references and undeclared exceptions', t => {
  const f=fixture(t);
  for (const patch of [{accountRef:undefined},{dataRefs:['source:a','source:a']},{deniedDataRefs:['outside']},{autoApprove:true},{accountRef:' synthetic'}]) {
    assert.throws(()=>f.store.createMandate({...base,scope:{...scope,...patch}}),/SCOPE_INVALID/);
  }
  const legacy=f.store.createMandate(base);
  assert.ok(f.store.evaluateMandate(legacy.id,request).reasons.includes('scope-not-delegated'));
  const local=f.store.createMandate({...base,scope:{accountRef:null,dataRefs:[],deniedDataRefs:[]}});
  assert.equal(f.store.evaluateMandate(local.id,{...request,accountRef:null,dataRefs:[]}).matches,true);
});

test('actual admin HTTP budget API retains scoped intent and rejects scope omission without reserving capacity', async t => {
  const f=fixture(t), server=createCoreServer(undefined,{personalOperations:f.store,personalBudget:f.budget,adminToken:'synthetic-admin'});
  await listenOnFetchSafePort(server); const port=server.address().port; t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async value=>fetch(`http://127.0.0.1:${port}/personal-budgets/reserve`,{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify(value)});
  const missing={action:base.action,target:base.target,currency:'KRW',amountMinor:0};
  assert.equal((await post({mandateId:f.mandate.id,requestId:'missing',request:missing})).status,409);
  const good=await post({mandateId:f.mandate.id,requestId:'good',request}); assert.equal(good.status,200);
  const body=await good.json(); assert.ok(JSON.stringify(body).includes('synthetic-account-a'));
  assert.equal(f.budget.summary(f.mandate.id).usedOrHeldCalls,1);
});
