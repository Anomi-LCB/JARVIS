const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderIntegrationReadiness(readiness, { kind = 'all' } = {}) {
  if (kind !== 'all') {
    const agent = kind === 'agents';
    const names = agent ? new Set(['openai-agents']) : new Set(['xai', 'meta', 'gemini']);
    readiness = { ...readiness, capabilities: null, externalCapabilityEvaluation: null,
      connections: readiness?.connections?.filter(item => agent ? item.connectorId === 'jarvis-openai-agents' : item.connectorId !== 'jarvis-openai-agents'),
      modelProviders: { configuration: readiness?.modelProviders?.configuration?.filter(item => names.has(item.provider ?? item.id)) },
      credentialProviderFilter: agent ? 'agents' : 'api' };
  }
  const capabilities = readiness?.capabilities;
  const modelProviders = readiness?.modelProviders?.configuration;
  const credentialSetup = renderProviderCredentialSetup(readiness);
  if (!capabilities?.availability && !Array.isArray(modelProviders) && !Array.isArray(readiness?.connections) && !readiness?.externalCapabilityEvaluation && !credentialSetup) {
    return '<section class="integration-readiness" aria-label="계정 및 기기 연결 검증"><h3>계정 및 기기 연결 검증</h3><p>연결 검증 상태를 아직 확인하지 못했습니다. 서비스 연결만으로 실제 업무가 검증되지는 않습니다.</p></section>';
  }
  const availability = capabilities?.availability;
  const base = availability ? renderCapabilityAvailability(capabilities, availability) : '';
  return `<section class="integration-readiness" aria-label="계정 및 기기 연결 검증">
    <h3>${kind === 'agents' ? '에이전트 자격증명' : kind === 'api' ? '모델 API 자격증명' : '계정 및 기기 연결 검증'}</h3>
    ${base}
    ${readiness?.externalCapabilityEvaluation ? renderExternalCapability(readiness.externalCapabilityEvaluation) : ''}
    ${Array.isArray(modelProviders) ? renderModelProviders(modelProviders) : ''}
    ${renderProviderCredentialChecks(readiness?.connections, { canManage: readiness?.canManageIntegrations === true, busyProvider: readiness?.providerVerifyBusy ?? null })}
    ${credentialSetup}
  </section>`;
}

function renderProviderCredentialSetup(readiness) {
  if (readiness?.canSetupProviderCredentials !== true) return '';
  const busy = readiness.providerSetupBusy === true;
  return `<form class="model-provider-readiness" data-provider-credential-setup>
    <h4>모델 제공자 키를 JARVIS에 안전하게 연결</h4>
    <p>API 키를 채팅에 보내지 마세요. 선택한 제공자의 키만 현재 연결된 로컬 JARVIS Core로 전송해 Core 실행 계정의 Windows DPAPI 보호 저장소에 보관합니다. 저장만 하며 제공자 인증·모델 실행 권한은 부여되지 않습니다. 같은 제공자의 JARVIS 기본 키가 이미 있으면 새 키로 교체합니다.</p>
    <label>제공자 <select name="provider" required ${busy ? 'disabled' : ''}>
      ${readiness.credentialProviderFilter !== 'agents' ? '<option value="xai">xAI 모델 API</option><option value="meta">Meta 모델 API</option><option value="gemini">Gemini 개발자 API</option>' : ''}${readiness.credentialProviderFilter !== 'api' ? '<option value="openai-agents">OpenAI Agents 읽기 검증 전용</option>' : ''}
    </select></label>
    <label>API 키 <input type="password" name="apiKey" autocomplete="new-password" autocapitalize="none" spellcheck="false" maxlength="8192" required ${busy ? 'disabled' : ''} data-provider-key-input></label>
    <button type="submit" ${busy ? 'disabled' : ''}>${busy ? '보호 저장소에 전달 중…' : '로컬 보호 저장소에 저장'}</button>
    <p>저장 후에도 별도의 사용자가 누르는 읽기 검증이 필요합니다. Meta 권한·요금이나 공급자 정책은 여기서 확인되지 않습니다.</p>
    ${readiness.credentialProviderFilter !== 'api' ? '<p><strong>OpenAI Agents를 고르면:</strong> 이 키 저장·읽기 검증은 세션을 만들지 않습니다. 이후 관리형 세션은 입력과 세션 상태를 원격에 보존할 수 있고, 현재 공식 조건은 미국 데이터 거주만 지원하며 ZDR을 지원하지 않습니다. 모델·도구·호스팅 샌드박스 비용이 따로 발생할 수 있습니다. 개인자료를 보내기 전 데이터 범위와 조직 정책을 확인하세요.</p>' : ''}
  </form>`;
}

