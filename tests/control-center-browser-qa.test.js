import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Control Center browser QA is local-only, responsive, observable, and privacy-minimized', async () => {
  const [source, packageManifest] = await Promise.all([
    readFile(new URL('../scripts/control-center-browser-qa.py', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);

  assert.match(source, /ALLOWED_HOSTS\s*=\s*\{"127\.0\.0\.1", "localhost", "::1"\}/);
  assert.match(source, /parsed\.username or parsed\.password or parsed\.query or parsed\.fragment/);
  assert.match(source, /DESKTOP_VIEWPORT\s*=\s*\{"width": 1440, "height": 1000\}/);
  assert.match(source, /MOBILE_VIEWPORT\s*=\s*\{"width": 390, "height": 844\}/);
  for (const observation of ['consoleErrors', 'pageErrors', 'requestFailures', 'httpFailures']) {
    assert.equal(source.includes(`"${observation}"`), true);
  }
  assert.match(source, /horizontalOverflowPx/);
  assert.match(source, /clippedControls/);
  assert.match(source, /model_provider_snapshot/);
  assert.match(source, /model-provider-diagnostic-rendered/);
  assert.match(source, /apply_screenshot_redaction/);
  assert.match(source, /"screenshotContentRedacted": True/);
  assert.equal(packageManifest.scripts['ui:browser-qa'], 'python scripts/control-center-browser-qa.py');
});
