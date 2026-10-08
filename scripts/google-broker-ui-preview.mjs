// Isolated UI fixture only. No real credentials, account or provider calls.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
let status = 'verification-required';
const evidence=new Map();
const state = () => ({ credentialLocation: 'broker', connectionMode: 'broker-mtls', brokerConfigured: true,
  status, readScopeRequired:true, providerVerified: status === 'connected', ...(status === 'connected' ? { checkedAt: '2026-10-02T00:00:00Z' } : {}) });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/google-setup.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(new URL('../src/ui/google-setup.js', import.meta.url))); }
  if (url.pathname === '/styles.css') { res.setHeader('content-type', 'text/css'); return res.end(readFileSync(new URL('../src/ui/connections/connection-center.css', import.meta.url))); }
  if (url.pathname.startsWith('/personal-')) {
    let body = ''; for await (const bytes of req) body += bytes;
    if (req.method === 'POST' && url.pathname === '/personal-google/connect') {
      if (JSON.parse(body).profile !== 'product') { res.statusCode = 409; return res.end('{}'); }
      status = 'connected';
    }
    if(req.method==='POST'&&url.pathname==='/personal-google/mandate'){
      const value=JSON.parse(body);
      if(!value.readFrom||!value.readUntil||Date.parse(value.readFrom)>=Date.parse(value.readUntil)){res.statusCode=409;return res.end('{}');}
      evidence.set(value.provider,{provider:value.provider,scopeRequired:true,mandateId:'synthetic-mandate',budget:{maxCalls:value.maxPages},mandateValidity:{validFrom:value.validFrom,expiresAt:value.expiresAt},readScope:{readFrom:value.readFrom,readUntil:value.readUntil}});
    }
    if(req.method==='POST'&&url.pathname==='/personal-google/sync'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({status:evidence.size===2?'ready':'degraded'}));}
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(url.pathname === '/personal-inbox' ? { google: { evidence: [...evidence.values()] }, connection: state() } : state()));
  }
  if (url.pathname === '/fixture-revoke') { status = 'failed'; return res.end('ok'); }
  if (url.pathname !== '/') { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><title>JARVIS 중개 연결 UI 격리 검사</title><body style="background:#f5f8fb"><main style="max-width:1000px;margin:40px auto;padding:24px;background:white"><h1>계정 연결</h1><p>합성 데이터 UI 검사 · 실제 계정 연결 아님</p><div id="root"></div></main><script type="module">
  import {createGoogleSetup} from '/google-setup.js';
  const root=document.querySelector('#root'); const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const request=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});if(!r.ok)throw Error('fixture');return r.json();};
  const refresh=async()=>{const data=await request('/personal-inbox');data.connection={...await request('/personal-google/connect?setup=1'),...data.connection};view.update(data);render();};
  const render=()=>root.innerHTML=view.render();const view=createGoogleSetup({request,refresh,changed:render,escape,simple:true});view.attach(root);await refresh();
  window.fixtureRefresh=refresh;
  </script></body></html>`);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, synthetic: true }) + '\n'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
