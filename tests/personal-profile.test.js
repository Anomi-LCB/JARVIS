import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PersonalProfileStore, createPersonalContextProvider, projectPersonalContext, validatePersonalProfile } from '../packages/core/src/personal-operations/personal-profile.js';

const now = '2026-09-14T01:00:00.000Z';

// Fictional data and an injected test cipher: these tests do not exercise Windows DPAPI.
function profile() {
  return {
    version: 1, ownerUserId: 'fixture-owner',
    source: { kind: 'direct-user-statement', receivedAt: now },
    identity: { name: '가상 사용자 루미', birthYear: 1988, country: '테스트 국가', roles: ['테스트 연구자'], family: '가상 가족 정보' },
    sections: [
      { id: 'communication', scope: 'general', items: ['결론을 먼저 제시한다.', '근거가 부족하면 구별한다.'] },
      { id: 'text-study', scope: 'theology', items: ['원문과 여러 해석을 비교한다.'] },
      { id: 'engineering', scope: 'development', items: ['실행 가능한 작은 변경을 검증한다.'] },
      { id: 'commerce', scope: 'business', items: ['수입과 비용을 구별한다.'] },
      { id: 'planning', scope: 'strategy', items: ['장기 목표와 우선순위를 비교한다.'] }
    ],
    goals: [
      { id: 'text-goal', scope: 'theology', title: '문헌 연구 개선', detail: '출처를 확인한 해석을 축적한다.' },
      { id: 'build-goal', scope: 'development', title: '도구 제작', detail: '반복 작업에 유용한 프로그램을 만든다.' },
      { id: 'plan-goal', scope: 'strategy', title: '분기별 목표', detail: '목표와 진행 결과를 비교한다.' }
    ],
    projects: [
      { id: 'text-project', scope: 'theology', title: '가상 문헌실', description: '문헌 비교를 위한 테스트 프로젝트' },
      { id: 'build-project', scope: 'development', title: 'Orchid Lab', description: '자동화 프로그램 테스트 프로젝트' }
    ],
    relations: [{ from: 'fixture-owner', type: 'pursues', to: 'text-goal' }, { from: 'text-project', type: 'supports', to: 'text-goal' }],
    sourceDocument: '이 문장은 테스트만을 위해 만든 가상의 원본 자기소개입니다.'
  };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-profile-test-'));
  const path = join(directory, 'profile', 'fixture.dpapi.json');
  const key = randomBytes(32);
  const calls = { protect: 0, unprotect: 0, harden: [] };
  const crypto = {
    protect(value) {
      calls.protect++;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
    },
    unprotect(value) {
      calls.unprotect++;
      const encoded = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12));
      decipher.setAuthTag(encoded.subarray(-16));
      return Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
    harden(file) { calls.harden.push(file); }
  };
  t.after(() => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('jarvis-profile-test-'));
    assert.equal(target, directory);
    rmSync(target, { recursive: true, force: true });
  });
  return { directory, path, calls, open: (overrides = {}) => new PersonalProfileStore({ path, ...crypto, clock: () => now, ...overrides }) };
}

test('personal profile restores the same structured data and revision through a new store instance', t => {
  const f = fixture(t);
  const original = profile();
  const saved = f.open().save(original);
  assert.equal(saved.saved, true);
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  const restored = f.open().load();
  assert.equal(restored.revision, saved.revision);
  assert.equal(restored.storedAt, now);
  assert.deepEqual(restored.profile, validatePersonalProfile(original));
  const storedText = readFileSync(f.path, 'utf8');
  for (const secret of [original.identity.name, original.identity.family, original.sourceDocument, original.sections[0].items[0]]) {
    assert.equal(storedText.includes(secret), false);
  }
  assert.equal(f.calls.protect, 1);
  assert.equal(f.calls.harden.length, 1);
});

test('identical profile saves are idempotent across instances and preserve the encrypted file', t => {
  const f = fixture(t);
  const first = f.open().save(profile());
  const before = readFileSync(f.path);
  const duplicate = f.open().save(profile());
  assert.deepEqual(duplicate, { saved: false, unchanged: true, revision: first.revision });
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(f.calls.protect, 1);
  assert.deepEqual(readdirSync(dirname(f.path)), [basename(f.path)]);
});

