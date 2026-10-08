import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { protectWithWindowsDpapi, unprotectWithWindowsDpapi, hardenWindowsSecretFile } from '../../../shared/src/product-runtime-secrets.js';
import { acquireOwnedProcessLock } from '../../../shared/src/owned-process-lock.js';

const VERSION = 'jarvis-personal-profile-v1';
const MAX_BYTES = 96 * 1024;
const SCOPES = new Set(['general', 'theology', 'development', 'business', 'strategy']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function text(value, max = 3000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('A_PROFILE_INVALID_TEXT');
  return value.trim();
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(value)) fail('A_PROFILE_INVALID_ID');
  return value;
}
function list(value, max) {
  if (!Array.isArray(value) || value.length > max) fail('A_PROFILE_INVALID_LIST');
  return value;
}
function scope(value) { if (!SCOPES.has(value)) fail('A_PROFILE_INVALID_SCOPE'); return value; }

export function validatePersonalProfile(input) {
  if (!input || input.version !== 1 || input.source?.kind !== 'direct-user-statement' ||
      !Number.isFinite(Date.parse(input.source.receivedAt))) fail('A_PROFILE_INVALID_SOURCE');
  const profile = {
    version: 1, ownerUserId: id(input.ownerUserId),
    source: { kind: 'direct-user-statement', receivedAt: input.source.receivedAt },
    identity: {
      name: text(input.identity?.name, 200), birthYear: input.identity?.birthYear ?? null,
      country: text(input.identity?.country, 200),
      roles: list(input.identity?.roles, 20).map(value => text(value, 500)),
      family: text(input.identity?.family, 1000)
    },
    sections: list(input.sections, 32).map(section => ({
      id: id(section.id), scope: scope(section.scope), items: list(section.items, 40).map(value => text(value, 1500))
    })),
    goals: list(input.goals, 24).map(goal => ({ id: id(goal.id), scope: scope(goal.scope), title: text(goal.title, 200), detail: text(goal.detail) })),
    projects: list(input.projects, 24).map(project => ({
      id: id(project.id), scope: scope(project.scope), title: text(project.title, 200),
      description: text(project.description), state: 'user-declared-current-project'
    })),
    relations: list(input.relations, 100).map(relation => ({ from: id(relation.from), type: id(relation.type), to: id(relation.to) })),
    sourceDocument: text(input.sourceDocument, 30000)
  };
  if (profile.identity.birthYear !== null && (!Number.isInteger(profile.identity.birthYear) || profile.identity.birthYear < 1900 || profile.identity.birthYear > 2100)) fail('A_PROFILE_INVALID_BIRTH_YEAR');
  const ids = [profile.ownerUserId, ...profile.sections.map(value => value.id), ...profile.goals.map(value => value.id), ...profile.projects.map(value => value.id)];
  if (new Set(ids).size !== ids.length) fail('A_PROFILE_DUPLICATE_ID');
  if (profile.relations.some(relation => !ids.includes(relation.from) || !ids.includes(relation.to))) fail('A_PROFILE_UNKNOWN_RELATION');
  if (Buffer.byteLength(JSON.stringify(profile)) > MAX_BYTES) fail('A_PROFILE_TOO_LARGE');
  return profile;
}

export const defaultPersonalProfilePath = () => join(homedir(), '.jarvis', 'profile', 'owner.dpapi.json');

export class PersonalProfileStore {
  constructor({ path = defaultPersonalProfilePath(), protect = protectWithWindowsDpapi,
    unprotect = unprotectWithWindowsDpapi, harden = hardenWindowsSecretFile, clock = () => new Date().toISOString() } = {}) {
    Object.assign(this, { path, protect, unprotect, harden, clock });
    this.cached = null;
  }

  load() {
    if (!existsSync(this.path)) { this.cached = null; return null; }
    try {
      const stat = statSync(this.path);
      if (!stat.isFile() || stat.size > 512 * 1024) fail('A_PROFILE_STORE_INVALID');
      const encoded = readFileSync(this.path, 'utf8');
      const fingerprint = sha(encoded);
      if (this.cached?.fingerprint === fingerprint) return structuredClone(this.cached.value);
      const envelope = JSON.parse(encoded);
      if (envelope.version !== VERSION || envelope.provider !== 'windows-dpapi-current-user' ||
          envelope.encoding !== 'brotli-json-v1' || typeof envelope.protectedPayload !== 'string') fail('A_PROFILE_STORE_INVALID');
      const compressed = Buffer.from(this.unprotect(envelope.protectedPayload), 'base64');
      const body = brotliDecompressSync(compressed, { maxOutputLength: MAX_BYTES });
      const profile = validatePersonalProfile(JSON.parse(body.toString('utf8')));
      const revision = sha(JSON.stringify(canonical(profile)));
      if (envelope.revision !== revision) fail('A_PROFILE_STORE_INVALID');
      const value = { profile, revision, storedAt: envelope.storedAt };
      this.cached = { fingerprint, value };
      return structuredClone(value);
    } catch { this.cached = null; fail('A_PROFILE_STORE_UNREADABLE'); }
  }

