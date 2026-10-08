import test from 'node:test';
import assert from 'node:assert/strict';
import { googleConnectErrorMessage,createGoogleSetup } from '../src/ui/google-setup.js';

test('Google collection controls separate pause, credential deletion and provider revocation',()=>{
 const escape=x=>String(x??'').replaceAll('<','&lt;');const panel=createGoogleSetup({request:async()=>{},changed:()=>{},refresh:async()=>{},escape,simple:true});
 assert.match(panel.render(),/資料|자료 수집 상태를 아직 확인/);
 panel.update({google:{status:'collection-paused'},connection:{status:'collection-paused',credentialLocation:'broker',providerVerified:false}});
 const html=panel.render();assert.match(html,/수집 중지됨/);assert.match(html,/자격증명은 삭제하지 않습니다/);assert.match(html,/Google 계정의 연결된 앱/);assert.match(html,/data-google-pause><button[^>]*disabled/);
});

test('Google setup explains when a background service cannot open an interactive consent window', () => {
  const message = googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_INTERACTIVE_SESSION_REQUIRED' } } });
  assert.match(message, /personal-google-connect-service\.ps1/u);
  assert.match(message, /Gmail·Calendar 읽기만 허용/u);
  assert.match(googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_CLIENT_FILE_INVALID' } } }), /OAuth JSON 파일 경로/);
  assert.match(googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_HANDOFF_RESTARTED' } } }), /Core가 재시작/u);
  assert.match(googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_HANDOFF_EXPIRED' } } }), /만료됐습니다/u);
  assert.match(googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_HANDOFF_TOKEN_NOT_CONFIGURED' } } }), /configure-integration-handoff-token\.ps1/u);
  assert.match(googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_HANDOFF_STORED_UNVERIFIED' } } }), /새로고침해 연결 상태를 확인/u);
  assert.match(googleConnectErrorMessage({ payload: { error: { code: 'A_GOOGLE_HANDOFF_RECEIPT_UNAVAILABLE' } } }), /연결 완료로 처리하지 않았습니다/u);
});

test('ordinary Google connection screen shows the missing verification receipt without opening advanced settings',()=>{
 const panel=createGoogleSetup({request:async()=>{},changed:()=>{},refresh:async()=>{},escape:String,simple:true});
 panel.update({connection:{status:'failed',code:'A_GOOGLE_HANDOFF_RECEIPT_UNAVAILABLE',productAuthorizationConfigured:true},google:{configured:false}});
 const primary=panel.render().split('<details data-technical>')[0];
 assert.match(primary,/연결 완료로 처리하지 않았습니다/);assert.match(primary,/먼저 화면을 새로고침/);
 assert.doesNotMatch(primary,/클라이언트 JSON 파일 경로/);
});
