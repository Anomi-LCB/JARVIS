import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { NexusSkillCenter } from '../packages/core/src/routing/nexus-skill-center.js';
import { isLoopbackHttpUrl, resolveControlCenterNetwork } from '../packages/shared/src/control-center-hosting.js';
import { describeReadFailure } from '../src/ui/recovery.js';

const browserImport = "import { isLoopbackHttpUrl, resolveControlCenterNetwork } from '../../../packages/shared/src/control-center-hosting.js';";
const source = readFileSync(new URL('../src/ui/skill-center/skill-center.js', import.meta.url), 'utf8').replace(browserImport, '').replace("import { describeReadFailure } from '../recovery.js';", '');

async function createUi({ saved = '[]', origin = 'http://127.0.0.1:41730', offline = false, failStatus = false, malformed = false, delayStatus = false } = {}) {
  const center = new NexusSkillCenter();
  const app = { innerHTML: '', addEventListener() {}, querySelector() { return null; } };
  const toast = { textContent: '', className: '' };
  const storage = new Map([['jarvis.nexus.saved-recipes.v1', saved]]);
  const control = { offline, failStatus, malformed, storageDenied: false, calls: [], requestOptions: [] };
  const statusGate = delayStatus ? new Promise((resolve) => { control.releaseStatus = resolve; }) : null;
  const sandbox = createContext({
    isLoopbackHttpUrl,
    resolveControlCenterNetwork,
    describeReadFailure,
    location: { origin },
    AbortController,
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener() {},
    document: { querySelector: (selector) => selector === '#nexus-app' ? app : toast },
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem(key, value) {
        if (control.storageDenied) throw new Error('Quota exceeded');
        storage.set(key, value);
      }
    },
    async fetch(url, options) {
      control.calls.push(url);
      control.requestOptions.push(options);
      if (control.offline) throw new TypeError('Failed to fetch');
      if (statusGate && url.endsWith('/status')) await statusGate;
      if (control.failStatus && url.endsWith('/status')) throw new TypeError('Failed to fetch');
      if (control.malformed && url.endsWith('/catalog')) return { ok: true, json: async () => null };
      const body = options.body ? JSON.parse(options.body) : {};
      const payload = url.endsWith('/catalog') ? center.catalogView()
        : url.endsWith('/status') ? center.status()
          : url.endsWith('/compose') ? center.compose(body.recipeId, body)
            : url.endsWith('/activate') ? center.activateProfile(body.profileId, body)
              : center.deactivateProfile();
      return { ok: true, json: async () => payload };
    }
  });
  runInContext(`${source}\nglobalThis.qa = { state, loadCenter, activateProfile, composeRecipe, saveComposition, loadSavedRecipe, persistSavedRecipes, readSavedRecipes, filteredSkills, render };`, sandbox);
  await new Promise(setImmediate);
  return { qa: sandbox.qa, app, toast, storage, control };
}

test('Skill Center marks stale data offline, blocks mutations, and recovers on refresh', async () => {
  const { qa, app, control } = await createUi();
  assert.match(app.innerHTML, /runtime-indicator ready/);
  control.offline = true;
  await qa.loadCenter();
  assert.match(app.innerHTML, /role="alert"/);
  assert.match(app.innerHTML, /이전 조회 결과/);
  assert.doesNotMatch(app.innerHTML, /runtime-indicator ready/);
  assert.match(app.innerHTML, /data-activate-profile disabled/);
  const callCount = control.calls.length;
  await qa.activateProfile();
  await qa.composeRecipe();
  assert.equal(control.calls.length, callCount);
  control.offline = false;
  await qa.loadCenter();
  assert.match(app.innerHTML, /runtime-indicator ready/);
  assert.doesNotMatch(app.innerHTML, /role="alert"/);
});

test('First-load network failure gives actionable Korean recovery without raw error text', async () => {
  const { app, control, qa } = await createUi({ offline: true });
  assert.match(app.innerHTML, /<h1>NEXUS 스킬 센터/);
  assert.match(app.innerHTML, /CONNECTION_UNCONFIRMED/);
  assert.match(app.innerHTML, /로컬 네트워크 접근/);
  assert.doesNotMatch(app.innerHTML, /Failed to fetch/);
  control.offline = false;
  await qa.loadCenter();
  assert.match(app.innerHTML, /runtime-indicator ready/);
});

test('Status failure retains fresh catalog but prevents activation and composition', async () => {
  const { app, control, qa } = await createUi({ failStatus: true });
  assert.ok(qa.state.catalog.skills.length > 0);
  assert.equal(qa.state.status, null);
  assert.match(app.innerHTML, /읽기 전용/);
  assert.match(app.innerHTML, /data-activate-profile disabled/);
  const count = control.calls.length;
  await qa.activateProfile();
  await qa.composeRecipe();
  assert.equal(control.calls.length, count);
  control.failStatus = false;
  await Promise.all([qa.loadCenter(), qa.loadCenter(), qa.loadCenter()]);
  assert.equal(control.calls.length - count, 2);
  assert.match(app.innerHTML, /runtime-indicator ready/);
});