  save(input, { expectedRevision = null } = {}) {
    const profile = validatePersonalProfile(input);
    const revision = sha(JSON.stringify(canonical(profile)));
    const lock = acquireOwnedProcessLock({ lockPath: `${this.path}.lock` });
    let temporary = null;
    try {
      const existing = this.load();
      if (existing?.revision === revision) return { saved: false, unchanged: true, revision };
      if (existing && existing.revision !== expectedRevision) fail('A_PROFILE_REVISION_CONFLICT');
      if (!existing && expectedRevision) fail('A_PROFILE_REVISION_CONFLICT');
      const compressed = brotliCompressSync(Buffer.from(JSON.stringify(profile))).toString('base64');
      const envelope = { version: VERSION, provider: 'windows-dpapi-current-user', encoding: 'brotli-json-v1',
        revision, storedAt: this.clock(), protectedPayload: this.protect(compressed) };
      mkdirSync(dirname(this.path), { recursive: true });
      temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(envelope), { flag: 'wx', mode: 0o600, flush: true });
      this.harden(temporary);
      // Validate the written encrypted candidate through the same read path before
      // either current state or its history can change. A provider can return
      // corrupt ciphertext without throwing from protect().
      const candidate = new PersonalProfileStore({ path: temporary, unprotect: this.unprotect }).load();
      if (candidate?.revision !== revision) fail('A_PROFILE_SAVE_UNVERIFIED');
      // Retain the exact previous encrypted revision before replacing current state.
      if (existing) {
        const historyDir = join(dirname(this.path), 'history');
        mkdirSync(historyDir, { recursive: true });
        const historical = join(historyDir, `${existing.revision}.dpapi.json`);
        if (!existsSync(historical)) {
          writeFileSync(historical, readFileSync(this.path), { flag: 'wx', mode: 0o600, flush: true });
          this.harden(historical);
        }
      }
      lock.assertOwned();
      renameSync(temporary, this.path);
      temporary = null;
      this.cached = null;
      if (this.load()?.revision !== revision) fail('A_PROFILE_SAVE_UNVERIFIED');
      return { saved: true, unchanged: false, revision, protectedByOs: true, rawProfileInRepository: false };
    } finally {
      if (temporary) { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      lock.release();
    }
  }

  status() {
    try {
      const value = this.load();
      return value ? { available: true, revision: value.revision, storedAt: value.storedAt,
        protectedByOs: true, sectionCount: value.profile.sections.length, goalCount: value.profile.goals.length,
        projectCount: value.profile.projects.length, relationCount: value.profile.relations.length,
        source: 'direct-user-statement', identityIncluded: false } : { available: false, reason: 'not-configured' };
    } catch { return { available: false, reason: 'store-unreadable' }; }
  }
}

