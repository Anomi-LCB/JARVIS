import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreServer, createCoreOpenApiSpec } from '../packages/core/src/main.mjs';
import { NexusSkillCenter } from '../packages/core/src/routing/nexus-skill-center.js';
import { NEXUS_SKILL_IDS } from '../skill-center/registry/catalog.js';
import { NEXUS_FRAGMENTS } from '../skill-center/registry/fragments.js';
import { NEXUS_RECIPES } from '../skill-center/registry/recipes.js';
import { NEXUS_PROFILES } from '../skill-center/registry/profiles.js';
import { NEXUS_STRUCTURAL_TERMS } from '../skill-center/registry/source-coverage.js';
import { listenOnFetchSafePort } from '../packages/shared/src/http.js';

const attachmentCapabilityNames = [
  'skill-center-router', 'skill-search', 'skill-composer', 'skill-profile-manager',
  'skill-dependency-resolver', 'skill-conflict-checker', 'skill-validator',
  'skill-trigger-tester', 'skill-behavior-tester', 'skill-version-manager',
  'skill-librarian', 'skill-usage-analytics', 'skill-plugin-builder',
  'skill-security-auditor', 'skill-improver',
  'windows-system-audit', 'installed-app-inventory', 'appx-package-audit',
  'winget-package-manager', 'startup-app-audit', 'service-health-audit',
  'scheduled-task-audit', 'eventlog-diagnose', 'registry-safe-edit',
  'restore-point-manager', 'driver-health-audit', 'nvidia-cuda-diagnose',
  'wsl-health-manager', 'docker-desktop-diagnose', 'network-diagnose',
  'storage-cleanup-planner', 'duplicate-file-finder', 'configuration-backup',
  'windows-ui-automation', 'pc-performance-baseline',
  'project-bootstrap', 'codebase-map', 'architecture-review', 'requirements-to-spec',
  'implementation-planner', 'bug-triage', 'root-cause-analysis', 'test-generator',
  'test-failure-debugger', 'refactor-planner', 'dependency-audit',
  'performance-profiler', 'security-review', 'api-contract-review',
  'database-schema-review', 'migration-planner', 'git-commit-manager',
  'github-pr-manager', 'ci-failure-repair', 'release-manager',
  'deployment-verifier', 'documentation-sync', 'react-quality-review',
  'nextjs-architecture', 'production-readiness-review',
  'website-full-audit', 'ux-flow-review', 'information-architecture',
  'design-system-builder', 'responsive-layout-audit', 'accessibility-audit',
  'playwright-e2e', 'chrome-devtools-debug', 'performance-budget',
  'seo-technical-audit', 'analytics-design', 'conversion-flow-review',
  'error-state-review', 'onboarding-review', 'payment-flow-review',
  'mobile-experience-review', 'visual-regression-check', 'production-site-verification',
  'model-selector', 'prompt-architect', 'agent-harness-builder', 'mcp-discovery',
  'mcp-installer', 'mcp-config-manager', 'mcp-permission-audit',
  'tool-routing-optimizer', 'local-llm-setup', 'ollama-manager',
  'openrouter-manager', 'rag-pipeline-builder', 'embedding-pipeline',
  'agent-memory-design', 'eval-suite-builder', 'token-cost-optimizer',
  'guardrail-review', 'multi-agent-workflow-design',
  'document-editor', 'spreadsheet-modeler', 'presentation-builder', 'pdf-pipeline',
  'hwp-hwpx-pipeline', 'markitdown-ingest', 'ocr-document-cleaner',
  'data-cleaning', 'data-validation', 'chart-builder', 'citation-manager',
  'zotero-research', 'meeting-minutes', 'template-filler',
  'form-document-builder', 'report-generator', 'knowledge-capture',
  'document-quality-review',
  'image-prompt-architect', 'image-editor', 'brand-system-builder',
  'thumbnail-designer', 'card-news-builder', 'infographic-builder',
  'poster-designer', 'figma-design-builder', 'canva-bulk-create',
  'ffmpeg-video-pipeline', 'audio-mastering', 'subtitle-generator',
  'shortform-converter', 'character-consistency', 'scene-continuity-review',
  'storyboard-builder', 'blender-scene-builder', 'unity-prototype-builder',
  'scripture-retrieval', 'bible-translation-compare', 'parallel-passage-analysis',
  'original-language-analysis', 'hebrew-word-study', 'greek-word-study',
  'textual-variant-review', 'historical-context-research',
  'ancient-near-east-context', 'second-temple-literature',
  'patristic-source-research', 'reformation-source-research',
  'reformed-theology-review', 'opposing-view-comparison', 'canonical-theology',
  'biblical-theology', 'systematic-theology', 'exegesis-builder',
  'sermon-big-idea', 'sermon-structure', 'sermon-introduction',
  'sermon-application', 'sermon-illustration', 'sermon-tone-editor',
  'theological-consistency-review', 'bible-citation-audit',
  'sermon-multichannel', 'bulletin-writer', 'small-group-workbook',
  'pastoral-care-response', 'worship-order-builder', 'church-event-planner',
  'parent-ministry-content', 'newlywed-ministry-content'
];

