import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {CoreAdminAuthProvider,CoreAdminScope} from '../packages/core/src/security/core-admin-auth.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {PersonalOperationsStore} from '../packages/core/src/personal-operations/operations-store.js';
import {PersonalSourceInbox} from '../packages/core/src/personal-operations/source-inbox.js';
import {SelectedSourceClient} from '../apps/pc-agent/src/adapters/selected-source-client.js';

const selected={provider:'outlook',streamRef:'a'.repeat(64)};
const scope=CoreAdminScope.READ_SELECTED_SOURCE;
const credential={token:'synthetic-source-worker',scopes:[scope],selectedSourceBindings:[selected],expiresAt:'2026-10-07T06:00:00Z'};
test('dedicated source credential binds resource, expiry and no administrative scope',()=>{
 let now='2026-10-07T05:55:00Z';
 const auth=new CoreAdminAuthProvider({tokens:[credential],clock:()=>new Date(now)});
 const read=source=>auth.verifyBearer(credential.token,{requiredScope:scope,requiredSource:source});
 assert.equal(read(selected).allowed,true);
 assert.equal(read({...selected,provider:'gmail'}).allowed,false);
 assert.equal(read({...selected,streamRef:'b'.repeat(64)}).allowed,false);
 for(const requiredScope of Object.values(CoreAdminScope).filter(s=>s!==scope))
  assert.equal(auth.verifyBearer(credential.token,{requiredScope}).allowed,false);
 now=credential.expiresAt;assert.equal(read(selected).allowed,false);
 assert.doesNotMatch(JSON.stringify(auth.status()),/synthetic-source-worker|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});
test('missing or malformed source boundaries cannot become broad read access',()=>{
 for(const patch of [{expiresAt:undefined},{expiresAt:'2026-02-30T00:00:00Z'},{selectedSourceBindings:undefined},
  {selectedSourceBindings:[]},{selectedSourceBindings:[{...selected,extra:true}]},
  {selectedSourceBindings:[{...selected,provider:'unknown'}]},{selectedSourceBindings:Array(257).fill(selected)}]){
  const auth=new CoreAdminAuthProvider({tokens:[{...credential,...patch}],clock:()=>new Date('2026-10-07T05:55:00Z')});
  assert.equal(auth.verifyBearer(credential.token,{requiredScope:scope,requiredSource:selected}).allowed,false);
 }
});
test('normalization copies source bindings so mutable configuration cannot expand authority',()=>{
 const input={...credential,selectedSourceBindings:[{...selected}]};
 const auth=new CoreAdminAuthProvider({tokens:[input],clock:()=>new Date('2026-10-07T05:55:00Z')});
 input.selectedSourceBindings[0].streamRef='b'.repeat(64);
 assert.equal(auth.verifyBearer(input.token,{requiredScope:scope,requiredSource:selected}).allowed,true);
 assert.equal(auth.verifyBearer(input.token,{requiredScope:scope,requiredSource:input.selectedSourceBindings[0]}).allowed,false);
});
test('actual Core HTTP accepts only bound read; other account, list, write, expiry and revocation are denied',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-scoped-source-'));
 const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
 t.after(()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-scoped-source-'));rmSync(root,{recursive:true,force:true});});
 const page={provider:'outlook',account:'synthetic-one',scope:'Mail.ReadBasic',observedAt:'2026-10-07T00:00:00Z',items:[{id:'one',title:'선택한 자료'}]};
 const request={provider:'outlook',streamRef:inbox.ingest(page).stream};
 const other={provider:'outlook',streamRef:inbox.ingest({...page,account:'synthetic-two',items:[{id:'two',title:'다른 계정 비공개 자료'}]}).stream};
 let now='2026-10-07T05:55:00Z';
 const {token,...record}=credential;
 const auth=new CoreAdminAuthProvider({tokenHashes:[{...record,tokenHash:createHash('sha256').update(token).digest('hex'),selectedSourceBindings:[request]}],clock:()=>new Date(now)});
 const server=createCoreServer(undefined,{adminAuth:auth,personalInbox:inbox});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const headers={authorization:'Bearer '+credential.token,'content-type':'application/json'};
 const client=new SelectedSourceClient({baseUrl:base,tokenProvider:()=>credential.token});
 const result=await client.read(request,{checkCurrent:()=>true});
 assert.equal(result.snapshot.items[0].title,'선택한 자료');assert.equal(result.snapshot.total,1);
 const post=body=>fetch(base+'/personal-inbox/selected-source',{method:'POST',headers,body:JSON.stringify(body)});
 for(const body of [other,{...request,provider:'gmail'}]){
  const response=await post(body);assert.equal(response.status,403);assert.doesNotMatch(await response.text(),/다른 계정 비공개 자료|선택한 자료/);
 }
 assert.equal((await fetch(base+'/personal-inbox/streams',{headers})).status,403);
 assert.equal((await fetch(base+'/missions',{method:'POST',headers,body:JSON.stringify({objective:'권한을 늘려라'})})).status,403);
 now=credential.expiresAt;assert.equal((await post(request)).status,401);
 now='2026-10-07T05:55:00Z';auth.records=[];assert.equal((await post(request)).status,401);
 assert.equal(store.summary().commitments.length,0);
});
test('credential expiry during SQL observation suppresses the response after the final authority check',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-scoped-source-'));
 const store=new PersonalOperationsStore({dbPath:join(root,'db.sqlite')}),inbox=new PersonalSourceInbox(store);
 t.after(()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('jarvis-scoped-source-'));rmSync(root,{recursive:true,force:true});});
 const request={provider:'outlook',streamRef:inbox.ingest({provider:'outlook',account:'synthetic',scope:'Mail.ReadBasic',observedAt:'2026-10-07T00:00:00Z',items:[{id:'one',title:'철회 뒤 보이면 안 되는 자료'}]}).stream};
 let checks=0;
 const auth=new CoreAdminAuthProvider({tokens:[{...credential,selectedSourceBindings:[request]}],clock:()=>new Date(++checks>=3?credential.expiresAt:'2026-10-07T05:55:00Z')});
 const server=createCoreServer(undefined,{adminAuth:auth,personalInbox:inbox});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const response=await fetch(`http://127.0.0.1:${server.address().port}/personal-inbox/selected-source`,{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify(request)});
 assert.equal(response.status,403);assert.ok(checks>=3);assert.doesNotMatch(await response.text(),/철회 뒤 보이면 안 되는 자료/);
});