test('Malformed successful catalog response becomes a recoverable error', async () => {
  const { app } = await createUi({ malformed: true });
  assert.match(app.innerHTML, /INVALID_RESPONSE/);
  assert.match(app.innerHTML, /다시 확인/);
});

test('Catalog becomes readable before a slow status response completes', async () => {
  const { app, control, qa } = await createUi({ delayStatus: true });
  assert.equal(qa.state.loading, true);
  assert.ok(qa.state.catalog.skills.length > 0);
  assert.match(app.innerHTML, /스킬 레지스트리/);
  assert.match(app.innerHTML, /data-activate-profile disabled/);
  control.releaseStatus();
  await qa.loadCenter();
  assert.equal(control.calls.length, 2);
  assert.equal(qa.state.loading, false);
});

test('Skill Center shows unresolved dependencies even with a registered provider route', async () => {
  const { qa, app } = await createUi();
  qa.state.provider = 'configurable';
  const ids = qa.filteredSkills().map((skill) => skill.id);
  assert.ok(ids.includes('unity-prototype-builder'));
  assert.ok(ids.includes('zotero-research'));
  qa.state.selectedSkillId = 'unity-prototype-builder';
  qa.render();
  assert.match(app.innerHTML, /환경 점검 필요/);
  assert.match(app.innerHTML, /개별 작업에서 확인/);
  assert.doesNotMatch(app.innerHTML, /실행기 준비/);
});

test('Saved recipes survive reload and are recomposed through the approval-aware API', async () => {
  const { qa, storage } = await createUi();
  await qa.composeRecipe();
  qa.saveComposition();
  const saved = qa.state.savedRecipes[0];
  assert.ok(saved.fragmentIds.includes('approval-gate'));
  const reloaded = await createUi({ saved: storage.get('jarvis.nexus.saved-recipes.v1') });
  await reloaded.qa.loadSavedRecipe(saved.id);
  assert.equal(reloaded.qa.state.tab, 'recipes');
  assert.equal(reloaded.qa.state.composition.recipeId, saved.recipeId);
  assert.equal(reloaded.qa.state.composition.security.approvalFragmentPresent, true);
  assert.ok(reloaded.control.calls.some((url) => url.endsWith('/compose')));
  assert.equal(reloaded.qa.persistSavedRecipes([], 'removed'), true);
  assert.equal(reloaded.qa.readSavedRecipes().length, 0);
});

test('Storage failures do not invent saved recipes and malformed records do not crash rendering', async () => {
  const { qa, control, storage, toast } = await createUi({ saved: JSON.stringify([{ id: 'partial' }, null]) });
  assert.equal(qa.state.savedRecipes.length, 0);
  await qa.composeRecipe();
  control.storageDenied = true;
  qa.saveComposition();
  assert.equal(qa.state.savedRecipes.length, 0);
  assert.match(toast.className, /error/);
  assert.equal(JSON.parse(storage.get('jarvis.nexus.saved-recipes.v1')).length, 2);
});

test('Saved recipes with removed fragments cannot silently lose their original constraints', async () => {
  const record = { id: 'old', recipeId: 'ai-app-production', label: 'old', skillCount: 10, fragmentIds: ['removed-fragment'] };
  const { qa, control, toast } = await createUi({ saved: JSON.stringify([record]) });
  const count = control.calls.length;
  await qa.loadSavedRecipe('old');
  assert.equal(control.calls.length, count);
  assert.equal(qa.state.composition, null);
  assert.match(toast.className, /error/);
});

test('Safety fragments retain correct before and after meaning in Korean', async () => {
  const { qa, app } = await createUi();
  qa.state.tab = 'recipes';
  qa.render();
  assert.match(app.innerHTML, /변경 전 점검/);
  assert.match(app.innerHTML, /변경 후 검증/);
  assert.doesNotMatch(app.innerHTML, /점검 전 변경|후 변경 VERIFICATION|블로그 후/);
});

test('Hosted Skill Center uses only the trusted managed loopback bridge', async () => {
  const hosted = await createUi({ origin: 'https://jarvis-command-center.anomi-7.chatgpt.site' });
  assert.ok(hosted.control.calls.every((url) => url.startsWith('http://127.0.0.1:41730/api/core/skill-center/')));
  assert.ok(hosted.control.requestOptions.every((options) => options.targetAddressSpace === 'loopback'));
  const local = await createUi();
  assert.ok(local.control.calls.every((url) => url.startsWith('/api/core/skill-center/')));
  assert.ok(local.control.requestOptions.every((options) => !options.targetAddressSpace));
  const unknown = await createUi({ origin: 'https://attacker.example' });
  assert.ok(unknown.control.calls.every((url) => url.startsWith('/api/core/skill-center/')));
});