test('NEXUS registers every explicitly catalogued skill without overloading active profiles', () => {
  const center = new NexusSkillCenter();
  const status = center.status();

  assert.equal(status.ready, true);
  assert.equal(status.validation.valid, true);
  assert.equal(status.counts.skills, 187);
  assert.equal(status.counts.fragments, 27);
  assert.equal(status.counts.recipes, 5);
  assert.equal(status.counts.profiles, 10);
  assert.equal(new Set(NEXUS_SKILL_IDS).size, NEXUS_SKILL_IDS.length);
  for (const id of attachmentCapabilityNames) assert.ok(center.catalog.has(id), `missing attachment skill: ${id}`);
  for (const skill of center.catalog.values()) {
    assert.ok(skill.contract.workflow.length >= 4, `${skill.id} is missing an operational workflow contract`);
    assert.ok(skill.contract.evidence.length >= 3, `${skill.id} is missing evidence requirements`);
    assert.ok(skill.contract.fallback, `${skill.id} is missing a failure fallback`);
  }
  for (const profile of NEXUS_PROFILES) {
    assert.ok(profile.skillIds.length >= 12, `${profile.id} is too small for the recommended profile range`);
    assert.ok(profile.skillIds.length <= 25, `${profile.id} exceeds the context-safe active limit`);
  }
});

test('NEXUS source terms are either implemented units or explicitly classified structure', () => {
  const implemented = new Set([
    ...NEXUS_SKILL_IDS,
    ...NEXUS_FRAGMENTS.map((item) => item.id),
    ...NEXUS_RECIPES.map((item) => item.id),
    ...NEXUS_PROFILES.map((item) => item.id),
    ...NEXUS_STRUCTURAL_TERMS.map((item) => item.id)
  ]);
  const representativeSourceTerms = [
    ...attachmentCapabilityNames,
    'windows-safe-optimization', 'ai-app-production', 'church-event-package',
    'audit-before-change', 'require-user-approval', 'cite-primary-sources',
    'reformed-theology-filter', 'original-language-layer', 'korean-pastoral-tone',
    'newlywed-audience', 'youtube-description-output', 'pptx-16x9-output',
    'negative-to-growth-language', 'character-consistency-check',
    'windows-admin', 'vibe-coding', 'sermon-research', 'ministry-content',
    'design-studio', 'full-lab',
    'bible-ministry', 'design-media', 'historical-context', 'original-language',
    'reformed-hermeneutics', 'sync-profiles', 'tool-adapters', 'build-skills'
  ];
  assert.deepEqual(representativeSourceTerms.filter((id) => !implemented.has(id)), []);
});

test('NEXUS routes Korean requests and composes immutable approval-aware recipes', () => {
  const center = new NexusSkillCenter({ clock: () => new Date('2026-09-02T00:00:00.000Z') });
  const recommendation = center.recommend('내 웹사이트를 브라우저로 완전히 점검해줘');
  const composition = center.compose('windows-safe-optimization');

  assert.equal(recommendation.profileId, 'web-product');
  assert.ok(recommendation.skills.some((skill) => skill.id === 'playwright-e2e'));
  assert.ok(recommendation.skills.length <= 25);
  assert.equal(composition.security.requiresApproval, true);
  assert.equal(composition.compatibility.requiresAttention, false);
  assert.ok(composition.fragmentIds.includes('require-user-approval'));
  assert.match(composition.compositionId, /^composed_[a-f0-9]{16}$/);
});

