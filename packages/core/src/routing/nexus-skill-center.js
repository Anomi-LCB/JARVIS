import { createHash } from 'node:crypto';
import { NEXUS_SKILL_CATALOG } from '../../../../skill-center/registry/catalog.js';
import { NEXUS_FRAGMENTS } from '../../../../skill-center/registry/fragments.js';
import { NEXUS_RECIPES } from '../../../../skill-center/registry/recipes.js';
import { NEXUS_PROFILES } from '../../../../skill-center/registry/profiles.js';
import { NEXUS_COMPATIBILITY } from '../../../../skill-center/registry/compatibility.js';
import { NEXUS_PROVIDER_PACKAGES } from '../../../../skill-center/registry/providers.js';

const DEFAULT_PROVIDER_INVENTORY = Object.freeze({
  'nexus-skill-center': 'ready',
  'jarvis-pc-agent': 'ready',
  'jarvis-mission-runtime': 'ready',
  'computer-use': 'ready',
  'codex-local': 'ready',
  'codex-tool-router': 'ready',
  'feature-ship': 'ready',
  'bug-hunt': 'ready',
  'browser-qa': 'ready',
  'browser-control': 'ready',
  'vercel-tooling': 'ready',
  'autonomous-router': 'ready',
  documents: 'ready',
  spreadsheets: 'ready',
  presentations: 'ready',
  'hwpx-plugin': 'ready',
  imagegen: 'ready',
  figma: 'ready',
  canva: 'ready',
  'theologia-nexus-operator': 'ready',
  'research-radar': 'ready',
  'google-drive': 'available-on-connection',
  notion: 'available-on-connection'
});

export class NexusSkillCenter {
  constructor({
    catalog = NEXUS_SKILL_CATALOG,
    fragments = NEXUS_FRAGMENTS,
    recipes = NEXUS_RECIPES,
    profiles = NEXUS_PROFILES,
    providerPackages = NEXUS_PROVIDER_PACKAGES,
    compatibility = NEXUS_COMPATIBILITY,
    providerInventory = DEFAULT_PROVIDER_INVENTORY,
    dependencyInventory = {},
    maxActive = compatibility.maxActiveSkills ?? 25,
    clock = () => new Date()
  } = {}) {
    this.catalog = indexUnique(catalog, 'skill');
    this.fragments = indexUnique(fragments, 'fragment');
    this.recipes = indexUnique(recipes, 'recipe');
    this.profiles = indexUnique(profiles, 'profile');
    this.providerPackages = indexUnique(providerPackages, 'provider-package');
    this.compatibility = compatibility;
    this.providerInventory = { ...providerInventory };
    this.dependencyInventory = { ...dependencyInventory };
    this.maxActive = Math.min(Math.max(Number(maxActive) || 25, 1), 25);
    this.clock = clock;
    this.activeProfileId = null;
    this.activeSkillIds = [];
    this.usage = new Map();

    const validation = this.validate();
    if (!validation.valid) {
      const error = new Error(`NEXUS Skill Center registry invalid: ${validation.errors.join(' | ')}`);
      error.code = 'A_NEXUS_SKILL_CENTER_INVALID';
      error.validation = validation;
      throw error;
    }
  }

  validate() {
    const errors = [];
    const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const [kind, entries] of [
      ['skill', this.catalog],
      ['fragment', this.fragments],
      ['recipe', this.recipes],
      ['profile', this.profiles],
      ['provider-package', this.providerPackages]
    ]) {
      for (const entry of entries.values()) {
        if (!namePattern.test(entry.id)) errors.push(`${kind}:${entry.id}:invalid-id`);
        if (!/^\d+\.\d+\.\d+$/.test(entry.version ?? '')) errors.push(`${kind}:${entry.id}:invalid-version`);
      }
    }

    for (const profile of this.profiles.values()) {
      if (profile.skillIds.length > Math.min(profile.maxActive ?? this.maxActive, this.maxActive)) {
        errors.push(`profile:${profile.id}:active-limit-exceeded`);
      }
      for (const skillId of profile.skillIds) {
        if (!this.catalog.has(skillId)) errors.push(`profile:${profile.id}:unknown-skill:${skillId}`);
      }
    }