function renderProviderCredentialChecks(connections, { canManage = false, busyProvider = null } = {}) {
  if (!Array.isArray(connections)) return '';
  const providers = new Set(['jarvis-model-xai', 'jarvis-model-meta', 'jarvis-model-gemini', 'jarvis-openai-agents']);
  const checked = connections.filter(item => providers.has(item?.connectorId));
  if (!checked.length) return '';
  const providerLabels = { 'jarvis-model-xai': 'xAI', 'jarvis-model-meta': 'Meta', 'jarvis-model-gemini': 'Gemini', 'jarvis-openai-agents': 'OpenAI Agents' };
  const providerIds = { 'jarvis-model-xai': 'xai', 'jarvis-model-meta': 'meta', 'jarvis-model-gemini': 'gemini', 'jarvis-openai-agents': 'openai-agents' };
  const stateLabels = {
    verified: '읽기 검증 성공',
    'authentication-rejected': '인증 거부 · 키 만료·폐기 여부 확인',
    'authorization-rejected': '권한 거부 · 키 scope와 제공자 조직/프로젝트 정책 확인',
    'rate-limited': '요청 제한 · 잠시 후 다시 점검',
    'provider-unavailable': '제공자 응답 없음 · 네트워크와 제공자 상태 확인',
    'invalid-response': '예상하지 못한 응답 · 제공자 API 버전 확인',
    'model-unavailable': '요청 모델을 사용할 수 없음 · 프로젝트 권한 확인'
  };
  return `<div class="model-provider-readiness" aria-label="제공자 자격증명 점검 결과">
    <h4>저장된 제공자 연결 점검</h4>
    <p>보호 저장소의 자격증명 존재와 제공자 읽기 검증은 별도 상태입니다. 제공자 응답 본문이나 키는 화면에 표시하지 않습니다.</p>
    <ul>${checked.map(item => {
      const verification = item.providerVerification;
      const provider = providerIds[item.connectorId];
      const busy = busyProvider === provider;
      const state = verification?.checkedAt ? stateLabels[verification.status] ?? '점검 상태 확인 필요' : '아직 제공자 읽기 검증을 하지 않았습니다.';
      const detail = verification?.checkedAt ? `점검 ${escapeHtml(verification.checkedAt)} · ${escapeHtml(verification.errorCode ?? '오류 코드 없음')} · 실행 권한 없음` : '저장된 키의 존재와 실제 API 접근을 구분합니다. 점검은 읽기 전용 모델 목록 조회만 합니다.';
      return `<li><strong>${escapeHtml(providerLabels[item.connectorId])}</strong><span>${escapeHtml(state)}</span><small>${detail}</small><button type="button" data-verify-model-provider="${provider}" ${!canManage || busy ? 'disabled' : ''}>${busy ? '확인 중…' : '저장된 키 연결 확인'}</button></li>`;
    }).join('')}</ul>
    ${canManage ? '<p>버튼을 누를 때만 제공자 모델 목록 API에 읽기 요청을 보냅니다. 모델 실행 권한은 부여하지 않습니다.</p>' : '<p>연결 점검을 실행하려면 통합 관리 권한이 필요합니다.</p>'}
    <p>403은 정책 또는 scope 거부 신호이며 구체 원인은 제공자 조직 설정에서 확인해야 합니다. JARVIS가 응답 본문을 추측해 원인을 확정하지 않습니다.</p>
    ${checked.some(item => item.connectorId === 'jarvis-openai-agents') ? '<p>OpenAI Agents 키 검증은 읽기 전용 모델 목록 조회입니다. 향후 관리형 세션을 사용할 경우 현재 공식 조건의 미국 데이터 거주·no-ZDR 및 별도 모델/도구/호스팅 비용을 고려해야 합니다. 저장·검증 상태만으로 세션 실행을 허용하지 않습니다.</p>' : ''}
  </div>`;
}

function renderExternalCapability(result) {
  const supported = result.providerAvailability === 'eligible' ? '조건상 사용 가능' : result.providerAvailability === 'unavailable' ? '현재 조건에서 지원되지 않음' : result.providerAvailability === 'requirements-missing' ? '필수 조건 미충족' : '조건 미확인';
  const direction = result.offer?.direction === 'provider-calls-jarvis'
    ? 'Gemini가 JARVIS를 호출하는 연결입니다. JARVIS가 Gemini를 호출하는 API와는 다른 방향입니다.'
    : '연결 방향을 확인할 수 없습니다.';
  const alternative = Array.isArray(result.alternatives) && result.alternatives.length
    ? result.alternatives.map(item => `<li><strong>${escapeHtml(item.toolName)}</strong> · 부분 보조 · ${escapeHtml(item.description)}</li>`).join('')
    : '<li>현재 준비된 부분 대안이 없습니다.</li>';
  const reasons = [...(result.unsupportedReasons ?? []), ...(result.missingRequirements ?? []).map(key => `미확인 조건: ${key}`), ...(result.unmetRequirements ?? []).map(key => `미충족 조건: ${key}`)];
  return `<div class="external-capability-readiness" aria-label="외부 앱 기능 조건">
    <h4>${escapeHtml(result.offer?.provider ?? '외부 앱')} · ${escapeHtml(result.offer?.feature ?? '기능')}</h4>
    <p>${supported}. ${escapeHtml(direction)}</p>
    ${reasons.length ? `<p>확인 내용: ${reasons.map(escapeHtml).join(' · ')}</p>` : ''}
    <ul>${alternative}</ul>
    <p>이 진단은 외부 연결이나 실행 권한을 만들지 않습니다. 실제 사용 가능성은 제공자 계정·제품 조건에서 별도로 확인해야 합니다.</p>
  </div>`;
}

