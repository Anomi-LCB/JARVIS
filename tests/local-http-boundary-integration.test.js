import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { createCoreServer } from '../packages/core/src/main.mjs';
import { createPcAgentServer, PcAgentApiGuard } from '../apps/pc-agent/src/main.mjs';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

function requestJson({ port, path = '/health', headers = {} }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveRequest({
          statusCode: response.statusCode,
          payload: raw ? JSON.parse(raw) : null
        });
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

test('Core and PC Agent live listeners reject DNS rebinding and hostile browser origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-local-http-boundary-'));
  const runtime = createAgRuntime({
    allowedRoots: [root],
    auditRoot: root,
    env: { ...process.env, JARVIS_TEST_MODE: '1' }
  });
  const services = [
    {
      name: 'core',
      server: createCoreServer(runtime.coreFacade, {
        adminToken: 'boundary-core-token',
        trustKernel: runtime.trustKernel
      })
    },
    {
      name: 'pc-agent',
      server: createPcAgentServer(runtime.pcAgent, {
        apiGuard: new PcAgentApiGuard({
          apiToken: 'boundary-pc-token',
          tokenStorePath: join(root, 'pc-agent-api-token.json')
        })
      })
    }
  ];

  try {
    for (const service of services) {
      const address = await listenOnFetchSafePort(service.server);
      const localHost = `127.0.0.1:${address.port}`;

      const healthy = await requestJson({ port: address.port, headers: { host: localHost } });
      assert.equal(healthy.statusCode, 200, `${service.name} health should remain available`);
      assert.equal(healthy.payload.apiAuthentication.configured, true);
      assert.match(healthy.payload.apiAuthKeyId, /^sha256:[a-f0-9]{12}$/);

      const rebinding = await requestJson({
        port: address.port,
        headers: { host: 'attacker.example' }
      });
      assert.equal(rebinding.statusCode, 403, `${service.name} must reject a public Host header`);
      assert.equal(rebinding.payload.error.code, 'LOCAL_HTTP_BOUNDARY_DENIED');

      const hostileOrigin = await requestJson({
        port: address.port,
        headers: {
          host: localHost,
          origin: 'https://attacker.example'
        }
      });
      assert.equal(hostileOrigin.statusCode, 403, `${service.name} must reject a hostile Origin`);
      assert.equal(hostileOrigin.payload.reason, 'ORIGIN_NOT_LOOPBACK');

      const crossSite = await requestJson({
        port: address.port,
        headers: {
          host: localHost,
          origin: `http://${localHost}`,
          'sec-fetch-site': 'cross-site'
        }
      });
      assert.equal(crossSite.statusCode, 403, `${service.name} must reject cross-site browser requests`);
      assert.equal(crossSite.payload.reason, 'CROSS_SITE_BROWSER_REQUEST');

      await closeServer(service.server);
    }
  } finally {
    for (const service of services) {
      if (service.server.listening) await closeServer(service.server);
    }
    runtime.workerDaemon?.stop?.({ reason: 'test-complete' });
    await rm(root, { recursive: true, force: true });
  }
});