    for (const recipe of this.recipes.values()) {
      for (const skillId of [...recipe.base, ...recipe.outputs]) {
        if (!this.catalog.has(skillId) && !this.profiles.has(skillId)) {
          errors.push(`recipe:${recipe.id}:unknown-skill:${skillId}`);
        }
      }
      for (const reviewerId of recipe.reviewers) {
        if (!this.catalog.has(reviewerId) && !this.fragments.has(reviewerId)) {
          errors.push(`recipe:${recipe.id}:unknown-reviewer:${reviewerId}`);
        }
      }
      for (const fragmentId of recipe.fragments) {
        if (!this.fragments.has(fragmentId) && !this.catalog.has(fragmentId)) {
          errors.push(`recipe:${recipe.id}:unknown-fragment:${fragmentId}`);
        }
      }
    }

    return {
      validationVersion: 'nexus-skill-center-validation-v1',
      valid: errors.length === 0,
      errors,
      counts: this.counts()
    };
  }

  counts() {
    return {
      skills: this.catalog.size,
      fragments: this.fragments.size,
      recipes: this.recipes.size,
      profiles: this.profiles.size,
      providers: Object.keys(this.providerInventory).length,
      providerPackages: this.providerPackages.size,
      inactiveProviderSkills: [...this.providerPackages.values()].reduce((total, provider) => total + provider.skillIds.length, 0)
    };
  }

  search(query, { limit = 20, category = null, includeMeta = true } = {}) {
    const tokens = tokenize(query);
    const normalizedQuery = normalizeText(query).trim();
    return [...this.catalog.values()]
      .filter((skill) => !category || skill.category === category)
      .filter((skill) => includeMeta || skill.kind !== 'meta-skill')
      .map((skill) => ({ skill, score: scoreSearch(skill, tokens, normalizedQuery) }))
      .filter((candidate) => tokens.length === 0 || candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, clamp(limit, 1, 100))
      .map(({ skill, score }) => ({
        ...skill,
        score,
        providerStatus: this.providerStatus(skill)
      }));
  }

  recommend(request, { profileId = null, limit = this.maxActive } = {}) {
    const profile = profileId
      ? this.profiles.get(profileId)
      : this.profileForRequest(request);
    if (!profile) {
      return {
        recommendationVersion: 'nexus-skill-recommendation-v1',
        profileId: null,
        skills: [],
        reason: 'profile-not-found'
      };
    }

    const profileSkills = profile.skillIds.map((id) => this.catalog.get(id)).filter(Boolean);
    const ranked = profileSkills
      .map((skill, index) => ({ skill, score: scoreSearch(skill, tokenize(request), normalizeText(request).trim()) + (profileSkills.length - index) / 100 }))
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
    const meta = profileSkills.filter((skill) => skill.kind === 'meta-skill');
    const selected = dedupeById([
      ...meta,
      ...ranked.map((candidate) => candidate.skill)
    ]).slice(0, Math.min(clamp(limit, 1, 25), profile.maxActive ?? 25, this.maxActive));

    return {
      recommendationVersion: 'nexus-skill-recommendation-v1',
      profileId: profile.id,
      profileVersion: profile.version,
      maxActive: this.maxActive,
      skills: selected.map((skill) => ({
        ...skill,
        providerStatus: this.providerStatus(skill)
      })),
      dependencyReport: this.dependencyReport(selected.map((skill) => skill.id)),
      security: this.securityAudit(selected.map((skill) => skill.id)),
      compatibility: this.conflictCheck(selected.map((skill) => skill.id))
    };
  }

  profileForRequest(request) {
    const normalized = normalizeText(request);
    const ranked = [...this.profiles.values()]
      .filter((profile) => profile.id !== 'full-lab')
      .map((profile) => ({
        profile,
        score: profile.triggers.reduce((total, trigger) => total + (normalized.includes(normalizeText(trigger)) ? 2 : 0), 0)
      }))
      .sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));
    return ranked[0]?.score > 0 ? ranked[0].profile : this.profiles.get('productivity') ?? ranked[0]?.profile ?? null;
  }

  activateProfile(profileId, { request = '', limit = this.maxActive } = {}) {
    const recommendation = this.recommend(request, { profileId, limit });
    if (!recommendation.profileId) {
      const error = new Error(`Unknown skill profile: ${profileId}`);
      error.code = 'A_NEXUS_PROFILE_NOT_FOUND';
      throw error;
    }
    this.activeProfileId = recommendation.profileId;
    this.activeSkillIds = recommendation.skills.map((skill) => skill.id);
    this.recordUsage({
      type: 'profile-activation',
      id: recommendation.profileId,
      skillIds: this.activeSkillIds,
      success: true
    });
    return {
      ...recommendation,
      activatedAt: this.clock().toISOString(),
      activeSkillCount: this.activeSkillIds.length
    };
  }

  deactivateProfile() {
    const previousProfileId = this.activeProfileId;
    const previousSkillIds = [...this.activeSkillIds];
    this.activeProfileId = null;
    this.activeSkillIds = [];
    this.recordUsage({
      type: 'profile-deactivation',
      id: previousProfileId ?? 'none',
      skillIds: previousSkillIds,
      success: true
    });
    return {
      deactivationVersion: 'nexus-profile-deactivation-v1',
      success: true,
      previousProfileId,
      deactivatedSkillCount: previousSkillIds.length,
      activeProfileId: null,
      activeSkillIds: [],
      activeSkillCount: 0,
      maxActive: this.maxActive,
      deactivatedAt: this.clock().toISOString()
    };
  }

  compose(recipeId, { additionalFragments = [], limit = this.maxActive } = {}) {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) {
      const error = new Error(`Unknown skill recipe: ${recipeId}`);
      error.code = 'A_NEXUS_RECIPE_NOT_FOUND';
      throw error;
    }
    const expandedBase = recipe.base.flatMap((id) => this.expandSkillOrProfile(id));
    const skillReviewerIds = recipe.reviewers.filter((id) => this.catalog.has(id));
    const fragmentReviewerIds = recipe.reviewers.filter((id) => this.fragments.has(id));
    const skillIds = dedupe([
      ...expandedBase,
      ...recipe.outputs,
      ...skillReviewerIds
    ]).filter((id) => this.catalog.has(id)).slice(0, Math.min(clamp(limit, 1, 25), this.maxActive));
    let fragmentIds = dedupe([...recipe.fragments, ...fragmentReviewerIds, ...additionalFragments]);
    const unknownFragments = fragmentIds.filter((id) => !this.fragments.has(id) && !this.catalog.has(id));
    if (unknownFragments.length > 0) {
      const error = new Error(`Unknown fragments: ${unknownFragments.join(', ')}`);
      error.code = 'A_NEXUS_FRAGMENT_NOT_FOUND';
      error.fragmentIds = unknownFragments;
      throw error;
    }
    const preflightSecurity = this.securityAudit(skillIds, fragmentIds);
    if (preflightSecurity.requiresApproval && !preflightSecurity.approvalFragmentPresent) {
      fragmentIds = dedupe([...fragmentIds, 'approval-gate']);
    }
    const manifestCore = {
      compositionVersion: 'nexus-composed-skill-v1',
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      skillIds,
      fragmentIds,
      maxActive: this.maxActive,
      dependencyReport: this.dependencyReport(skillIds),
      security: this.securityAudit(skillIds, fragmentIds),
      compatibility: this.conflictCheck(skillIds, fragmentIds)
    };
    const manifest = {
      ...manifestCore,
      compositionId: `composed_${sha256(canonicalJson(manifestCore)).slice(0, 16)}`,
      composedAt: this.clock().toISOString()
    };
    this.recordUsage({ type: 'recipe-composition', id: recipe.id, skillIds, success: true });
    return manifest;
  }

  expandSkillOrProfile(id) {
    if (this.catalog.has(id)) return [id];
    return this.profiles.get(id)?.skillIds ?? [];
  }

  dependencyReport(skillIds = []) {
    const items = dedupe(skillIds)
      .map((id) => this.catalog.get(id))
      .filter(Boolean)
      .flatMap((skill) => skill.dependencies.map((dependency) => ({
        skillId: skill.id,
        dependency,
        status: this.dependencyStatus(dependency)
      })));
    return {
      reportVersion: 'nexus-skill-dependency-report-v1',
      total: items.length,
      ready: items.filter((item) => item.status === 'ready').length,
      needsConfiguration: items.filter((item) => item.status !== 'ready').length,
      items
    };
  }

  dependencyStatus(dependency) {
    if (this.dependencyInventory[dependency]) return this.dependencyInventory[dependency];
    const [kind, name] = String(dependency).split(':', 2);
    if (kind === 'plugin') return this.providerInventory[name] === 'ready' || this.providerInventory[dependency] === 'ready' ? 'ready' : 'needs-install';
    if (kind === 'credential' || kind === 'connector') return 'needs-user-configuration';
    if (kind === 'app' || kind === 'cli' || kind === 'runtime') return 'needs-runtime-probe';
    return 'unknown';
  }

  providerStatus(skill) {
    const providers = skill.providers.map((id) => ({ id, status: this.providerInventory[id] ?? 'not-registered' }));
    return {
      ready: providers.some((provider) => provider.status === 'ready'),
      readinessBasis: 'routing-inventory',
      executionVerified: false,
      providers
    };
  }

  conflictCheck(skillIds = [], fragmentIds = []) {
    const selected = new Set(skillIds);
    const selectedFragments = new Set(fragmentIds);
    const findings = [];
    for (const rule of this.compatibility.conflictRules ?? []) {
      const matches = rule.members.filter((id) => selected.has(id));
      const triggered = rule.requiredFragments ? matches.length > 0 : matches.length === rule.members.length;
      if (!triggered) continue;
      const missingFragments = (rule.requiredFragments ?? []).filter((id) => !selectedFragments.has(id));
      if (rule.requiredFragments && missingFragments.length === 0) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        matchedSkillIds: matches,
        missingFragments,
        resolution: rule.resolution
      });
    }
    return {
      reportVersion: 'nexus-skill-conflict-report-v1',
      compatible: !findings.some((finding) => finding.severity === 'error'),
      requiresAttention: findings.length > 0,
      findings
    };
  }

  securityAudit(skillIds = [], fragmentIds = []) {
    const skills = dedupe(skillIds).map((id) => this.catalog.get(id)).filter(Boolean);
    const highRiskSkillIds = skills.filter((skill) => skill.risk.level === 'high').map((skill) => skill.id);
    const approvalSkillIds = skills.filter((skill) => skill.risk.requiresApproval).map((skill) => skill.id);
    const externalSideEffectSkillIds = skills.filter((skill) => skill.risk.externalSideEffect).map((skill) => skill.id);
    const approvalFragmentPresent = fragmentIds.some((id) => ['require-user-approval', 'approval-gate'].includes(id));
    return {
      auditVersion: 'nexus-skill-security-audit-v1',
      status: highRiskSkillIds.length > 0 && approvalSkillIds.length === 0 ? 'blocked' : 'guarded',
      requiresApproval: approvalSkillIds.length > 0 || externalSideEffectSkillIds.length > 0,
      approvalFragmentPresent,
      highRiskSkillIds,
      approvalSkillIds,
      externalSideEffectSkillIds,
      policy: '실제 변경·설치·외부 전송·계정 연결 직전에 승인합니다.'
    };
  }

  recordUsage({ type, id, skillIds = [], success = true }) {
    const key = `${type}:${id}`;
    const previous = this.usage.get(key) ?? { key, type, id, attempts: 0, successes: 0, failures: 0, skillIds: [] };
    const next = {
      ...previous,
      attempts: previous.attempts + 1,
      successes: previous.successes + (success ? 1 : 0),
      failures: previous.failures + (success ? 0 : 1),
      skillIds: dedupe([...previous.skillIds, ...skillIds]),
      lastUsedAt: this.clock().toISOString()
    };
    this.usage.set(key, next);
    return next;
  }

  usageAnalytics() {
    const records = [...this.usage.values()].sort((a, b) => b.attempts - a.attempts || a.key.localeCompare(b.key));
    return {
      analyticsVersion: 'nexus-skill-usage-analytics-v1',
      recordCount: records.length,
      totalAttempts: records.reduce((total, record) => total + record.attempts, 0),
      records
    };
  }

  librarianReport() {
    const normalized = new Map();
    const aliases = [];
    for (const skill of this.catalog.values()) {
      const key = skill.id.replace(/^(website-|sermon-)/, '').replace(/-(skill|builder|review)$/, '');
      const existing = normalized.get(key);
      if (existing) aliases.push({ canonicalId: existing, candidateId: skill.id });
      else normalized.set(key, skill.id);
    }
    return {
      reportVersion: 'nexus-skill-librarian-report-v1',
      duplicateIds: [],
      aliasCandidates: aliases,
      deprecated: [],
      catalogCount: this.catalog.size
    };
  }

  catalogView() {
    const skills = [...this.catalog.values()].map((skill) => ({
      ...skill,
      providerStatus: this.providerStatus(skill),
      dependencyReport: this.dependencyReport([skill.id])
    }));
    const categoryCounts = new Map();
    for (const skill of skills) {
      categoryCounts.set(skill.category, (categoryCounts.get(skill.category) ?? 0) + 1);
    }
    return {
      catalogVersion: 'nexus-skill-catalog-view-v1',
      counts: this.counts(),
      maxActive: this.maxActive,
      activeProfileId: this.activeProfileId,
      activeSkillIds: [...this.activeSkillIds],
      categories: [...categoryCounts.entries()].map(([id, count]) => ({ id, count })),
      skills,
      fragments: [...this.fragments.values()],
      recipes: [...this.recipes.values()],
      profiles: [...this.profiles.values()],
      providerPackages: [...this.providerPackages.values()].map((provider) => ({
        id: provider.id,
        version: provider.version,
        source: provider.source,
        sourceRef: provider.sourceRef,
        observedSourceCommit: provider.observedSourceCommit,
        sourceSnapshotDate: provider.sourceSnapshotDate,
        trust: provider.trust,
        activation: provider.activation,
        skillIds: [...provider.skillIds],
        skillCount: provider.skillIds.length
      })),
      validation: this.validate(),
      usage: this.usageAnalytics(),
      librarian: this.librarianReport(),
      snapshotDigest: this.snapshot().digest,
      generatedAt: this.clock().toISOString()
    };
  }

  snapshot() {
    const manifest = {
      schemaVersion: 'nexus-skill-center-snapshot-v1',
      counts: this.counts(),
      skills: [...this.catalog.values()].map((skill) => ({ id: skill.id, version: skill.version, category: skill.category })),
      fragments: [...this.fragments.values()].map((fragment) => ({ id: fragment.id, version: fragment.version })),
      recipes: [...this.recipes.values()].map((recipe) => ({ id: recipe.id, version: recipe.version })),
      profiles: [...this.profiles.values()].map((profile) => ({ id: profile.id, version: profile.version, skillIds: profile.skillIds }))
    };
    return {
      ...manifest,
      digest: sha256(canonicalJson(manifest))
    };
  }

  status() {
    const providerEntries = Object.entries(this.providerInventory);
    return {
      statusVersion: 'nexus-skill-center-status-v1',
      ready: true,
      counts: this.counts(),
      activeProfileId: this.activeProfileId,
      activeSkillIds: [...this.activeSkillIds],
      activeSkillCount: this.activeSkillIds.length,
      maxActive: this.maxActive,
      providers: {
        ready: providerEntries.filter(([, status]) => status === 'ready').length,
        configurable: providerEntries.filter(([, status]) => status !== 'ready').length,
        total: providerEntries.length
      },
      validation: this.validate(),
      snapshotDigest: this.snapshot().digest
    };
  }
}

function indexUnique(entries, kind) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (map.has(entry.id)) {
      const error = new Error(`Duplicate ${kind} id: ${entry.id}`);
      error.code = 'A_NEXUS_DUPLICATE_ID';
      throw error;
    }
    map.set(entry.id, entry);
  }
  return map;
}

function scoreSearch(skill, tokens, normalizedQuery = '') {
  if (tokens.length === 0) return 1;
  const id = normalizeText(skill.id);
  const category = normalizeText(skill.category);
  const tags = skill.tags.map(normalizeText);
  const exactBonus = normalizedQuery && id === normalizedQuery ? 100 : 0;
  return tokens.reduce((score, token) => {
    if (id === token) return score + 12;
    if (id.includes(token)) score += 7;
    if (category.includes(token)) score += 4;
    if (tags.some((tag) => tag === token)) score += 5;
    else if (tags.some((tag) => tag.includes(token))) score += 2;
    return score;
  }, exactBonus);
}

function tokenize(value) {
  return normalizeText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

function dedupe(values) {
  return [...new Set(values)];
}

function dedupeById(values) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || min, min), max);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