test('a stale revision cannot overwrite a later profile and its lock is released after rejection', t => {
  const f = fixture(t);
  const store = f.open();
  const first = store.save(profile());
  const next = profile();
  next.sections[0].items.push('새로 확인한 선호');
  const second = store.save(next, { expectedRevision: first.revision });
  const third = profile();
  third.sections[0].items.push('다른 창에서 작성한 선호');
  assert.throws(() => f.open().save(third, { expectedRevision: first.revision }), { code: 'A_PROFILE_REVISION_CONFLICT' });
  assert.equal(store.load().revision, second.revision);
  assert.deepEqual(store.load().profile.sections[0].items, next.sections[0].items);
  assert.equal(f.open().save(third, { expectedRevision: second.revision }).saved, true);
});

test('an update requires the current revision and a missing file rejects an expected old revision', t => {
  const f = fixture(t);
  assert.throws(() => f.open().save(profile(), { expectedRevision: 'missing-revision' }), { code: 'A_PROFILE_REVISION_CONFLICT' });
  f.open().save(profile());
  const changed = profile();
  changed.identity.roles.push('가상 기획자');
  assert.throws(() => f.open().save(changed), { code: 'A_PROFILE_REVISION_CONFLICT' });
});

test('encryption and file-hardening failures preserve the current profile and release the writer lock', t => {
  const f = fixture(t);
  const original = f.open().save(profile());
  const before = readFileSync(f.path);
  const changed = profile();
  changed.identity.roles.push('가상 편집자');
  for (const failure of ['protect', 'harden']) {
    const failing = f.open({ [failure]() { throw Object.assign(new Error('injected provider failure'), { code: 'FIXTURE_PROVIDER_FAILED' }); } });
    assert.throws(() => failing.save(changed, { expectedRevision: original.revision }), { code: 'FIXTURE_PROVIDER_FAILED' });
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(readdirSync(dirname(f.path)), [basename(f.path)]);
  }
  assert.equal(f.open().save(changed, { expectedRevision: original.revision }).saved, true);
});

test('invalid or mismatched ciphertext returned without an exception never replaces the verified profile', t => {
  const f = fixture(t);
  const original = f.open().save(profile());
  const before = readFileSync(f.path);
  const earlierCiphertext = JSON.parse(before.toString('utf8')).protectedPayload;
  const changed = profile();
  changed.sections[0].items.push('검사용 새 선호');
  for (const protectedPayload of [Buffer.alloc(64).toString('base64'), earlierCiphertext]) {
    const failing = f.open({ protect: () => protectedPayload });
    assert.throws(() => failing.save(changed, { expectedRevision: original.revision }), { code: 'A_PROFILE_STORE_UNREADABLE' });
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(readdirSync(dirname(f.path)), [basename(f.path)], 'no new history, temporary file or writer lock remains');
    assert.equal(f.open().load().revision, original.revision);
  }
  assert.equal(f.open().save(changed, { expectedRevision: original.revision }).saved, true);
});

test('updates retain the exact earlier encrypted revision and can restore that historical file', t => {
  const f = fixture(t);
  const first = f.open().save(profile());
  const before = readFileSync(f.path);
  const changed = profile();
  changed.goals[0].detail = '검증 결과에 맞게 수정한 목표';
  f.open().save(changed, { expectedRevision: first.revision });
  const historyPath = join(dirname(f.path), 'history', `${first.revision}.dpapi.json`);
  assert.deepEqual(readFileSync(historyPath), before);
  assert.ok(f.calls.harden.includes(historyPath));
  const current = readFileSync(f.path);
  writeFileSync(f.path, readFileSync(historyPath));
  assert.equal(f.open().load().revision, first.revision);
  writeFileSync(f.path, current);
  assert.equal(f.open().load().profile.goals[0].detail, changed.goals[0].detail);
});

test('cached loaded objects are detached from callers and cannot be modified through a returned reference', t => {
  const f = fixture(t);
  const store = f.open();
  store.save(profile());
  const first = store.load();
  first.profile.sections[0].items[0] = '오염된 캐시';
  first.profile.identity.name = '다른 이름';
  assert.deepEqual(store.load().profile, validatePersonalProfile(profile()));
});

test('tampered ciphertext never falls back to a previously valid cache', t => {
  const f = fixture(t);
  const store = f.open();
  store.save(profile());
  store.load();
  const original = readFileSync(f.path);
  const envelope = JSON.parse(original);
  const bytes = Buffer.from(envelope.protectedPayload, 'base64');
  bytes[20] ^= 1;
  envelope.protectedPayload = bytes.toString('base64');
  writeFileSync(f.path, JSON.stringify(envelope));
  assert.throws(() => store.load(), { code: 'A_PROFILE_STORE_UNREADABLE' });
  assert.deepEqual(store.status(), { available: false, reason: 'store-unreadable' });
  writeFileSync(f.path, original);
  assert.equal(store.load().profile.ownerUserId, 'fixture-owner');
});

