export function createPairingQrPayload({ pairingId = null, pairingCode, bridgeUrl, expiresAt, version = 2 } = {}) {
  const params = new URLSearchParams();
  if (pairingId) params.set('pairingId', pairingId);
  params.set('code', pairingCode ?? '');
  params.set('bridge', bridgeUrl ?? '');
  params.set('expiresAt', expiresAt ?? '');
  return {
    scheme: 'jarvis',
    type: 'pairing',
    version,
    pairingId,
    pairingCode,
    bridgeUrl,
    expiresAt,
    qrText: `jarvis://pair?${params.toString()}`
  };
}

export function createPairingInputState({ pairingCode = '', bridgeUrl = 'http://127.0.0.1:17777', expiresAt = null, nowMs = Date.now() } = {}) {
  const normalizedCode = String(pairingCode ?? '').trim();
  const validCode = /^\d{6,12}$/.test(normalizedCode);
  const validBridge = /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(bridgeUrl ?? ''));
  const expired = expiresAt ? Date.parse(expiresAt) <= nowMs : false;
  return {
    pairingCode: normalizedCode,
    bridgeUrl,
    expiresAt,
    validCode,
    validBridge,
    expired,
    canConfirm: validCode && validBridge && !expired,
    validation: {
      message: !validCode
        ? '6자리 이상의 숫자 페어링 코드를 입력해야 합니다.'
        : !validBridge
          ? '로컬/사설 네트워크 브릿지 주소만 사용할 수 있습니다.'
          : expired
            ? '페어링 코드가 만료되었습니다.'
            : null
    }
  };
}

export function parsePairingQrText(qrText, { nowMs = Date.now() } = {}) {
  try {
    const url = new URL(String(qrText ?? ''));
    if (url.protocol !== 'jarvis:' || url.host !== 'pair') {
      return { success: false, error: { code: 'C_PAIRING_QR_UNSUPPORTED_SCHEME' } };
    }
    const pairingId = url.searchParams.get('pairingId');
    const pairingCode = url.searchParams.get('code') ?? '';
    const bridgeUrl = url.searchParams.get('bridge') ?? '';
    const expiresAt = url.searchParams.get('expiresAt');
    const inputState = createPairingInputState({ pairingCode, bridgeUrl, expiresAt, nowMs });
    return {
      success: inputState.canConfirm,
      scannerContractVersion: 'c-native-qr-scanner-contract-v1',
      pairingId,
      pairingCode,
      bridgeUrl,
      expiresAt,
      inputState,
      error: inputState.canConfirm ? null : { code: 'C_PAIRING_QR_INVALID_PAYLOAD', validation: inputState.validation }
    };
  } catch {
    return { success: false, error: { code: 'C_PAIRING_QR_PARSE_FAILED' } };
  }
}

export function createQrScannerPermissionState({ cameraPermission = 'unknown', scannerAvailable = true, platform = 'native' } = {}) {
  const granted = ['granted', 'authorized'].includes(cameraPermission);
  const denied = ['denied', 'blocked'].includes(cameraPermission);
  return {
    scannerContractVersion: 'c-native-qr-scanner-contract-v1',
    platform,
    cameraPermission,
    scannerAvailable,
    canScan: scannerAvailable && granted,
    needsPermission: scannerAvailable && !granted,
    primaryAction: !scannerAvailable
      ? 'manual_code_entry'
      : granted
        ? 'scan_qr_code'
        : denied
          ? 'open_camera_settings'
          : 'request_camera_permission',
    fallbackAction: 'manual_code_entry',
    message: !scannerAvailable
      ? 'QR 스캐너를 사용할 수 없어 수동 코드 입력으로 진행합니다.'
      : granted
        ? '카메라 권한이 있어 QR 페어링을 시작할 수 있습니다.'
        : denied
          ? '카메라 권한이 차단되어 설정에서 권한을 허용해야 합니다.'
          : 'QR 페어링을 위해 카메라 권한 요청이 필요합니다.'
  };
}

