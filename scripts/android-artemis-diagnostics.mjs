import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArtemisClient } from '../apps/pc-agent/src/adapters/android-artemis/artemis-client.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function diagnoseAndroidArtemis({ env = process.env, clientFactory = createArtemisClient } = {}) {
  const config = JSON.parse(await readFile(resolve(ROOT, 'config/artemis-integration.json'), 'utf8'));
  const client = clientFactory({
    baseUrl: env.JARVIS_ARTEMIS_BASE_URL ?? `http://${config.host}:${config.port}`,
    deviceSerial: env.JARVIS_ARTEMIS_DEVICE_SERIAL ?? ''
  });
  return {
    reportVersion: 'jarvis-android-artemis-diagnostics-v1', generatedAt: new Date().toISOString(),
    readiness: await client.readiness(),
    deviceActionRequested: false, modelCallRequested: false,
    workflowVerified: false, coreTaskRoutingActivated: false
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2 && (process.argv.length !== 4 || process.argv[2] !== '--output')) {
      throw new Error('Usage: npm run android:diagnose -- [--output report.json]');
    }
    const report = await diagnoseAndroidArtemis();
    const output = resolve(process.argv[3] ?? resolve(ROOT, '.runtime/artemis/diagnostics.json'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    if (!report.readiness.ready) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