function requestedWholePersonalCollections(command) {
  const collections = new Set();
  const owner = '(?:내(?:가\\s*(?:가진|세운|진행하는))?|나의|저의|제|사용자(?:의)?|본인(?:의)?|나(?:에\\s*대한|와\\s*관련된)?)';
  const modifiers = '(?:(?:장기|인생|개인|현재|진행\\s*중인)\\s*)*';
  const target = `${modifiers}(?:목표들?|프로젝트들?)`;
  const targets = `${target}(?:\\s*(?:와|과|및|하고|그리고|·|,|/|&)\\s*(?:(?:모든|전체)\\s*)?${target})?`;
  const boundary = '(?:^|[^\\p{L}\\p{N}_])';
  const patterns = [
    new RegExp(`${boundary}${owner}\\s*(?:모든|전체)\\s*(${targets})`, 'giu'),
    new RegExp(`${boundary}(?:모든|전체)\\s*${owner}\\s*(${targets})`, 'giu'),
    new RegExp(`${boundary}${owner}\\s*(${targets})\\s*(?:의\\s*)?(?:모두|전부|전체)`, 'giu'),
    /\b(?:all(?:\s+of)?\s+(?:my|the user's)|(?:my|the user's)\s+(?:entire|whole|all))\s+((?:(?:long[- ]term|personal|current|life|active)\s+)*(?:goals?|projects?)(?:\s*(?:and|,|&)\s*(?:(?:long[- ]term|personal|current|life|active)\s+)*(?:goals?|projects?))?)/giu
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      // Quantification of project files is not a request for the owner's whole
      // project history. A report explicitly saved to a file remains eligible.
      const following = command.slice(match.index + match[0].length);
      if (/^["'”’`]?\s*(?:의\s*|'s\s*)?(?:파일|폴더|디렉터리|경로|저장소|files?\b|folders?\b|director(?:y|ies)\b|paths?\b|repositor(?:y|ies)\b)/iu.test(following)) continue;
      if (/목표|goals?/iu.test(match[1])) collections.add('goals');
      if (/프로젝트|projects?/iu.test(match[1])) collections.add('projects');
    }
  }
  return collections;
}

export function projectPersonalContext(value, { rawText = '', userId, includeRelations = false } = {}) {
  if (!value || !userId || userId !== value.profile.ownerUserId) return null;
  const command = String(rawText).slice(0, 30000);
  const wholeCollections = requestedWholePersonalCollections(command);
  const scopes = new Set(['general']);
  if (/성경|설교|신학|교회|목회|목양|복음|개혁주의|칼빈|주석|본문\s*(?:해석|연구)|히브리|헬라|theolog|sermon|bibl/iu.test(command)) scopes.add('theology');
  if (/개발|코딩|프로그램|소프트웨어|자동화|플랫폼|에이전트|인터페이스|웹|앱|자비스|\b(?:ai|llm|agent|codex|code|app|jarvis)\b/iu.test(command)) scopes.add('development');
  if (/사업|비즈니스|수익|자산|부동산|건축|투자|business/iu.test(command)) scopes.add('business');
  if (wholeCollections.size || /장기|인생|목표|전략|프로젝트|우선순위|제\s*2의?\s*두뇌|second\s*brain/iu.test(command)) scopes.add('strategy');
  const sections = value.profile.sections.filter(section => scopes.has(section.scope));
  const goals = value.profile.goals.filter(goal => wholeCollections.has('goals') || scopes.has(goal.scope));
  const projects = value.profile.projects.filter(project => wholeCollections.has('projects') || scopes.has(project.scope) || command.toLowerCase().includes(project.title.toLowerCase()));
  const ownerRef='profile-owner:'+sha('owner:'+value.profile.ownerUserId);
  const relationIds=new Set([value.profile.ownerUserId,...goals.map(item=>item.id),...projects.map(item=>item.id)]);
  const relations=(value.profile.relations??[]).filter(item=>relationIds.has(item.from)&&relationIds.has(item.to))
    .map(item=>({from:item.from===value.profile.ownerUserId?ownerRef:item.from,
      type:item.type,to:item.to===value.profile.ownerUserId?ownerRef:item.to}));
  return { version: 'jarvis-personal-context-v1', profileRevision: value.revision,
    ...(value.profile.source?.kind === 'direct-user-statement' && typeof value.profile.source.receivedAt === 'string'
      && Number.isFinite(Date.parse(value.profile.source.receivedAt)) ? {provenance:{
        sourceKind:'direct-user-statement', observedAt:value.profile.source.receivedAt,
        profileRevision:value.revision, validity:{validUntil:null,basis:'unspecified'},
        revisionHistory:typeof value.storedAt==='string' && Number.isFinite(Date.parse(value.storedAt))
          ? [{action:'store-profile-revision',at:value.storedAt}] : [],
        historyMode:'current-revision-reference',
        usageScope:{ownerScopeRef:sha('owner:'+value.profile.ownerUserId),sectionIds:sections.map(section=>section.id)},
        executionAuthority:false,independentlyVerifiedOutcome:false
      }} : {}),
    sectionIds: sections.map(section => section.id), preferences: sections.map(({ id, items }) => ({ id, items })),
    goals: goals.map(({ id, title, detail }) => ({ id, title, detail })),
    projects: projects.map(({ id, title, description }) => ({ id, title, description })),
    ...(includeRelations && relations.length?{relations}:{}),
    authority: 'advisory-user-context' };
}

export function createPersonalContextProvider({ env = process.env, store = null } = {}) {
  if (env.JARVIS_PERSONAL_PROFILE_ENABLED === '0' || env.JARVIS_TEST_MODE === '1' && !store) return () => null;
  const profileStore = store ?? new PersonalProfileStore({ path: env.JARVIS_PERSONAL_PROFILE_PATH ?? defaultPersonalProfilePath() });
  return request => {
    try { return projectPersonalContext(profileStore.load(), request); }
    catch { return null; }
  };
}