test('NEXUS exact search, every profile, and every recipe survive exhaustive registry exercise', () => {
  const center = new NexusSkillCenter({ clock: () => new Date('2026-09-02T00:00:00.000Z') });

  for (const skillId of NEXUS_SKILL_IDS) {
    const result = center.search(skillId, { limit: 1 });
    assert.equal(result[0]?.id, skillId, `exact search misrouted ${skillId}`);
  }
  for (const profile of NEXUS_PROFILES) {
    const activation = center.activateProfile(profile.id, { request: profile.triggers.join(' ') });
    assert.equal(activation.profileId, profile.id);
    assert.ok(activation.activeSkillCount >= 12);
    assert.ok(activation.activeSkillCount <= 25);
  }
  for (const recipe of NEXUS_RECIPES) {
    const composition = center.compose(recipe.id);
    assert.equal(composition.recipeId, recipe.id);
    assert.ok(composition.skillIds.length > 0);
    assert.ok(composition.skillIds.length <= 25);
    assert.equal(composition.compatibility.compatible, true);
    if (composition.security.requiresApproval) {
      assert.equal(composition.security.approvalFragmentPresent, true, `approval gate missing from ${recipe.id}`);
    }
  }
});

test('NEXUS repeated routing stays bounded and high-risk fragments cannot disappear silently', () => {
  const center = new NexusSkillCenter();
  const requests = [
    '윈도우 서비스와 시작 프로그램 점검',
    '웹사이트 모바일 UX 테스트',
    '한글 보고서와 엑셀 차트 작성',
    '성경 원어와 역사적 배경 연구',
    'MCP 에이전트 평가 설계',
    '프로젝트 버그 수정과 배포 검증'
  ];
  for (let index = 0; index < 500; index += 1) {
    const recommendation = center.recommend(requests[index % requests.length]);
    assert.ok(recommendation.skills.length <= 25);
    assert.equal(new Set(recommendation.skills.map((skill) => skill.id)).size, recommendation.skills.length);
  }

  const unsafe = center.conflictCheck(['registry-safe-edit'], []);
  assert.equal(unsafe.requiresAttention, true);
  assert.deepEqual(unsafe.findings[0].missingFragments, [
    'audit-before-change',
    'require-user-approval',
    'post-change-verification'
  ]);
  const guarded = center.conflictCheck(['registry-safe-edit'], [
    'audit-before-change',
    'require-user-approval',
    'post-change-verification'
  ]);
  assert.equal(guarded.requiresAttention, false);
});

test('Core attaches a bounded request-specific skill profile to every task plan', () => {
  const core = new CoreFacade();
  const task = core.createTask('한글 문서와 엑셀 표로 보고서를 만들어줘');

  assert.equal(task.plan.skillCenter.profileId, 'document-lab');
  assert.ok(task.plan.skillCenter.activeSkillCount <= 25);
  assert.ok(task.plan.skillCenter.skillIds.includes('hwp-hwpx-pipeline'));
  assert.equal(task.skillCenterSelection.profileId, 'document-lab');
  assert.equal(core.skillCenter.status().activeProfileId, 'document-lab');
});

