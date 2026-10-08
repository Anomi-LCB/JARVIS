import { isLoopbackHttpUrl, resolveControlCenterNetwork } from '../../../packages/shared/src/control-center-hosting.js';
import { describeReadFailure } from '../recovery.js';

const app = document.querySelector('#nexus-app');
const toast = document.querySelector('#nexus-toast');
const controlCenterNetwork = resolveControlCenterNetwork({
  locationRef: globalThis.location,
  settingReader: (key) => {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  }
});
const apiRoot = `${controlCenterNetwork.coreBaseUrl}/skill-center`;
const savedRecipeKey = 'jarvis.nexus.saved-recipes.v1';

const categoryLabels = Object.freeze({
  all: '전체',
  meta: '중앙 관리',
  windows: 'Windows·PC',
  development: '개발·테스트',
  web: '웹·제품',
  ai: 'AI·MCP',
  documents: '문서·데이터',
  'design-media': '디자인·미디어',
  'bible-ministry': '성경·목회',
  productivity: '일정·생산성'
});

const profileLabels = Object.freeze({
  'windows-admin': 'Windows 관리',
  'vibe-coding': '개발 작업',
  'web-product': '웹 제품',
  'ai-orchestration': 'AI 오케스트레이션',
  'document-lab': '문서 연구실',
  'sermon-research': '설교 연구',
  'ministry-content': '목회 콘텐츠',
  'design-studio': '디자인 스튜디오',
  productivity: '생산성',
  'full-lab': '전체 연구실'
});

const recipeLabels = Object.freeze({
  'sermon-multichannel': '설교 다중 채널',
  'website-full-audit': '웹사이트 전체 점검',
  'windows-safe-optimization': 'Windows 안전 최적화',
  'ai-app-production': 'AI 앱 제품화',
  'church-event-package': '교회 행사 패키지'
});

const groupLabels = Object.freeze({
  safety: '안전',
  research: '연구',
  theology: '신학',
  audience: '대상',
  tone: '문체',
  output: '출력',
  quality: '품질'
});

const tokenLabels = Object.freeze({
  skill: '스킬', center: '센터', router: '라우터', search: '검색', composer: '조합기', profile: '프로필', manager: '관리',
  dependency: '의존성', resolver: '해결', conflict: '충돌', checker: '검사', validator: '검증', trigger: '트리거', tester: '테스트',
  behavior: '동작', version: '버전', librarian: '정리', usage: '사용', analytics: '분석', plugin: '플러그인', builder: '구축',
  security: '보안', auditor: '감사', improver: '개선', windows: 'Windows', system: '시스템', audit: '점검', installed: '설치 앱',
  app: '앱', inventory: '목록', appx: 'AppX', package: '패키지', winget: 'WinGet', startup: '시작 프로그램', service: '서비스',
  health: '상태', scheduled: '예약', task: '작업', eventlog: '이벤트 로그', diagnose: '진단', registry: '레지스트리', safe: '안전',
  edit: '편집', restore: '복원', point: '지점', driver: '드라이버', nvidia: 'NVIDIA', cuda: 'CUDA', wsl: 'WSL', docker: 'Docker',
  desktop: '데스크톱', network: '네트워크', storage: '저장소', cleanup: '정리', planner: '계획', duplicate: '중복', file: '파일',
  finder: '찾기', configuration: '구성', backup: '백업', ui: 'UI', automation: '자동화', pc: 'PC', performance: '성능', baseline: '기준선',
  project: '프로젝트', bootstrap: '초기화', codebase: '코드베이스', map: '지도', architecture: '아키텍처', review: '검토', requirements: '요구사항',
  spec: '명세', implementation: '구현', bug: '버그', triage: '분류', root: '근본', cause: '원인', analysis: '분석', test: '테스트',
  failure: '실패', debugger: '디버깅', refactor: '리팩터링', profiler: '프로파일링', api: 'API', contract: '계약', database: '데이터베이스',
  schema: '스키마', migration: '마이그레이션', git: 'Git', commit: '커밋', github: 'GitHub', pr: 'PR', ci: 'CI', repair: '복구',
  release: '릴리스', deployment: '배포', documentation: '문서화', sync: '동기화', react: 'React', quality: '품질', nextjs: 'Next.js',
  production: '제품', readiness: '준비도', website: '웹사이트', full: '전체', ux: 'UX', flow: '흐름', information: '정보', design: '디자인',
  responsive: '반응형', layout: '레이아웃', accessibility: '접근성', playwright: 'Playwright', e2e: 'E2E', chrome: 'Chrome', devtools: '개발자 도구',
  budget: '예산', seo: 'SEO', technical: '기술', conversion: '전환', error: '오류', state: '상태', onboarding: '온보딩', payment: '결제',
  mobile: '모바일', experience: '경험', visual: '시각', regression: '회귀', model: '모델', selector: '선택', prompt: '프롬프트', agent: '에이전트',
  harness: '하네스', mcp: 'MCP', permission: '권한', tool: '도구', routing: '라우팅', optimizer: '최적화', local: '로컬', llm: 'LLM',
  setup: '설정', ollama: 'Ollama', openrouter: 'OpenRouter', rag: 'RAG', pipeline: '파이프라인', embedding: '임베딩', memory: '메모리',
  eval: '평가', suite: '모음', token: '토큰', cost: '비용', guardrail: '가드레일', multi: '다중', workflow: '워크플로', document: '문서',
  editor: '편집', spreadsheet: '스프레드시트', presentation: '프레젠테이션', pdf: 'PDF', hwp: 'HWP', hwpx: 'HWPX', markitdown: 'MarkItDown',
  ingest: '수집', ocr: 'OCR', data: '데이터', cleaning: '정제', validation: '검증', chart: '차트', citation: '인용', zotero: 'Zotero',
  research: '연구', meeting: '회의', minutes: '회의록', template: '템플릿', form: '양식', report: '보고서', generator: '생성', knowledge: '지식',
  capture: '수집', image: '이미지', brand: '브랜드', thumbnail: '썸네일', card: '카드', news: '뉴스', infographic: '인포그래픽',
  poster: '포스터', figma: 'Figma', canva: 'Canva', bulk: '대량', create: '생성', ffmpeg: 'FFmpeg', video: '영상', audio: '오디오',
  mastering: '마스터링', subtitle: '자막', shortform: '숏폼', converter: '변환', character: '캐릭터', consistency: '일관성', scene: '장면',
  continuity: '연속성', storyboard: '스토리보드', blender: 'Blender', unity: 'Unity', prototype: '프로토타입', scripture: '성경 본문', bible: '성경',
  translation: '번역', compare: '비교', parallel: '평행', passage: '본문', original: '원어', language: '언어', hebrew: '히브리어', word: '단어',
  study: '연구', greek: '헬라어', textual: '본문', variant: '이문', historical: '역사', context: '배경', ancient: '고대', near: '근동',
  east: '동방', second: '제2', temple: '성전', literature: '문헌', patristic: '교부', source: '자료', reformation: '종교개혁', reformed: '개혁주의',
  theology: '신학', view: '견해', canonical: '정경', biblical: '성경신학', systematic: '조직신학', exegesis: '주해',
  sermon: '설교', big: '핵심', idea: '아이디어', structure: '구조', introduction: '서론', application: '적용', illustration: '예화', tone: '문체',
  theological: '신학', multichannel: '다중 채널', bulletin: '주보', writer: '작성', small: '소그룹', group: '모임', workbook: '워크북',
  pastoral: '목회', care: '돌봄', response: '응답', worship: '예배', order: '순서', church: '교회', event: '행사', parent: '부모', ministry: '목회',
  content: '콘텐츠', newlywed: '신혼부부', youtube: 'YouTube', packager: '패키지', schedule: '일정', coordinator: '조정', inbox: '받은편지함',
  prioritizer: '우선순위', retrieval: '검색', preparation: '준비', follow: '후속', up: '관리', personal: '개인', notification: '알림', digest: '요약',
  organization: '정리', recurring: '반복', automator: '자동화', calendar: '달력', status: '상태', brief: '브리핑', focus: '집중', session: '세션',
  dashboard: '대시보드', archive: '보관', retention: '보존', before: '전', change: '변경', require: '필수', user: '사용자', approval: '승인',
  gate: '게이트', post: '후', primary: '1차', sources: '자료', opposing: '상반', views: '견해', layer: '계층', citations: '인용', filter: '필터',
  integrity: '무결성', audience: '대상', fit: '적합성', korean: '한국어', adults: '성인', spoken: '구어', negative: '부정', growth: '성장',
  output: '출력', description: '설명', pptx: 'PPTX', summary: '요약', column: '칼럼', blog: '블로그', check: '검사'
});