test('an altered revision or corrupt JSON is rejected after a successful read', t => {
  const f = fixture(t);
  const store = f.open();
  store.save(profile());
  const envelope = JSON.parse(readFileSync(f.path, 'utf8'));
  envelope.revision = '0'.repeat(64);
  writeFileSync(f.path, JSON.stringify(envelope));
  assert.throws(() => store.load(), { code: 'A_PROFILE_STORE_UNREADABLE' });
  writeFileSync(f.path, '{broken-json');
  assert.throws(() => store.load(), { code: 'A_PROFILE_STORE_UNREADABLE' });
});

test('deleted files clear the cache and a replacement becomes visible to an existing provider', t => {
  const f = fixture(t);
  const store = f.open();
  store.save(profile());
  const provider = createPersonalContextProvider({ env: {}, store });
  const request = { userId: 'fixture-owner', rawText: '설교 본문 연구' };
  assert.ok(provider(request));
  unlinkSync(f.path);
  assert.equal(store.load(), null);
  assert.equal(provider(request), null);
  const changed = profile();
  changed.sections[1].items.push('추가한 원문 검증 기준');
  f.open().save(changed);
  assert.deepEqual(provider(request).preferences.find(item => item.id === 'text-study').items, changed.sections[1].items);
});

test('projection selects relevant preferences while excluding identity, original document, and relationship records', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  const context = projectPersonalContext(value, { userId: 'fixture-owner', rawText: '성경 본문과 경쟁 해석을 조사해줘' });
  assert.deepEqual(context.sectionIds, ['communication', 'text-study']);
  assert.deepEqual(context.goals.map(item => item.id), ['text-goal']);
  assert.deepEqual(context.projects.map(item => item.id), ['text-project']);
  assert.equal(context.authority, 'advisory-user-context');
  for (const forbidden of ['identity', 'sourceDocument', 'source', 'relations', 'ownerUserId']) assert.equal(forbidden in context, false);
  for (const secret of [value.profile.identity.name, value.profile.identity.family, value.profile.sourceDocument]) {
    assert.equal(JSON.stringify(context).includes(secret), false);
  }
});

test('development, commerce and strategy requests receive their own declared preferences', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  for (const [rawText, expected] of [
    ['프로그램 코딩 도와줘', ['communication', 'engineering']],
    ['사업 수입과 비용 분석해줘', ['communication', 'commerce']],
    ['장기 목표 우선순위 정리해줘', ['communication', 'planning']],
    ['안녕하세요', ['communication']]
  ]) {
    assert.deepEqual(projectPersonalContext(value, { userId: 'fixture-owner', rawText }).sectionIds, expected);
  }
});

test('a named project is included without importing all preferences from its domain', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  const context = projectPersonalContext(value, { userId: 'fixture-owner', rawText: 'orchid lab 상황을 알려줘' });
  assert.deepEqual(context.sectionIds, ['communication']);
  assert.deepEqual(context.projects.map(item => item.id), ['build-project']);
});

test('explicit whole personal goal and project reviews span domains without adding identity or every domain preference', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  for (const rawText of [
    '나의 모든 장기 목표와 프로젝트를 정리해 줘',
    '내 전체 목표 및 프로젝트를 비교해줘',
    '사용자의 목표와 프로젝트 전체를 회고해줘',
    '나의 모든 목표·프로젝트를 정리해줘',
    '내가 가진 모든 목표와 프로젝트를 정리해서 파일로 저장해줘',
    'Review all of my long-term goals and current projects.',
    'Summarize my entire goals and projects.'
  ]) {
    const context = projectPersonalContext(value, { userId: 'fixture-owner', rawText });
    assert.deepEqual(context.goals.map(item => item.id), value.profile.goals.map(item => item.id), rawText);
    assert.deepEqual(context.projects.map(item => item.id), value.profile.projects.map(item => item.id), rawText);
    assert.deepEqual(context.sectionIds, ['communication', 'planning'], rawText);
    for (const forbidden of ['identity', 'sourceDocument', 'relations']) assert.equal(forbidden in context, false);
  }
});

test('whole personal collection requests expand only the requested collection', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  const goals = projectPersonalContext(value, { userId: 'fixture-owner', rawText: '나의 모든 장기 목표를 정리해줘' });
  assert.deepEqual(goals.goals.map(item => item.id), ['text-goal', 'build-goal', 'plan-goal']);
  assert.deepEqual(goals.projects, []);
  const projects = projectPersonalContext(value, { userId: 'fixture-owner', rawText: 'Review all my projects.' });
  assert.deepEqual(projects.projects.map(item => item.id), ['text-project', 'build-project']);
  assert.deepEqual(projects.goals.map(item => item.id), ['plan-goal']);
});

