import test from 'node:test';import assert from 'node:assert/strict';
import {renderEmailConnection,renderEmailConnectionUnavailable} from '../src/ui/connections/email.js';
import {escape,renderConnectionShell} from '../src/ui/connections/connection-center.js';
import {desktopFeatures} from '../apps/pc-agent/src/install/desktop-features.js';
test('email readiness never treats configured or inconsistent observations as verified',()=>{
 const base={configured:true,status:'unverified'};
 assert.match(renderEmailConnection(base,{escape,enabled:true}),/설정 있음 · 연결 확인 전/);
 const inconsistent=renderEmailConnection({...base,status:'verified',available:true,providerVerified:false},{escape,enabled:true});
 assert.match(inconsistent,/다시 확인해야/);assert.ok(!inconsistent.includes('서버 인증을 확인했습니다'));
 const verified=renderEmailConnection({...base,status:'verified',available:true,providerVerified:true,checkedAt:'<script>bad</script>'},{escape,enabled:true});
 assert.match(verified,/수신함 도착은 아직/);assert.match(verified,/&lt;script&gt;/);assert.ok(!verified.includes('<script>'));
});
test('mail setup contains no credential fields; pause and unauthenticated actions are disabled',()=>{
 for(const status of [{configured:false},{configured:true,status:'paused'}]){
  const html=renderEmailConnection(status,{escape,enabled:true});assert.match(html,/data-email-pause disabled/);assert.ok(!html.includes('<input'));
 }
 const disabled=renderEmailConnection({configured:true},{escape});assert.match(disabled,/data-email-probe disabled/);
 assert.match(renderEmailConnection({configured:true,status:'paused'},{escape,enabled:true}),/제공자 계정의 권한 철회/);
 assert.match(renderConnectionShell('email',''),/email.html" aria-current="page"/);
 assert.equal(desktopFeatures.find(f=>f.id==='email').path,'/src/ui/connections/email.html');
});
test('unsupported remote email controller explains its boundary without offering unsafe fallback',()=>{
 const html=renderEmailConnectionUnavailable();assert.match(html,/원격 장치의 계정 연결로 대신/);assert.match(html,/실제 실행 장치/);
 assert.ok(!html.includes('<button'));assert.ok(!html.includes('<input'));assert.match(html,/data-connection-unavailable/);
});