const phraseLabels = Object.freeze({
  'audit-before-change': '변경 전 점검', 'require-user-approval': '사용자 승인 필수',
  'approval-gate': '승인 게이트', 'post-change-verification': '변경 후 검증',
  'cite-primary-sources': '1차 자료 인용', 'compare-opposing-views': '상반된 견해 비교',
  'original-language-layer': '원어 분석', 'primary-source-citations': '1차 자료 인용 검증',
  'reformed-theology-filter': '개혁주의 신학 검토', 'theological-consistency-review': '신학적 일관성 검토',
  'source-integrity-review': '출처 신뢰성 검토', 'newlywed-audience': '신혼부부 대상',
  'korean-adults': '한국 성인 대상', 'audience-fit-review': '대상 적합성 검토',
  'korean-pastoral-tone': '한국어 목회 문체', 'pastoral-spoken': '목회 구어체',
  'negative-to-growth-language': '성장 중심 표현', 'youtube-description-output': 'YouTube 설명문',
  'pptx-16x9-output': '16:9 프레젠테이션', 'bulletin-summary': '주보 요약',
  'church-column': '교회 칼럼', 'youtube-package': 'YouTube 콘텐츠 묶음',
  'card-news': '카드뉴스', 'blog-post': '블로그 글', 'character-consistency-check': '캐릭터 일관성 검사',
  'bible-citation-audit': '성경 인용 점검', 'visual-regression-check': '시각적 회귀 검사',
  'request-classification': '요청 분류', 'registry-resolution': '레지스트리 조회',
  'policy-validation': '정책 검증', 'selection-evidence': '선택 근거 기록',
  'selected-profile': '선택한 프로필', 'selection-rationale': '선택 사유', 'validation-report': '검증 보고서',
  'read-only-baseline': '읽기 전용 기준 상태 확인', 'bounded-change-plan': '범위를 제한한 변경 계획',
  'approval-before-mutation': '변경 전 승인', 'postcondition-and-rollback-check': '결과 및 복원 가능 여부 확인',
  'before-snapshot': '변경 전 상태', 'affected-items': '영향받는 항목', 'approval-id': '승인 식별자',
  'after-snapshot': '변경 후 상태', 'rollback-readiness': '복원 준비 상태',
  'repository-context': '저장소 맥락 확인', 'scoped-implementation': '요청 범위 구현',
  'focused-tests': '관련 테스트', 'shared-regression-and-diff-review': '전체 회귀 및 변경사항 검토',
  'changed-files': '변경 파일', 'test-results': '테스트 결과', 'build-result': '빌드 결과', 'remaining-risk': '남은 위험',
  'real-browser-reproduction': '실제 브라우저 재현', 'responsive-and-accessibility-check': '반응형 및 접근성 점검',
  'console-network-performance-check': '콘솔·네트워크·성능 점검', 'visual-postcondition': '화면 결과 확인',
  'browser-console': '브라우저 콘솔', 'network-failures': '네트워크 오류',
  'desktop-screenshot': '데스크톱 화면', 'mobile-screenshot': '모바일 화면', 'interaction-results': '조작 결과',
  'capability-and-provider-selection': '기능 및 공급자 선택', 'schema-and-permission-boundary': '명세 및 권한 경계 확인',
  'evaluation-corpus': '평가 사례 모음', 'latency-cost-quality-report': '응답 시간·비용·품질 보고서',
  'provider-route': '공급자 경로', 'tool-schema': '도구 명세', 'evaluation-results': '평가 결과',
  latency: '응답 시간', 'token-or-cost-estimate': '토큰 또는 비용 추정',
  'source-and-format-validation': '원본 및 형식 검증', 'structured-authoring': '구조화된 문서 작성',
  'rendered-output-inspection': '출력 화면 검토', 'artifact-integrity-check': '결과물 무결성 확인',
  'output-path': '저장 경로', format: '파일 형식', 'content-hash': '내용 해시', 'render-review': '렌더링 검토',
  'brief-and-asset-audit': '요구사항 및 소재 점검', production: '제작',
  'continuity-and-brand-review': '연속성 및 브랜드 검토', 'export-quality-check': '내보내기 품질 검사',
  'source-assets': '원본 소재', 'dimensions-or-duration': '크기 또는 재생 시간', 'visual-review': '시각적 검토',
  'source-retrieval': '자료 수집', 'context-and-view-comparison': '맥락 및 관점 비교',
  'citation-and-audience-fit-check': '인용 및 대상 적합성 점검', 'primary-sources': '1차 자료',
  'citation-map': '인용 출처 목록', 'interpretive-assumptions': '해석의 전제', 'review-findings': '검토 결과',
  'capture-current-state': '현재 상태 수집', 'prioritize-and-schedule': '우선순위 및 일정 정리',
  'execute-or-stage': '실행 또는 준비', 'completion-and-follow-up-check': '완료 및 후속 조치 확인',
  'input-items': '입력 항목', 'priority-rationale': '우선순위 근거', 'result-state': '결과 상태', 'follow-up-items': '후속 조치',
  'installed-app-inventory': '설치된 앱 목록', 'startup-app-audit': '시작 프로그램 점검',
  'requirements-to-spec': '요구사항 명세화'
});