function renderCapabilityAvailability(capabilities, availability) {
  const items = Array.isArray(availability.items) ? availability.items : [];
  const verified = items.filter(item => item.available && ['live-execution', 'repeated-live'].includes(item.verificationLevel)).length;
  const probed = items.filter(item => item.available && item.verificationLevel === 'live-probe').length;
  const pending = items.filter(item => !item.available).length;
  const labels = { available: '현재 준비됨', blocked: '연결 조건 확인 필요', unknown: '미확인', unverified: '실사용 미검증' };
  return `<div class="integration-capabilities">
    <p>실행 증거가 있는 연결 ${verified}개 · 읽기 점검만 확인 ${probed}개 · 추가 확인 ${pending}개</p>
    <p>등록된 실행 코드 ${Number(capabilities.codeReadyCount) || 0}개. 등록 수는 실계정·실기기에서 검증된 기능 수와 다릅니다.</p>
    ${items.length ? `<ul>${items.map(item => `<li><strong>${escapeHtml(item.capabilityId)}</strong> · ${escapeHtml(labels[item.status] ?? '미확인')}<small>${escapeHtml(item.nextAction ?? '이 연결에서 실행할 때 현재 권한과 업무 조건을 확인합니다.')}</small></li>`).join('')}</ul>`
      : '<p>계정·기기별 최근 점검 기록이 없습니다. 공식 연결 후 허용된 읽기 검사부터 진행합니다.</p>'}
  </div>`;
}

function renderModelProviders(providers) {
  const entries = providers.filter(item => ['ollama-local', 'xai', 'meta', 'gemini', 'gemini-interactions'].includes(item.provider));
  if (!entries.length) return '<div class="model-provider-readiness"><h4>AI 모델 연결</h4><p>제공자 상태를 불러오지 못했습니다.</p></div>';
  return `<div class="model-provider-readiness" aria-label="AI 모델 연결 상태">
    <h4>AI 모델 연결</h4>
    <p>이 상태는 설정 진단입니다. 실제 계정 연결이나 모델 응답을 확인한 결과가 아닙니다. Ollama는 이 PC의 로컬 런타임 상태를 별도로 확인해야 합니다.</p>
    <ul>${entries.map(item => {
      const local = item.provider === 'ollama-local';
      const state = local && item.stage === 'configured-unverified'
        ? '모델 선택됨 · 로컬 런타임/모델 미검증'
        : item.stage === 'configured-unverified' && item.connectionStatus === 'unverified'
          ? '설정됨 · 서버 연결 미검증'
        : item.configurationError ? `설정 확인 필요 · ${escapeHtml(item.configurationError)}`
          : item.selected && !item.credentialPresent && !local ? '모델 선택됨 · API 키 필요'
            : '설정 필요';
      const model = typeof item.model === 'string' ? escapeHtml(item.model) : '모델 미선택';
      const credential = local ? 'API 키 불필요 · 로컬 런타임'
        : item.credentialPresent
        ? item.credentialSource === 'dpapi-vault' ? 'DPAPI 보관소에 키 저장' : '런타임 키 설정 존재'
        : '키 없음';
      const nextAction = item.nextAction ? ` · 다음: ${escapeHtml(item.nextAction)}` : '';
      return `<li><strong>${escapeHtml(item.surfaceLabel ?? item.provider)}</strong><span>${state}</span><small>${model} · ${credential}${nextAction}</small><small>${escapeHtml(item.integrationScope ?? '지원 범위 미확인')} · ${escapeHtml(item.productBoundary ?? '완제품 에이전트 연동 여부 미확인')}</small></li>`;
    }).join('')}</ul>
    <p>완제품 에이전트 앱(Grok Bot·Muse·Gemini Spark) 연동과 모델 API 연결은 별개입니다. 현재 연결 경로는 JARVIS Mission의 텍스트 계획이며, 이 화면만으로 실제 계정 연결·실행 권한·업무 성공을 뜻하지 않습니다.</p>
    <p>키 자체는 이 화면이나 상태 응답에 표시하지 않습니다. 설정 변경은 Core 런타임 재시작 후 반영됩니다.</p>
  </div>`;
}