test('file inventories and domain-limited requests do not expand into all personal collections', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  for (const rawText of [
    '전체 프로젝트 파일 목록을 보여줘',
    '내 모든 프로젝트 파일 목록을 보여줘',
    '내 프로젝트의 모든 파일을 찾아줘',
    '나의 프로젝트 전체 파일을 검색해줘',
    '내 전체 프로젝트 저장소를 열어줘',
    'List all my project files.',
    'Find my entire project directory.'
  ]) {
    const context = projectPersonalContext(value, { userId: 'fixture-owner', rawText });
    assert.equal(context.goals.some(item => item.id === 'text-goal'), false, rawText);
    assert.equal(context.projects.some(item => item.id === 'text-project'), false, rawText);
  }
  const engineering = projectPersonalContext(value, { userId: 'fixture-owner', rawText: '내 모든 개발 프로젝트를 정리해줘' });
  assert.deepEqual(engineering.projects.map(item => item.id), ['build-project']);
});

test('unknown, missing and different user identities never receive the owner context', () => {
  const value = { profile: validatePersonalProfile(profile()), revision: 'fixture-revision' };
  for (const userId of [undefined, '', 'someone-else', 'FIXTURE-OWNER']) {
    assert.equal(projectPersonalContext(value, { userId, rawText: '설교와 프로그램 계획' }), null);
  }
  assert.equal(projectPersonalContext(null, { userId: 'fixture-owner' }), null);
});

test('test mode returns before inspecting any default or environment-selected personal file', () => {
  const env = { JARVIS_TEST_MODE: '1' };
  Object.defineProperty(env, 'JARVIS_PERSONAL_PROFILE_PATH', { get() { assert.fail('test mode must not resolve a personal profile path'); } });
  const provider = createPersonalContextProvider({ env });
  assert.equal(provider({ userId: 'fixture-owner', rawText: '설교 연구' }), null);
});

test('test mode can use an explicitly injected fixture store, while disabled mode never loads it', t => {
  const f = fixture(t);
  const store = f.open();
  store.save(profile());
  assert.ok(createPersonalContextProvider({ env: { JARVIS_TEST_MODE: '1' }, store })({ userId: 'fixture-owner', rawText: '설교' }));
  const disabled = createPersonalContextProvider({ env: { JARVIS_PERSONAL_PROFILE_ENABLED: '0' }, store: { load() { assert.fail('disabled provider must not load'); } } });
  assert.equal(disabled({ userId: 'fixture-owner' }), null);
});

test('a broken store is excluded from generated context without throwing into the command path', () => {
  const provider = createPersonalContextProvider({ env: {}, store: { load() { throw new Error('fixture unreadable'); } } });
  assert.equal(provider({ userId: 'fixture-owner', rawText: '설교' }), null);
});

test('oversized profile content is rejected before encryption or filesystem writes', t => {
  const f = fixture(t);
  const oversized = profile();
  oversized.sections = Array.from({ length: 3 }, (_, index) => ({ id: `large-${index}`, scope: 'general', items: Array(40).fill('가'.repeat(1000)) }));
  assert.throws(() => f.open().save(oversized), { code: 'A_PROFILE_TOO_LARGE' });
  assert.equal(f.calls.protect, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test('oversized encrypted files are refused before the injected decryptor is called', t => {
  const f = fixture(t);
  const store = f.open();
  store.save(profile());
  const before = f.calls.unprotect;
  writeFileSync(f.path, ' '.repeat(512 * 1024 + 1));
  assert.throws(() => store.load(), { code: 'A_PROFILE_STORE_UNREADABLE' });
  assert.equal(f.calls.unprotect, before);
});

test('profile validation rejects untrusted source types, duplicate IDs and dangling relations', () => {
  const invalidSource = profile();
  invalidSource.source.kind = 'retrieved-web-content';
  assert.throws(() => validatePersonalProfile(invalidSource), { code: 'A_PROFILE_INVALID_SOURCE' });
  const duplicate = profile();
  duplicate.goals[0].id = duplicate.ownerUserId;
  assert.throws(() => validatePersonalProfile(duplicate), { code: 'A_PROFILE_DUPLICATE_ID' });
  const dangling = profile();
  dangling.relations[0].to = 'unknown-goal';
  assert.throws(() => validatePersonalProfile(dangling), { code: 'A_PROFILE_UNKNOWN_RELATION' });
});