const state = {
  loading: true,
  error: null,
  recovery: null,
  catalogFetchedAt: null,
  catalog: null,
  status: null,
  tab: 'skills',
  query: '',
  category: 'all',
  risk: 'all',
  provider: 'all',
  visibleLimit: 48,
  selectedSkillId: null,
  selectedProfileId: 'full-lab',
  selectedRecipeId: 'ai-app-production',
  additionalFragments: new Set(),
  composition: null,
  busyAction: null,
  savedRecipes: readSavedRecipes()
};

app.addEventListener('click', handleClick);
app.addEventListener('change', handleChange);
app.addEventListener('input', handleInput);
globalThis.addEventListener('keydown', handleShortcut);

loadCenter();

async function loadCenter({ preserveSelection = false } = {}) {
  if (loadCenter.pending) return loadCenter.pending;
  loadCenter.pending = refreshCenter({ preserveSelection });
  try { await loadCenter.pending; } finally { loadCenter.pending = null; }
}

async function refreshCenter({ preserveSelection }) {
  state.loading = true;
  state.error = null;
  state.recovery = null;
  render();
  try {
    const [catalogResult, statusResult] = await Promise.allSettled([
      requestJson('/catalog').then((catalog) => {
        if (!validCatalog(catalog)) {
          const error = new Error('Invalid catalog');
          error.code = 'INVALID_RESPONSE';
          throw error;
        }
        state.catalog = catalog;
        state.catalogFetchedAt = new Date().toISOString();
        if (!preserveSelection || !catalog.skills.some((skill) => skill.id === state.selectedSkillId)) {
          state.selectedSkillId = catalog.skills[0]?.id ?? null;
        }
        render();
        return catalog;
      }),
      requestJson('/status')
    ]);
    state.status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    if (catalogResult.status === 'rejected' || statusResult.status === 'rejected') {
      const failed = catalogResult.status === 'rejected' ? catalogResult : statusResult;
      const path = catalogResult.status === 'rejected' ? '/catalog' : '/status';
      state.recovery = describeReadFailure(failed.reason, { component: 'skill-center', endpoint: `${apiRoot}${path}` });
      state.error = state.recovery.summary;
    } else if (!state.status || typeof state.status.ready !== 'boolean') {
      const error = new Error('Invalid status');
      error.code = 'INVALID_RESPONSE';
      throw error;
    } else if (!state.status.ready || !state.catalog.validation.valid) {
      state.recovery = describeReadFailure({ status: 503 }, { component: 'skill-center', endpoint: `${apiRoot}/status` });
      state.error = '스킬 레지스트리 검증이 완료되지 않았습니다. 목록만 확인할 수 있습니다.';
    }
    state.selectedProfileId = state.status?.activeProfileId ?? state.selectedProfileId ?? state.catalog?.profiles[0]?.id;
  } catch (error) {
    state.recovery = describeReadFailure(error, { component: 'skill-center', endpoint: `${apiRoot}/status` });
    state.error = state.recovery.summary;
  } finally {
    state.loading = false;
    render();
  }
}

function validCatalog(catalog) {
  return Boolean(catalog && catalog.counts && catalog.validation
    && ['skills', 'profiles', 'categories', 'recipes', 'fragments', 'providerPackages'].every((key) => Array.isArray(catalog[key])));
}

