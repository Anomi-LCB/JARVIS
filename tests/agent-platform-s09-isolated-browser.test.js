import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('S09 isolated browser integration keeps credentials server-side and confines state', async () => {
  const [runner, browser, manifest, server, ui] = await Promise.all([
    readFile(new URL('../scripts/agent-platform-s09-isolated-browser.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/agent-platform-s09-isolated-browser.py', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../scripts/dev-server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8')
  ]);

  assert.equal(manifest.scripts['integration:s09-isolated-browser'], 'node scripts/agent-platform-s09-isolated-browser.mjs');
  assert.match(runner, /JARVIS_TEST_MODE: '1'/u);
  assert.match(runner, /JARVIS_CORE_WORKER_DAEMON_ENABLED: '0'/u);
  assert.match(runner, /JARVIS_CORE_REMOTE_PC_EXECUTION_ENABLED: '0'/u);
  assert.match(runner, /\['core', 'ui'\]/u);
  assert.match(runner, /Refusing to clean an isolated runtime directory/u);
  assert.doesNotMatch(runner, /JARVIS_S09_CORE_TOKEN/u);
  assert.match(browser, /Only a loopback HTTP test runtime is permitted/u);
  assert.match(browser, /sessionStorage\.getItem\('jarvis\.coreAdminToken'\)/u);
  assert.match(browser, /credentialsExposed/u);
  assert.match(browser, /\/api\/core\/routines/u);
  assert.match(browser, /\/command/u);
  assert.match(server, /pathname === '\/api\/local\/capabilities'/u);
  assert.match(server, /coreAdminProxyConfigured: Boolean/u);
  assert.match(server, /credentialsExposed: false/u);
  assert.match(ui, /function hasCoreAdminAccess\(\)/u);
  assert.match(ui, /controlCenter\.coreAdminProxyConfigured && controlCenter\.coreBaseUrl === managedProxyUrl/u);
  assert.match(ui, /localControlRequest\('\/api\/local\/capabilities'/u);
});