test('Core Skill Center API requires scoped auth and exposes status, search, activation, and composition', async () => {
  const core = new CoreFacade();
  const server = createCoreServer(core, { adminToken: 'nexus-test-admin' });
  const address = await listenOnFetchSafePort(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer nexus-test-admin' };
  try {
    const unauthenticated = await fetch(`${baseUrl}/skill-center/status`);
    assert.equal(unauthenticated.status, 401);

    const statusResponse = await fetch(`${baseUrl}/skill-center/status`, { headers });
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(status.counts.skills, 187);

    const catalogResponse = await fetch(`${baseUrl}/skill-center/catalog`, { headers });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalog.skills.length, 187);
    assert.equal(catalog.fragments.length, 27);
    assert.equal(catalog.profiles.length, 10);
    assert.equal(catalog.recipes.length, 5);
    assert.equal(catalog.providerPackages[0].skillCount, 16);
    assert.equal(Object.hasOwn(catalog.providerPackages[0], 'installRoot'), false);

    const searchResponse = await fetch(`${baseUrl}/skill-center/search?q=${encodeURIComponent('성경 원어')}`, { headers });
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.ok(search.results.some((result) => result.id === 'original-language-analysis'));

    const activateResponse = await fetch(`${baseUrl}/skill-center/activate`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'sermon-research', request: '성경 원어 연구' })
    });
    const activated = await activateResponse.json();
    assert.equal(activateResponse.status, 200);
    assert.equal(activated.profileId, 'sermon-research');
    assert.ok(activated.activeSkillCount <= 25);

    const deactivateResponse = await fetch(`${baseUrl}/skill-center/deactivate`, {
      method: 'POST',
      headers
    });
    const deactivated = await deactivateResponse.json();
    assert.equal(deactivateResponse.status, 200);
    assert.equal(deactivated.previousProfileId, 'sermon-research');
    assert.equal(deactivated.activeSkillCount, 0);

    const composeResponse = await fetch(`${baseUrl}/skill-center/compose`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipeId: 'sermon-multichannel' })
    });
    const composed = await composeResponse.json();
    assert.equal(composeResponse.status, 200);
    assert.equal(composed.recipeId, 'sermon-multichannel');

    const invalidResponse = await fetch(`${baseUrl}/skill-center/activate`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'not-a-profile' })
    });
    const invalid = await invalidResponse.json();
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalid.error.code, 'A_NEXUS_PROFILE_NOT_FOUND');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Core OpenAPI advertises the protected Skill Center contract', () => {
  const spec = createCoreOpenApiSpec(new CoreFacade());
  assert.equal(spec.paths['/skill-center/status'].get.operationId, 'getNexusSkillCenterStatus');
  assert.equal(spec.paths['/skill-center/catalog'].get.operationId, 'getNexusSkillCenterCatalog');
  assert.equal(spec.paths['/skill-center/search'].get.operationId, 'searchNexusSkills');
  assert.equal(spec.paths['/skill-center/activate'].post.operationId, 'activateNexusSkillProfile');
  assert.equal(spec.paths['/skill-center/deactivate'].post.operationId, 'deactivateNexusSkillProfile');
  assert.equal(spec.paths['/skill-center/compose'].post.operationId, 'composeNexusSkillRecipe');
});

test('NEXUS catalog separates registered routes from dependency and execution evidence', () => {
  const center = new NexusSkillCenter();
  const catalog = center.catalogView();
  const unity = catalog.skills.find((skill) => skill.id === 'unity-prototype-builder');
  assert.equal(unity.providerStatus.ready, true);
  assert.equal(unity.providerStatus.readinessBasis, 'routing-inventory');
  assert.equal(unity.providerStatus.executionVerified, false);
  assert.ok(unity.dependencyReport.needsConfiguration > 0);
  assert.ok(unity.dependencyReport.items.some((item) => item.dependency === 'app:unity' && item.status === 'needs-runtime-probe'));
  assert.ok(catalog.skills.every((skill) => skill.dependencyReport && skill.providerStatus.executionVerified === false));
});

test('NEXUS management UI stays local, Korean, discoverable, and responsive', () => {
  const html = readFileSync(new URL('../src/ui/skill-center/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../src/ui/skill-center/skill-center.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/ui/skill-center/skill-center.css', import.meta.url), 'utf8');
  const controlCenter = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

  assert.match(html, /<html lang="ko">/);
  assert.match(html, /NEXUS 스킬 센터/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(script, /const apiRoot = `\$\{controlCenterNetwork.coreBaseUrl\}\/skill-center`;/);
  assert.match(script, /isLoopbackHttpUrl\(apiRoot\)/);
  for (const endpoint of ['/catalog', '/status', '/activate', '/deactivate', '/compose']) {
    assert.ok(script.includes(endpoint), `management UI is missing ${endpoint}`);
  }
  assert.doesNotMatch(script, /style=/);
  assert.match(styles, /scrollbar-gutter:\s*stable/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(controlCenter, /class="skill-center-entry"[^>]+skill-center\/index\.html/);
});
