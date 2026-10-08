import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { GrowthRuntime } from '../apps/growth-memory/src/growth-runtime.js';
import { SqliteMemoryStore } from '../apps/growth-memory/src/db/sqlite-store.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const root = await mkdtemp(join(tmpdir(), 'jarvis-archive-browser-'));
const output = resolve('artifacts/agent-platform-20260930/archival-browser');
await mkdir(output, { recursive: true });
const store = new SqliteMemoryStore({ dbPath: join(root, 'growth.sqlite'), reviewDir: join(root, 'reviews'), backupDir: join(root, 'backups') });
const growth = new GrowthRuntime({ memoryStore: store, auditRoot: root });
const token = 'synthetic-browser-admin';
const core = createCoreServer(new CoreFacade({ memoryStore: growth, workspaceRoot: root }), { adminToken: token });
let ui;
try {
  await listenOnFetchSafePort(core, { host: '127.0.0.1', port: 0 });
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  ui = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/memory/selected-conversations/')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await fetch(coreUrl + req.url, { method: req.method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text()); return;
      }
      const sources = { '/selected-conversations.js': 'src/ui/selected-conversations.js', '/styles.css': 'src/ui/styles.css' };
      if (sources[req.url]) { res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(sources[req.url])); return; }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="app"></main><script type="module">
          import {createSelectedConversationPanel} from '/selected-conversations.js';
          const root=document.querySelector('#app');
          const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          const panel=createSelectedConversationPanel({escape,changed:()=>root.innerHTML=panel.render(),request:async(path,options)=>{
            const response=await fetch(path,{method:options.method,headers:{'content-type':'application/json'},body:JSON.stringify(options.body)});
            const body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error.code),{code:body.error.code});return body;}});
          root.innerHTML=panel.render();panel.attach(root);
        </script></html>`); return;
      }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  await listenOnFetchSafePort(ui, { host: '127.0.0.1', port: 0 });
  const status = await new Promise((resolvePromise, reject) => {
    const child = spawn('python', ['-X', 'utf8', 'scripts/selected-conversation-browser-qa.py', '--url', `http://127.0.0.1:${ui.address().port}/`, '--output', output], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', resolvePromise);
  });
  if (status !== 0) process.exitCode = 1;
} finally {
  if (ui?.listening) await new Promise(resolvePromise => ui.close(resolvePromise));
  if (core.listening) await new Promise(resolvePromise => core.close(resolvePromise));
  store.close(); await rm(root, { recursive: true, force: true });
}
