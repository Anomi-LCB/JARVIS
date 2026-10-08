import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConnectionShell, connectionPages, normalizeCoreBase,renderMcpToolReadiness } from '../src/ui/connections/connection-center.js';
import { renderIntegrationReadiness } from '../src/ui/integration-readiness.js';
import { desktopFeatures } from '../apps/pc-agent/src/install/desktop-features.js';
import { existsSync } from 'node:fs';
import {renderMcpPackageSetup} from '../src/ui/connections/mcp-packages.js';
import {escape} from '../src/ui/connections/connection-center.js';
import {renderMcpVerifiedResult,renderMcpCallHistory} from '../src/ui/connections/connection-center.js';
import {renderConnectionObservationFailure} from '../src/ui/connections/connection-center.js';

test('failed observation hides stale readiness without claiming revocation and escapes the reason',()=>{
 const html=renderConnectionObservationFailure('<img src=x onerror=alert(1)>');
 assert.match(html,/이전에 표시한 계정·서버·권한·준비 상태/);
 assert.match(html,/철회한 것은 아닙니다/);
 assert.match(html,/runtime.html/);
 assert.ok(!html.includes('<img'));
 assert.ok(!html.includes('<form'));
});

test('verified content is escaped, scoped and only offered for independently verified receipts',()=>{
 const value={businessOutcomeVerified:true,result:{structuredContent:{text:'<img src=x onerror=alert(1)> 문서'}}};
 assert.match(renderMcpVerifiedResult(value),/&lt;img/);assert.ok(!renderMcpVerifiedResult(value).includes('<img src='));
 assert.equal(renderMcpVerifiedResult({...value,businessOutcomeVerified:false}),'');
 const page={items:[{tool:'read_document',requestId:'request_result_00001',status:'expectation-matched',verificationReceipt:{status:'verified'}},{tool:'sum',requestId:'request_result_00002',status:'expectation-matched'}]};
 const html=renderMcpCallHistory('local',page,{auth:true,verifiedResults:{request_result_00001:value}});
 assert.equal((html.match(/data-mcp-result="/g)??[]).length,1);assert.match(html,/검증한 내용 보기/);assert.match(html,/내용 닫기/);assert.ok(!html.includes('<img src='));
});

test('MCP package UI offers only matching reviewed versions and distinguishes missing diagnostics',()=>{
 const item={id:'id',label:'<script>server</script>',capabilityReadiness:[{tool:'sum',contractCurrent:true,contract:{packageId:'local.sum',version:'1.0.0'},packageInstalled:false}]};
 const state={availableCatalog:[{id:'approved',tool:'sum',packageId:'local.sum',version:'1.0.0'},{id:'wrong',tool:'sum',packageId:'local.sum',version:'2.0.0'}],installations:[]};
 const html=renderMcpPackageSetup(state,[item],{escape,auth:true});
 assert.match(html,/value="approved"/);assert.ok(!html.includes('value="wrong"'));assert.ok(!html.includes('<script>server'));
 assert.match(renderMcpPackageSetup(null,[],{escape}),/확인하지 못했습니다/); 
 const blocked=renderMcpPackageSetup({...state,installations:[{connectionId:'id',tool:'sum',status:'blocked',reasonCode:'A_MCP_INSTALL_CONTRACT_CHANGED'}]},[{...item,capabilityReadiness:[{...item.capabilityReadiness[0],contractCurrent:false}]}],{escape,auth:true});
 assert.match(blocked,/새 계약을 검토/);assert.ok(!blocked.includes('data-mcp-install="'));
});

test('MCP readiness separates manual grants, reviewed contracts and runtime installation',()=>{
 const missing=renderMcpToolReadiness(null,{granted:true});
 assert.match(missing,/허용됨/);assert.match(missing,/미등록/);assert.match(missing,/설치 확인 필요/);
 const state={contractCurrent:true,contract:{packageId:'local.sum',version:'1.0.0',verifierId:'sum.oracle',source:'<script>bad</script>'},packageInstalled:false};
 const registered=renderMcpToolReadiness(state);
 assert.match(registered,/계약 등록만으로/);assert.ok(!registered.includes('<script>bad'));
 const installed=renderMcpToolReadiness({...state,packageInstalled:true,intentBindingInstalled:true});
 assert.match(installed,/지원하는 표현만 처리/);assert.match(installed,/현재 작업의 완료 증거가 아닙니다/);
 assert.match(renderMcpToolReadiness(state,{unresolved:true}),/추가 실행은 차단/);
});

test('stored Core addresses reject remote destinations and hidden URL credentials',()=>{
  const origin='http://127.0.0.1:41730';
  assert.equal(normalizeCoreBase('/api/core/',origin),'/api/core');
  assert.equal(normalizeCoreBase('http://localhost:4071/',origin),'http://localhost:4071');
  for(const value of ['http://example.com','http://user:secret@127.0.0.1:4071','http://127.0.0.1:4071?token=secret','http://127.0.0.1:4071#secret','https://localhost:4071','http://[bad'])
    assert.throws(()=>normalizeCoreBase(value,origin));
});

test('each connection category has its own page and correct selected navigation',()=>{
  for(const kind of Object.keys(connectionPages)) {
    assert.ok(existsSync(new URL(`../src/ui/connections/${kind}.html`,import.meta.url)));
    const html=renderConnectionShell(kind,'<form>unique content</form>');
    assert.equal((html.match(/aria-current="page"/g)??[]).length,1);
    assert.ok(html.includes(`href="${kind}.html" aria-current="page"`));
  }
  for(const id of ['models','agents','mcp','inbox','connections'])assert.match(desktopFeatures.find(x=>x.id===id).path,/\/connections\/\w+\.html$/);
});
test('API and agent credentials are independently scoped and untrusted labels escaped',()=>{
  const readiness={canSetupProviderCredentials:true,connections:[]};
  const api=renderIntegrationReadiness(readiness,{kind:'api'}), agents=renderIntegrationReadiness(readiness,{kind:'agents'});
  assert.ok(api.includes('value="xai"'));assert.ok(!api.includes('value="openai-agents"'));
  assert.ok(agents.includes('value="openai-agents"'));assert.ok(!agents.includes('value="xai"'));
  assert.ok(renderConnectionShell('api','',{message:'<script>unsafe</script>'}).includes('&lt;script&gt;'));
});