export function createMdnsBridgeAllowlistReviewState({
  services = [],
  allowedHostnames = [],
  selectedHostnames = [],
  bridgePort = 17777
} = {}) {
  const allowedSet = new Set(allowedHostnames.map(normalizePairingHost).filter(Boolean));
  const selectedSet = new Set(selectedHostnames.map(normalizePairingHost).filter(Boolean));
  const rows = services.map((service, index) => {
    const hostname = normalizePairingHost(service.hostname ?? service.host ?? service.name);
    const alreadyAllowed = allowedSet.has(hostname);
    const selected = selectedSet.has(hostname);
    return {
      rowVersion: 'c-mdns-bridge-allowlist-row-v1',
      serviceId: service.serviceId ?? `mdns_bridge_${index + 1}`,
      displayName: service.displayName ?? service.name ?? hostname,
      hostname,
      serviceType: service.serviceType ?? service.type ?? '_jarvis._tcp.local',
      bridgeUrlPreview: hostname ? `http://${hostname}:${service.port ?? bridgePort}` : null,
      state: alreadyAllowed ? 'already-allowed' : (selected ? 'selected-for-allowlist' : 'needs-review'),
      primaryAction: alreadyAllowed ? 'keep' : 'allow_this_bridge',
      secondaryAction: alreadyAllowed ? 'remove' : 'reject',
      rawSecretStored: false
    };
  });
  const proposedHostnames = [
    ...allowedSet,
    ...rows.filter((row) => row.state === 'selected-for-allowlist').map((row) => row.hostname)
  ].filter(Boolean);
  return {
    reviewVersion: 'c-mdns-bridge-allowlist-review-ui-v1',
    state: rows.some((row) => row.state === 'needs-review') ? 'review-required' : 'ready',
    rowCount: rows.length,
    selectedCount: rows.filter((row) => row.state === 'selected-for-allowlist').length,
    proposedHostnames: [...new Set(proposedHostnames)],
    bridgeAllowedHostsPreview: [...new Set(proposedHostnames)].join(','),
    rows
  };
}

export function createPairingRecoveryState({ errorCode = null, tokenStatus = null, pairingStatus = 'unpaired', bridgeUrl = 'http://127.0.0.1:17777' } = {}) {
  const expired = errorCode === 'D_AUTH_TOKEN_EXPIRED' || tokenStatus === 'expired';
  const revoked = errorCode === 'D_AUTH_INVALID_TOKEN' || tokenStatus === 'revoked';
  const locked = errorCode === 'D_PAIRING_CODE_LOCKED';
  const invalidCode = errorCode === 'D_PAIRING_CODE_INVALID' || errorCode === 'D_PAIRING_SESSION_MISMATCH';
  return {
    recoveryVersion: 'c-pairing-recovery-state-v1',
    pairingStatus,
    bridgeUrl,
    errorCode,
    tokenStatus,
    canRestartPairing: expired || revoked || locked || pairingStatus === 'unpaired',
    canClearToken: expired || revoked,
    canRetryCode: invalidCode,
    recommendedAction: expired || revoked
      ? 'clear_token_and_start_pairing'
      : locked
        ? 'start_new_pairing_session'
        : invalidCode
          ? 'retry_pairing_code'
          : pairingStatus === 'paired'
            ? 'verify_connection_heartbeat'
            : 'start_pairing',
    message: expired
      ? '저장된 토큰이 만료되어 새 QR 코드로 다시 페어링해야 합니다.'
      : revoked
        ? '이 기기의 토큰이 더 이상 유효하지 않아 로컬 토큰을 지우고 재페어링해야 합니다.'
        : locked
          ? '페어링 코드 시도가 잠겨 새 코드를 발급해야 합니다.'
          : invalidCode
            ? '페어링 코드 또는 세션이 맞지 않습니다.'
            : pairingStatus === 'paired'
              ? '페어링 상태를 heartbeat로 확인할 수 있습니다.'
              : '페어링을 시작할 수 있습니다.'
  };
}

function normalizePairingHost(value) {
  if (!value) return '';
  let host = String(value).trim().toLowerCase();
  if (host.startsWith('http://') || host.startsWith('https://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      host = host.replace(/^https?:\/\//i, '').split('/')[0];
    }
  }
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end >= 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) ?? []).length === 1) {
    host = host.split(':')[0];
  }
  return host.endsWith('.') ? host.slice(0, -1) : host;
}