function renderRecovery() {
  const failure = state.recovery;
  return `<section class="connection-error" role="alert" aria-labelledby="recovery-heading">
    <h2 id="recovery-heading">${state.catalog ? '읽기 전용 · 실행 상태 확인 필요' : '스킬 센터 연결 확인 필요'}</h2>
    <p>${escapeHtml(state.error)}</p>
    <p>${escapeHtml(failure?.nextAction ?? '연결 상태를 확인한 뒤 다시 검사해 주세요.')}</p>
    ${state.catalog ? `<p>이전 조회 결과 · 목록 조회 ${escapeHtml(state.catalogFetchedAt)}. 현재 설치·실행 상태를 보증하지 않습니다.</p>` : '<p>이 탭에는 이전에 확인한 목록이 없습니다. 연결을 복구하면 목록을 다시 불러옵니다.</p>'}
    <details><summary>진단 정보</summary><p>${escapeHtml(failure?.code)} · ${escapeHtml(failure?.component)}</p><p>${escapeHtml(failure?.endpoint)}</p><p>확인 시각 ${escapeHtml(failure?.checkedAt)} · 조회만 다시 시도합니다.</p></details>
    <button type="button" class="quiet-button" data-refresh ${state.loading ? 'disabled' : ''}>다시 확인</button>
    <a class="quiet-button" href="../../../index.html">제어 센터에서 진단</a>
  </section>`;
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(`${apiRoot}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      ...(controlCenterNetwork.hosted && isLoopbackHttpUrl(apiRoot)
        ? { targetAddressSpace: 'loopback' }
        : {}),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message ?? `요청 실패 (${response.status})`);
      error.code = payload?.error?.code ?? `HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('응답 시간이 초과되었습니다.');
      timeoutError.code = 'NEXUS_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function render({ focusSearch = false } = {}) {
  if (state.loading && !state.catalog) {
    app.innerHTML = `<section class="boot-state" aria-live="polite"><span class="boot-mark">N</span><h1>NEXUS 스킬 센터</h1><p>스킬 레지스트리를 확인하고 있습니다</p></section>`;
    return;
  }
  if (state.error && !state.catalog) {
    app.innerHTML = `<div class="error-state"><h1>NEXUS 스킬 센터</h1>${renderRecovery()}</div>`;
    return;
  }

  app.innerHTML = `<div class="nexus-shell">
    ${renderHeader()}
    ${renderSidebar()}
    <section class="nexus-main" aria-label="스킬 작업 공간">
      ${state.error ? renderRecovery() : ''}
      ${renderToolbar()}
      ${renderMetrics()}
      ${renderTabs()}
      ${state.tab === 'skills' ? renderRegistry() : state.tab === 'recipes' ? renderRecipes() : renderGovernance()}
    </section>
    ${renderInspector()}
  </div>`;

  if (focusSearch) {
    const input = app.querySelector('[data-skill-search]');
    input?.focus();
    input?.setSelectionRange(state.query.length, state.query.length);
  }
}

function renderHeader() {
  const ready = !state.loading && !state.error && state.status?.ready && state.catalog?.validation?.valid;
  return `<header class="nexus-header">
    <a class="nexus-brand" href="../../../index.html" aria-label="JARVIS 제어 센터로 돌아가기">
      <span class="brand-mark">N</span>
      <div><h1>NEXUS 스킬 센터</h1><span>JARVIS 중앙 레지스트리</span></div>
    </a>
    <div class="runtime-indicator ${ready ? 'ready' : ''}"><i></i>${state.loading ? '연결 확인 중' : ready ? '레지스트리 정상' : '연결 확인 필요'}</div>
    <div class="header-actions">
      <a class="quiet-button" href="../../../index.html">제어 센터</a>
      <button type="button" class="icon-button" data-refresh aria-label="스킬 센터 새로고침" title="새로고침" ${state.busyAction || state.loading ? 'disabled' : ''}>↻</button>
    </div>
  </header>`;
}

function renderSidebar() {
  const categories = [{ id: 'all', count: state.catalog.counts.skills }, ...state.catalog.categories];
  const activeProfile = state.catalog.profiles.find((profile) => profile.id === state.status?.activeProfileId);
  const selectedProfile = state.catalog.profiles.find((profile) => profile.id === state.selectedProfileId);
  return `<aside class="nexus-sidebar" aria-label="스킬 필터와 프로필">
    <section class="side-section">
      <p class="section-label"><span>범주</span><b>${state.catalog.counts.skills}</b></p>
      <nav class="category-list" aria-label="스킬 범주">
        ${categories.map((category) => `<button type="button" class="category-button ${state.category === category.id ? 'active' : ''}" data-category="${escapeHtml(category.id)}"><span>${escapeHtml(categoryLabels[category.id] ?? category.id)}</span><em>${category.count}</em></button>`).join('')}
      </nav>
    </section>
    <section class="side-section">
      <p class="section-label"><span>활성 프로필</span><b>${state.status?.activeSkillCount ?? '—'}/${state.catalog.maxActive}</b></p>
      <div class="profile-control">
        <select data-profile-select aria-label="활성화할 프로필">
          ${state.catalog.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === state.selectedProfileId ? 'selected' : ''}>${escapeHtml(profileLabels[profile.id] ?? skillLabel(profile.id))} · ${profile.skillIds.length}</option>`).join('')}
        </select>
        <div class="profile-actions">
          <button type="button" class="primary-button" data-activate-profile ${remoteActionUnavailable() || !selectedProfile ? 'disabled' : ''}>${state.busyAction === 'activate' ? '활성화 중' : '활성화'}</button>
          <button type="button" class="danger-button" data-deactivate-profile aria-label="현재 프로필 비활성화" ${remoteActionUnavailable() || !activeProfile ? 'disabled' : ''}>해제</button>
        </div>
        <div class="profile-meta">
          <strong>${!state.status ? '활성 상태 확인 필요' : activeProfile ? escapeHtml(profileLabels[activeProfile.id] ?? activeProfile.id) : '활성 프로필 없음'}</strong>
          <span>${activeProfile ? `${state.status.activeSkillCount}개 스킬 · v${activeProfile.version}` : '중앙 카탈로그는 유지됩니다'}</span>
        </div>
      </div>
    </section>
    <section class="side-section side-foot">
      <p class="section-label"><span>스냅샷</span><b>SHA-256</b></p>
      <code class="digest" title="${escapeHtml(state.catalog.snapshotDigest)}">${escapeHtml(state.catalog.snapshotDigest)}</code>
    </section>
  </aside>`;
}

function renderToolbar() {
  return `<div class="workspace-toolbar">
    <label class="search-field"><input type="search" data-skill-search value="${escapeHtml(state.query)}" placeholder="스킬·태그·프로그램 검색" autocomplete="off" aria-label="스킬 검색" /><kbd>/</kbd></label>
    <select class="filter-select" data-risk-filter aria-label="위험도 필터">
      ${option('all', '모든 위험도', state.risk)}${option('low', '낮은 위험', state.risk)}${option('medium', '승인 가능', state.risk)}${option('high', '높은 위험', state.risk)}
    </select>
    <select class="filter-select" data-provider-filter aria-label="공급자 상태 필터">
      ${option('all', '모든 공급자', state.provider)}${option('ready', '등록 경로 있음', state.provider)}${option('configurable', '의존성 확인 필요', state.provider)}
    </select>
  </div>`;
}

function renderMetrics() {
  const counts = state.catalog.counts;
  const configurable = state.catalog.skills.filter(needsSkillSetup).length;
  return `<div class="metric-strip" aria-label="스킬 센터 요약">
    ${metric('등록 스킬', counts.skills)}
    ${metric('프래그먼트', counts.fragments)}
    ${metric('프로필', counts.profiles)}
    ${metric('레시피', counts.recipes)}
    ${metric('등록 경로', `${state.status?.providers?.ready ?? '—'}/${counts.providers}`)}
    ${metric('의존성 확인', configurable, configurable ? 'warn' : '')}
  </div>`;
}

function renderTabs() {
  return `<nav class="workspace-tabs" aria-label="스킬 센터 보기">
    ${tabButton('skills', '스킬 레지스트리')}
    ${tabButton('recipes', '레시피 조합')}
    ${tabButton('governance', '검증·운영')}
  </nav>`;
}

function renderRegistry() {
  const skills = filteredSkills();
  const visible = skills.slice(0, state.visibleLimit);
  return `<div class="tab-panel">
    <div class="registry-head"><span>스킬</span><span>범주</span><span>공급자</span><span>위험</span><span>버전</span></div>
    <div class="registry-list" aria-live="polite">
      ${visible.length ? visible.map(renderSkillRow).join('') : `<div class="empty-state"><strong>일치하는 스킬이 없습니다</strong><span>검색어나 필터를 변경해 주세요.</span></div>`}
    </div>
    ${skills.length > visible.length ? `<div class="load-more-wrap"><button type="button" class="load-more" data-load-more>${visible.length}/${skills.length} · 더 보기</button></div>` : ''}
  </div>`;
}

function renderSkillRow(skill) {
  const provider = skill.providerStatus?.providers?.[0];
  const providerLabel = provider?.id ?? '미지정';
  const providerReady = skill.providerStatus?.ready && !needsSkillSetup(skill);
  return `<button type="button" class="skill-row ${state.selectedSkillId === skill.id ? 'selected' : ''}" data-skill-id="${escapeHtml(skill.id)}" aria-pressed="${state.selectedSkillId === skill.id}">
    <span class="skill-name"><strong>${escapeHtml(skillLabel(skill.id))}</strong><code>${escapeHtml(skill.id)}</code></span>
    <span class="cell-muted">${escapeHtml(categoryLabels[skill.category] ?? skill.category)}</span>
    <span class="provider-state ${providerReady ? 'ready' : ''}" title="${escapeHtml(providerLabel)}">${providerReady ? '경로 등록' : '의존성 확인'}</span>
    <span class="risk-badge ${escapeHtml(skill.risk.level)}">${escapeHtml(riskLabel(skill.risk))}</span>
    <span class="cell-muted">v${escapeHtml(skill.version)}</span>
  </button>`;
}

function renderRecipes() {
  const selected = selectedRecipe();
  const grouped = groupBy(state.catalog.fragments, (fragment) => fragment.category);
  return `<div class="tab-panel recipe-workspace">
    <section class="recipe-list">
      <header><strong>기본 레시피</strong><span class="cell-muted">${state.catalog.recipes.length}개</span></header>
      ${state.catalog.recipes.map((recipe) => `<button type="button" class="recipe-button ${recipe.id === state.selectedRecipeId ? 'active' : ''}" data-recipe-id="${escapeHtml(recipe.id)}"><strong>${escapeHtml(recipeLabels[recipe.id] ?? skillLabel(recipe.id))}</strong><span>${recipe.base.length + recipe.outputs.length + recipe.reviewers.length}개 구성 · v${escapeHtml(recipe.version)}</span></button>`).join('')}
    </section>
    <section class="compose-panel">
      <header><strong>${escapeHtml(recipeLabels[selected?.id] ?? skillLabel(selected?.id ?? 'recipe'))}</strong><span class="cell-muted">${selected ? `${selected.fragments.length}개 기본 프래그먼트` : ''}</span></header>
      <div class="compose-body">
        <div class="fragment-groups">
          ${Object.entries(grouped).map(([category, fragments]) => `<section class="fragment-group"><strong>${escapeHtml(groupLabels[category] ?? category)}</strong>${fragments.map((fragment) => `<label class="fragment-option"><input type="checkbox" data-fragment-id="${escapeHtml(fragment.id)}" ${state.additionalFragments.has(fragment.id) ? 'checked' : ''} /><span>${escapeHtml(skillLabel(fragment.id))}</span></label>`).join('')}</section>`).join('')}
        </div>
        <div class="compose-actions">
          <button type="button" class="primary-button" data-compose-recipe ${remoteActionUnavailable() || !selected ? 'disabled' : ''}>${state.busyAction === 'compose' ? '조합 중' : '안전 조합'}</button>
          <button type="button" class="quiet-button" data-clear-fragments ${state.additionalFragments.size === 0 ? 'disabled' : ''}>추가 선택 해제</button>
          <button type="button" class="quiet-button" data-save-composition ${!state.composition ? 'disabled' : ''}>레시피 저장</button>
        </div>
        ${renderCompositionResult()}
      </div>
    </section>
  </div>`;
}

function renderCompositionResult() {
  const result = state.composition;
  if (!result) return `<div class="empty-state"><strong>조합 결과 대기</strong><span>레시피와 추가 프래그먼트를 선택하세요.</span></div>`;
  const approval = result.security?.requiresApproval;
  const compatible = result.compatibility?.compatible;
  const dependenciesReady = (result.dependencyReport?.needsConfiguration ?? 0) === 0;
  return `<section class="composition-result" aria-live="polite">
    <div class="result-status">
      ${resultFact('보안', approval ? '실행 전 승인' : '읽기 중심')}
      ${resultFact('호환성', compatible ? '충돌 없음' : '확인 필요')}
      ${resultFact('의존성', dependenciesReady ? '추가 확인 없음' : `${result.dependencyReport.needsConfiguration}개 확인`)}
    </div>
    ${approval ? `<p class="approval-note">${result.security.approvalFragmentPresent ? '승인 게이트가 조합에 포함됐습니다.' : '승인 게이트를 확인해야 합니다.'}</p>` : ''}
    <div><p class="section-label"><span>활성 스킬</span><b>${result.skillIds.length}/${result.maxActive}</b></p><ul class="token-list">${result.skillIds.map((id) => `<li>${escapeHtml(id)}</li>`).join('')}</ul></div>
    <div><p class="section-label"><span>프래그먼트</span><b>${result.fragmentIds.length}</b></p><ul class="token-list">${result.fragmentIds.map((id) => `<li>${escapeHtml(id)}</li>`).join('')}</ul></div>
  </section>`;
}

function renderGovernance() {
  const validation = state.catalog.validation;
  const providerPackage = state.catalog.providerPackages[0];
  const usage = state.catalog.usage;
  const aliases = state.catalog.librarian.aliasCandidates ?? [];
  const commands = [
    ['카탈로그 감사', 'npm run skill:center:audit'],
    ['전체 스킬 테스트', 'npm run skill:center:test'],
    ['공급자 보안 감사', 'npm run skill:center:provider-audit'],
    ['의존성 재검사', 'npm run skill:center:probe'],
    ['Windows 중앙 동기화', 'npm run skill:center:sync']
  ];
  return `<div class="tab-panel governance-grid">
    <section class="governance-section">
      <header><strong>레지스트리 검증</strong><span class="risk-badge ${validation.valid ? 'low' : 'high'}">${validation.valid ? '통과' : '실패'}</span></header>
      <div class="governance-body">
        ${factRow('스냅샷', shortDigest(state.catalog.snapshotDigest))}
        ${factRow('중복 ID', state.catalog.librarian.duplicateIds.length)}
        ${factRow('유사 항목 검토', aliases.length)}
        ${factRow('오류', validation.errors.length)}
      </div>
    </section>
    <section class="governance-section">
      <header><strong>공급자 패키지</strong><span class="cell-muted">등록 명세</span></header>
      <div class="governance-body">
        ${providerPackage ? factRow('패키지', providerPackage.id) : ''}
        ${providerPackage ? factRow('공식 스킬', `${providerPackage.skillCount}개`) : ''}
        ${providerPackage ? factRow('활성 정책', providerPackage.activation === 'inactive-library' ? '선택 시 활성' : providerPackage.activation) : ''}
        ${providerPackage ? factRow('소스 커밋', shortDigest(providerPackage.observedSourceCommit)) : ''}
      </div>
    </section>
    <section class="governance-section">
      <header><strong>사용 통계</strong><span class="cell-muted">현재 런타임</span></header>
      <div class="governance-body">
        ${factRow('기록 유형', usage.recordCount)}
        ${factRow('총 시도', usage.totalAttempts)}
        ${(usage.records ?? []).slice(0, 4).map((record) => factRow(`${record.type} · ${record.id}`, `${record.successes}/${record.attempts}`)).join('') || factRow('기록', '아직 없음')}
      </div>
    </section>
    <section class="governance-section">
      <header><strong>저장된 레시피</strong><span class="cell-muted">이 브라우저</span></header>
      <div class="governance-body">
        ${state.savedRecipes.length ? state.savedRecipes.map((item) => `<div class="saved-recipe-row"><span>${escapeHtml(item.label)} · ${item.skillCount}개</span><div><button type="button" class="copy-button" data-load-saved="${escapeHtml(item.id)}" ${remoteActionUnavailable() ? 'disabled' : ''}>불러오기</button><button type="button" class="copy-button" data-delete-saved="${escapeHtml(item.id)}">삭제</button></div></div>`).join('') : factRow('저장 항목', '없음')}
      </div>
    </section>
    <section class="governance-section governance-wide">
      <header><strong>운영 도구</strong><span class="cell-muted">로컬 CLI</span></header>
      <div class="governance-body">
        ${commands.map(([label, command]) => `<div class="tool-row"><span>${escapeHtml(label)}</span><code title="${escapeHtml(command)}">${escapeHtml(command)}</code><button type="button" class="copy-button" data-copy-command="${escapeHtml(command)}">복사</button></div>`).join('')}
      </div>
    </section>
  </div>`;
}

function renderInspector() {
  const skill = selectedSkill();
  if (!skill) return `<aside class="nexus-inspector"><div class="empty-state"><span>스킬을 선택하세요.</span></div></aside>`;
  const dependencies = skill.dependencyReport?.items ?? (skill.dependencies ?? []).map((dependency) => ({ dependency, status: 'unknown' }));
  const providers = skill.providerStatus?.providers ?? [];
  return `<aside class="nexus-inspector" aria-label="선택한 스킬 상세 정보">
    <header class="inspector-head"><h2>스킬 상세</h2><span class="kind-badge">${skill.kind === 'meta-skill' ? '메타 스킬' : '완성형 스킬'}</span></header>
    <div class="inspector-body">
      <section class="inspector-block">
        <div class="inspector-title"><strong>${escapeHtml(skillLabel(skill.id))}</strong><code>${escapeHtml(skill.id)}</code></div>
        <div class="inspector-facts">
          ${inspectorFact('범주', categoryLabels[skill.category] ?? skill.category)}
          ${inspectorFact('버전', `v${skill.version}`)}
          ${inspectorFact('위험도', riskLabel(skill.risk))}
          ${inspectorFact('실행 방식', skill.executionMode === 'native' ? '네이티브' : '공급자 조합')}
          ${inspectorFact('실행 검증', '개별 작업에서 확인')}
        </div>
        ${skill.risk.requiresApproval || skill.risk.externalSideEffect ? `<p class="approval-note">실제 변경 또는 외부 부작용 직전에 승인이 필요합니다.</p>` : ''}
      </section>
      <section class="inspector-block"><span>공급자</span><ul class="plain-list">${providers.map((provider) => `<li class="provider-list-item"><i class="status-dot ${provider.status === 'ready' ? 'ready' : ''}"></i><span>${escapeHtml(provider.id)} · ${provider.status === 'ready' ? '경로 등록' : '연결 필요'}</span></li>`).join('')}</ul></section>
      <section class="inspector-block"><span>의존성</span>${dependencies.length ? `<ul class="plain-list">${dependencies.map((item) => `<li>${escapeHtml(item.dependency)} · ${escapeHtml(dependencyLabel(item.status))}</li>`).join('')}</ul>` : `<p class="cell-muted">추가 의존성 없음</p>`}</section>
      <section class="inspector-block"><span>실행 흐름</span><ol class="plain-list">${(skill.contract?.workflow ?? []).map((item) => `<li>${escapeHtml(skillLabel(item))}</li>`).join('')}</ol></section>
      <section class="inspector-block"><span>검증 근거</span><ul class="plain-list">${(skill.contract?.evidence ?? []).map((item) => `<li>${escapeHtml(skillLabel(item))}</li>`).join('')}</ul></section>
      <section class="inspector-block"><span>태그</span><ul class="token-list">${(skill.tags ?? []).map((tag) => `<li>${escapeHtml(tag)}</li>`).join('')}</ul></section>
    </div>
  </aside>`;
}

async function handleClick(event) {
  const category = event.target.closest('[data-category]');
  if (category) {
    state.category = category.dataset.category;
    state.visibleLimit = 48;
    render();
    return;
  }
  const skill = event.target.closest('[data-skill-id]');
  if (skill) {
    state.selectedSkillId = skill.dataset.skillId;
    render();
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    render();
    return;
  }
  const recipe = event.target.closest('[data-recipe-id]');
  if (recipe) {
    state.selectedRecipeId = recipe.dataset.recipeId;
    state.additionalFragments.clear();
    state.composition = null;
    render();
    return;
  }
  if (event.target.closest('[data-refresh]')) {
    if (state.loading || state.busyAction) return;
    await loadCenter({ preserveSelection: true });
    showToast(state.error ? state.error : '레지스트리를 새로 확인했습니다.', Boolean(state.error));
    return;
  }
  if (event.target.closest('[data-load-more]')) {
    state.visibleLimit += 48;
    render();
    return;
  }
  if (event.target.closest('[data-activate-profile]')) {
    await activateProfile();
    return;
  }
  if (event.target.closest('[data-deactivate-profile]')) {
    await deactivateProfile();
    return;
  }
  if (event.target.closest('[data-compose-recipe]')) {
    await composeRecipe();
    return;
  }
  if (event.target.closest('[data-clear-fragments]')) {
    state.additionalFragments.clear();
    state.composition = null;
    render();
    return;
  }
  if (event.target.closest('[data-save-composition]')) {
    saveComposition();
    return;
  }
  const saved = event.target.closest('[data-load-saved]');
  if (saved) {
    await loadSavedRecipe(saved.dataset.loadSaved);
    return;
  }
  const removed = event.target.closest('[data-delete-saved]');
  if (removed) {
    persistSavedRecipes(state.savedRecipes.filter((item) => item.id !== removed.dataset.deleteSaved), '저장 레시피를 삭제했습니다.');
    render();
    return;
  }
  const copy = event.target.closest('[data-copy-command]');
  if (copy) await copyText(copy.dataset.copyCommand);
}

function handleChange(event) {
  if (event.target.matches('[data-profile-select]')) {
    state.selectedProfileId = event.target.value;
    render();
  } else if (event.target.matches('[data-risk-filter]')) {
    state.risk = event.target.value;
    state.visibleLimit = 48;
    render();
  } else if (event.target.matches('[data-provider-filter]')) {
    state.provider = event.target.value;
    state.visibleLimit = 48;
    render();
  } else if (event.target.matches('[data-fragment-id]')) {
    if (event.target.checked) state.additionalFragments.add(event.target.dataset.fragmentId);
    else state.additionalFragments.delete(event.target.dataset.fragmentId);
    state.composition = null;
    render();
  }
}

function handleInput(event) {
  if (!event.target.matches('[data-skill-search]')) return;
  state.query = event.target.value;
  state.visibleLimit = 48;
  render({ focusSearch: true });
}

function handleShortcut(event) {
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
    event.preventDefault();
    app.querySelector('[data-skill-search]')?.focus();
  }
  if (event.key === 'Escape' && document.activeElement?.matches?.('[data-skill-search]')) {
    state.query = '';
    render({ focusSearch: true });
  }
}

async function activateProfile() {
  if (!state.selectedProfileId || remoteActionUnavailable()) return;
  state.busyAction = 'activate';
  render();
  try {
    const result = await requestJson('/activate', {
      method: 'POST',
      body: { profileId: state.selectedProfileId, request: 'NEXUS 관리 화면에서 명시적으로 선택한 프로필' }
    });
    state.status.activeProfileId = result.profileId;
    state.status.activeSkillIds = result.skills.map((skill) => skill.id);
    state.status.activeSkillCount = result.activeSkillCount;
    state.catalog.activeProfileId = result.profileId;
    state.catalog.activeSkillIds = [...state.status.activeSkillIds];
    showToast(`${profileLabels[result.profileId] ?? result.profileId} 프로필을 활성화했습니다.`);
  } catch (error) {
    showToast(friendlyError(error), true);
  } finally {
    state.busyAction = null;
    render();
  }
}

async function deactivateProfile() {
  if (remoteActionUnavailable() || !state.status?.activeProfileId) return;
  state.busyAction = 'deactivate';
  render();
  try {
    const result = await requestJson('/deactivate', { method: 'POST' });
    state.status.activeProfileId = result.activeProfileId;
    state.status.activeSkillIds = result.activeSkillIds;
    state.status.activeSkillCount = result.activeSkillCount;
    state.catalog.activeProfileId = null;
    state.catalog.activeSkillIds = [];
    showToast('활성 프로필을 해제했습니다. 중앙 카탈로그는 유지됩니다.');
  } catch (error) {
    showToast(friendlyError(error), true);
  } finally {
    state.busyAction = null;
    render();
  }
}

async function composeRecipe() {
  if (!state.selectedRecipeId || remoteActionUnavailable()) return;
  state.busyAction = 'compose';
  render();
  try {
    state.composition = await requestJson('/compose', {
      method: 'POST',
      body: {
        recipeId: state.selectedRecipeId,
        additionalFragments: [...state.additionalFragments],
        limit: 25
      }
    });
    showToast(state.composition.security?.requiresApproval ? '승인 게이트를 포함해 조합했습니다.' : '레시피 조합을 완료했습니다.');
  } catch (error) {
    showToast(friendlyError(error), true);
  } finally {
    state.busyAction = null;
    render();
  }
}

function saveComposition() {
  if (!state.composition) return;
  const item = {
    id: state.composition.compositionId,
    label: recipeLabels[state.composition.recipeId] ?? state.composition.recipeId,
    recipeId: state.composition.recipeId,
    skillCount: state.composition.skillIds.length,
    fragmentIds: [...state.composition.fragmentIds],
    savedAt: new Date().toISOString()
  };
  persistSavedRecipes([item, ...state.savedRecipes.filter((saved) => saved.id !== item.id)].slice(0, 20), '조합 레시피를 이 브라우저에 저장했습니다.');
  render();
}

function persistSavedRecipes(items, message) {
  try {
    localStorage.setItem(savedRecipeKey, JSON.stringify(items));
    state.savedRecipes = items;
    showToast(message);
    return true;
  } catch {
    showToast('브라우저 저장소를 사용할 수 없습니다.', true);
    return false;
  }
}

async function loadSavedRecipe(id) {
  if (remoteActionUnavailable()) return;
  const item = state.savedRecipes.find((saved) => saved.id === id);
  const recipe = state.catalog.recipes.find((entry) => entry.id === item?.recipeId);
  const knownFragments = new Set([...state.catalog.fragments, ...state.catalog.skills].map((entry) => entry.id));
  if (!item || !recipe || item.fragmentIds.some((fragmentId) => !knownFragments.has(fragmentId))) {
    showToast('현재 레지스트리와 일치하지 않는 레시피입니다. 다시 조합해 주세요.', true);
    return;
  }
  state.selectedRecipeId = item.recipeId;
  state.additionalFragments = new Set(item.fragmentIds.filter((fragmentId) => !recipe.fragments.includes(fragmentId)));
  state.composition = null;
  state.tab = 'recipes';
  await composeRecipe();
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    showToast('운영 명령을 복사했습니다.');
  } catch {
    showToast('클립보드 권한을 확인해 주세요.', true);
  }
}

function filteredSkills() {
  const query = normalize(state.query);
  return state.catalog.skills.filter((skill) => {
    if (state.category !== 'all' && skill.category !== state.category) return false;
    if (state.risk !== 'all' && skill.risk.level !== state.risk) return false;
    if (state.provider === 'ready' && !skill.providerStatus.ready) return false;
    if (state.provider === 'configurable' && !needsSkillSetup(skill)) return false;
    if (!query) return true;
    const haystack = normalize([skill.id, skillLabel(skill.id), skill.category, ...(skill.tags ?? []), ...(skill.providers ?? [])].join(' '));
    return query.split(/\s+/).every((token) => haystack.includes(token));
  });
}

function selectedSkill() {
  return state.catalog?.skills.find((skill) => skill.id === state.selectedSkillId) ?? null;
}

function selectedRecipe() {
  return state.catalog?.recipes.find((recipe) => recipe.id === state.selectedRecipeId) ?? null;
}

function readSavedRecipes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(savedRecipeKey) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item
      && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.recipeId === 'string'
      && Number.isInteger(item.skillCount) && item.skillCount > 0 && item.skillCount <= 25
      && Array.isArray(item.fragmentIds) && item.fragmentIds.length <= 100
      && item.fragmentIds.every((id) => typeof id === 'string')).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function remoteActionUnavailable() {
  return Boolean(state.loading || state.error || state.busyAction || !state.status?.ready || !state.catalog?.validation?.valid);
}

function needsSkillSetup(skill) {
  return !skill.providerStatus?.ready || !skill.dependencyReport || skill.dependencyReport.needsConfiguration > 0;
}

function dependencyLabel(status) {
  return ({ ready: '확인됨', optional: '선택 사항', missing: '설치 필요', 'needs-install': '설치 확인 필요',
    'needs-user-configuration': '계정 설정 필요', 'needs-runtime-probe': '환경 점검 필요' })[status] ?? '확인 필요';
}

function skillLabel(id) {
  if (!id) return '';
  if (phraseLabels[id]) return phraseLabels[id];
  return String(id).split('-').map((token) => tokenLabels[token] ?? token.toUpperCase()).join(' ');
}

function riskLabel(risk = {}) {
  if (risk.level === 'high') return '높음';
  if (risk.requiresApproval || risk.level === 'medium') return '승인';
  return '낮음';
}

function friendlyError(error) {
  if (error?.status === 502) return 'JARVIS Core가 응답하지 않습니다. 실행 상태를 확인해 주세요.';
  if (error?.status === 401 || error?.status === 403) return '관리 권한을 확인할 수 없습니다.';
  if (error?.code === 'NEXUS_TIMEOUT') return error.message;
  if (error instanceof TypeError) return '서비스 연결을 확인하지 못했습니다. 제어 센터에서 연결을 검사해 주세요.';
  return '요청을 처리하지 못했습니다. 연결 상태와 입력 내용을 확인해 주세요.';
}

function showToast(message, isError = false) {
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast visible${isError ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.className = 'toast';
  }, 2800);
}

function metric(label, value, tone = '') {
  return `<div class="metric ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function tabButton(id, label) {
  return `<button type="button" class="tab-button ${state.tab === id ? 'active' : ''}" data-tab="${id}" aria-pressed="${state.tab === id}">${escapeHtml(label)}</button>`;
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function resultFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function factRow(label, value) {
  return `<div class="fact-row"><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function inspectorFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function groupBy(items, keySelector) {
  return items.reduce((groups, item) => {
    const key = keySelector(item);
    groups[key] ??= [];
    groups[key].push(item);
    return groups;
  }, {});
}

function shortDigest(value) {
  const text = String(value ?? '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
