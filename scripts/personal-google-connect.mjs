import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { GoogleReadClient } from '../packages/core/src/personal-operations/google-client.js';
import { saveGoogleCredentials } from '../packages/core/src/personal-operations/google-credentials.js';
import { googleHandoffFailureCode } from '../packages/core/src/personal-operations/google-handoff-errors.js';

if(!process.argv[2]||process.argv[2]==='--help'){
  console.log('node scripts/personal-google-connect.mjs <Google Desktop OAuth client JSON path> [loopback handoff completion URL]\nOpens Google consent for Gmail and Calendar read-only access. No tokens are printed.');
}else{
  let server,timer;
  try{
    if(process.platform!=='win32'||![3,4].includes(process.argv.length))throw new Error('A_GOOGLE_WINDOWS_CLIENT_FILE_REQUIRED');
    const completionUrl=process.argv[3]??null;
    const handoff=completionUrl?await readHandoffFromStdin():null;
    if(completionUrl)validateCompletionUrl(completionUrl,handoff.handoffId);
    const client=JSON.parse(readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/u,'')).installed;
    if(typeof client?.client_id!=='string'||!client.client_id.endsWith('.apps.googleusercontent.com')||typeof client.client_secret!=='string')throw new Error('A_GOOGLE_DESKTOP_CLIENT_INVALID');
    const verifier=randomBytes(48).toString('base64url'),state=randomBytes(32).toString('base64url');let redirect,consumed=false;
    const codePromise=new Promise((resolve,reject)=>{
      server=createServer((request,response)=>{
        response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','text/plain; charset=utf-8');response.setHeader('Referrer-Policy','no-referrer');
        let url;try{if(!redirect)throw new Error();url=new URL(request.url,redirect);}catch{response.writeHead(400);response.end('Invalid callback.');return;}
        const returned=Buffer.from(url.searchParams.get('state')??''),expected=Buffer.from(state);
        if(request.method!=='GET'||request.headers.host!==new URL(redirect).host||url.pathname!=='/oauth2callback'||consumed||returned.length!==expected.length||!timingSafeEqual(returned,expected)){response.writeHead(400);response.end('Invalid authorization response.');return;}
        consumed=true;
        if(url.searchParams.has('error')){response.end('Google authorization was not completed.');reject(new Error('A_GOOGLE_CONSENT_NOT_COMPLETED'));return;}
        const code=url.searchParams.get('code');if(!code||code.length>4096){response.writeHead(400);response.end('Invalid authorization code.');reject(new Error('A_GOOGLE_CODE_INVALID'));return;}
        response.end('Google 응답을 받았습니다. JARVIS 연결 결과는 명령 창에서 확인해 주세요.');resolve(code);
      });
      timer=setTimeout(()=>reject(new Error('A_GOOGLE_CONNECT_TIMEOUT')),300000);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    redirect=`http://127.0.0.1:${server.address().port}/oauth2callback`;
    const authorization=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for(const [key,value] of Object.entries({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))authorization.searchParams.set(key,value);
    console.log('Google 브라우저 인증을 완료해 주세요. 요청 권한: Gmail 읽기, Calendar 일정 읽기.');
    const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',authorization.href],{windowsHide:true,stdio:'ignore'});opener.on('error',()=>console.log('브라우저를 열지 못했습니다. 다시 실행해 주세요.'));
    const code=await codePromise;clearTimeout(timer);server.close();
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret,code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'})});
    if(!response.ok)throw new Error('A_GOOGLE_CODE_EXCHANGE_FAILED');const tokens=await response.json();
    if(!tokens.refresh_token)throw new Error('A_GOOGLE_OFFLINE_GRANT_REQUIRED');
    const requiredScopes=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.events.readonly'];
    const returnedScopes=typeof tokens.scope==='string'?new Set(tokens.scope.split(/\s+/u).filter(Boolean)):new Set();
    if(requiredScopes.some(scope=>!returnedScopes.has(scope))||[...returnedScopes].some(scope=>!requiredScopes.includes(scope)))throw new Error('A_GOOGLE_SCOPE_MISMATCH');
    const credentials={clientId:client.client_id,clientSecret:client.client_secret,refreshToken:tokens.refresh_token};
    const providerAccountId=await new GoogleReadClient({credentials}).account();
    if(completionUrl){
      const saved=await fetch(completionUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${handoff.ticket}`,'content-type':'application/json'},body:JSON.stringify({providerAccountId,credentials})});
      const handoffFailure=await googleHandoffFailureCode(saved);
      if(handoffFailure)throw new Error(handoffFailure);
      let activation;try{activation=await saved.json();}catch{throw new Error('A_GOOGLE_HANDOFF_RESPONSE_INVALID');}
      if(activation.activation?.providerVerified!==true||activation.activation?.status!=='verified')throw new Error('A_GOOGLE_ACTIVATION_FAILED');
      console.log('Google 계정 확인과 JARVIS 자격증명 전달이 완료됐습니다.');
    }else{
      saveGoogleCredentials(credentials);
      console.log('Google 읽기 연결을 사용자 DPAPI vault에 저장했습니다.');
    }
  }catch(error){console.error(/^A_GOOGLE_[A-Z_]+$/.test(error.message)?error.message:'A_GOOGLE_CONNECT_FAILED');process.exitCode=1;}
  finally{clearTimeout(timer);server?.close();}
}

async function readHandoffFromStdin(){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)throw new Error('A_GOOGLE_HANDOFF_INVALID');}
  let value;try{value=JSON.parse(input);}catch{throw new Error('A_GOOGLE_HANDOFF_INVALID');}
  if(!value||Object.keys(value).length!==2||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/u.test(value.handoffId)||typeof value.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(value.ticket))throw new Error('A_GOOGLE_HANDOFF_INVALID');
  return value;
}

function validateCompletionUrl(value,handoffId){
  let url;try{url=new URL(value);}catch{throw new Error('A_GOOGLE_HANDOFF_URL_INVALID');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||url.pathname!==`/integrations/handoffs/${encodeURIComponent(handoffId)}/complete`)throw new Error('A_GOOGLE_HANDOFF_URL_INVALID');
}
