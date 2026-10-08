import { mapViewPointToDevice, screenViewDimensions } from './screen-geometry.js';

const savedScreenOrientation = localStorage.getItem('rokid-screen-orientation');
const state = {
  token: '',
  status: null,
  overview: null,
  packages: [],
  packageFilter: 'rokid',
  settings: [],
  settingsScope: 'system',
  update: null,
  backupJob: null,
  profiles: null,
  fineTune: null,
  fineCategory: '추천',
  liveScreen: {
    active: false,
    pointer: null,
    ready: false,
    generation: 0,
    objectUrl: '',
    // Rokid stores its framebuffer as 480x640, but the optical HUD is already
    // drawn horizontally in the centered 480x360 band. Older builds rotated
    // the complete PNG, which incorrectly turned the HUD text on its side.
    orientation: savedScreenOrientation === 'portrait' ? 'portrait' : 'hud-landscape'
  },
  expertMode: localStorage.getItem('rokid-expert-mode') === 'true',
  preparedPackages: new Set()
};

const viewLabels = {
  dashboard: ['오늘의 안경 상태', '내 안경'],
  controls: ['보고 느끼는 대로', '쉽게 조절'],
  'fine-tune': ['내부까지 한눈에', '세밀 조정'],
  apps: ['설치된 앱을 한눈에', '앱 열기와 정리'],
  backup: ['문제가 생기기 전에', '안전 백업'],
  updates: ['확인하고 안전하게', '업데이트'],
  diagnostics: ['PC에서 그대로 조작', '실시간 안경 화면'],
  settings: ['전문가 전용', '전체 설정값']
};

boot().catch((error) => showToast(error.message, true));

async function boot() {
  applyMode();
  state.token = (await fetchJson('/api/session')).token;
  bindEvents();
  startServerHeartbeat();
  await refreshAll();
}

function startServerHeartbeat() {
  setInterval(() => fetch('/api/health', { cache: 'no-store' }).catch(() => {}), 5_000);
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => {
    await switchView(button.dataset.view);
    const target = button.dataset.focusControl && document.querySelector(`[data-control-section="${button.dataset.focusControl}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  document.querySelector('[data-mode-toggle]').addEventListener('click', toggleMode);
  document.querySelector('[data-refresh]').addEventListener('click', refreshAll);
  document.querySelectorAll('[data-go-backup]').forEach((button) => button.addEventListener('click', () => switchView('backup')));
  document.querySelectorAll('[data-backup-mode]').forEach((button) => button.addEventListener('click', () => startBackup(button.dataset.backupMode)));
  document.querySelectorAll('[data-key]').forEach((button) => button.addEventListener('click', () => runControl(
    { action: 'key', value: button.dataset.key },
    button.dataset.key === 'power' ? '안경 화면 전원 버튼을 눌렀어요.' : '버튼을 눌렀어요.',
    button.dataset.key === 'power'
  )));

  const brightness = document.querySelector('[data-brightness]');
  brightness.addEventListener('input', () => updateBrightnessVisual(Number(brightness.value)));
  brightness.addEventListener('change', () => runControl({ action: 'brightness', value: Number(brightness.value) }, '화면 밝기를 바꿨어요.', true));
  document.querySelectorAll('[data-brightness-preset]').forEach((button) => button.addEventListener('click', async () => {
    const value = Number(button.dataset.brightnessPreset);
    brightness.value = String(value);
    updateBrightnessVisual(value);
    await runControl({ action: 'brightness', value }, '화면 밝기를 바꿨어요.', true);
  }));
  document.querySelectorAll('[data-radio]').forEach((button) => button.addEventListener('click', () => toggleRadio(button)));
  document.querySelector('[data-rotation]').addEventListener('click', () => toggleRotation());
  document.querySelectorAll('[data-timeout-preset]').forEach((button) => button.addEventListener('click', () => setScreenTimeout(button)));
  document.querySelectorAll('[data-power-action]').forEach((button) => button.addEventListener('click', () => runPowerAction(button.dataset.powerAction)));
  document.querySelector('[data-profile-list]').addEventListener('click', applyProfileFromCard);
  document.querySelector('[data-save-profile]').addEventListener('click', openSaveProfileDialog);
  document.querySelector('[data-profile-undo-button]').addEventListener('click', undoLastProfile);
  document.querySelector('[data-profile-form]').addEventListener('submit', saveProfileFromDialog);

  document.querySelector('[data-package-search]').addEventListener('input', renderPackages);
  document.querySelectorAll('[data-package-filter]').forEach((button) => button.addEventListener('click', () => {
    state.packageFilter = button.dataset.packageFilter;
    renderPackages();
  }));
  document.querySelector('[data-package-table]').addEventListener('click', handlePackageAction);
  document.querySelector('[data-fine-tune-search]').addEventListener('input', renderFineTune);
  document.querySelectorAll('[data-fine-category]').forEach((button) => button.addEventListener('click', () => {
    state.fineCategory = button.dataset.fineCategory;
    renderFineTune();
  }));
  document.querySelector('[data-fine-tune-list]').addEventListener('click', handleFineTuneAction);
  document.querySelector('[data-fine-tune-undo-button]').addEventListener('click', undoFineTune);
  document.querySelector('[data-raw-labels]').addEventListener('change', renderFineTune);
  document.querySelectorAll('[data-settings-scope]').forEach((button) => button.addEventListener('click', () => loadSettings(button.dataset.settingsScope)));
  document.querySelector('[data-settings-search]').addEventListener('input', renderSettings);
  document.querySelector('[data-live-toggle]').addEventListener('click', toggleLiveScreen);
  document.querySelector('[data-live-orientation]').addEventListener('click', toggleLiveOrientation);
  document.querySelector('[data-live-open-app]').addEventListener('click', openSelectedAppOnScreen);
  bindLiveScreenPointer();
  document.querySelector('[data-audit-refresh]').addEventListener('click', loadAudit);
  document.querySelector('[data-logcat]').addEventListener('click', loadLogcat);
  document.querySelector('[data-update-refresh]').addEventListener('click', loadUpdateStatus);
  document.querySelector('[data-open-update-inbox]').addEventListener('click', openUpdateInbox);
  document.querySelector('[data-update-packages]').addEventListener('click', prepareUpdatePackage);
  const updateFile = document.querySelector('[data-update-file]');
  const dropZone = document.querySelector('[data-update-drop-zone]');
  document.querySelector('[data-update-file-button]').addEventListener('click', () => updateFile.click());
  updateFile.addEventListener('change', () => importUpdateFile(updateFile.files[0]));
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    importUpdateFile(event.dataTransfer.files[0]);
  });
}

function toggleMode() {
  state.expertMode = !state.expertMode;
  localStorage.setItem('rokid-expert-mode', String(state.expertMode));
  applyMode();
  if (!state.expertMode && document.querySelector('[data-view-panel="settings"]').classList.contains('active')) switchView('dashboard');
  renderPackages();
  if (state.fineTune) renderFineTune();
}

function applyMode() {
  document.body.dataset.mode = state.expertMode ? 'expert' : 'easy';
  const button = document.querySelector('[data-mode-toggle]');
  button.setAttribute('aria-pressed', String(state.expertMode));
  button.querySelector('strong').textContent = state.expertMode ? '전문가 모드' : '쉬운 모드';
  button.querySelector('small').textContent = state.expertMode ? '쉬운 화면으로' : '전문가 보기';
}

async function refreshAll() {
  const button = document.querySelector('[data-refresh]');
  button.disabled = true;
  try {
    state.status = await fetchJson('/api/status');
    renderConnection();
    const rokid = state.status.devices.find((item) => item.isRokid && item.authorized);
    if (!rokid) throw new Error('연결된 Rokid 안경을 찾지 못했어요. USB 케이블과 안경의 디버깅 허용 화면을 확인해 주세요.');
    state.overview = await fetchJson(`/api/device/overview?serial=${encodeURIComponent(rokid.serial)}`);
    renderOverview();
  } catch (error) {
    renderDisconnected(error.message);
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderConnection() {
  const rokid = state.status?.devices?.find((item) => item.isRokid && item.authorized);
  document.querySelector('[data-connection-dot]').classList.toggle('online', Boolean(rokid));
  document.querySelector('[data-connection-label]').textContent = rokid ? '안경 연결됨' : '연결 기다리는 중';
  document.querySelector('[data-device-serial]').textContent = rokid?.serial ?? 'USB를 연결해 주세요';
  const backup = state.status?.latestBackup;
  document.querySelector('[data-latest-backup]').innerHTML = backup
    ? `<strong>${backup.mode === 'full' ? '꼼꼼한 전체 백업' : '빠른 안전 백업'} 완료</strong><br>${escapeHtml(formatDate(backup.completedAt))}<br>${backup.fileCount}개 항목을 안전하게 저장했어요.`
    : '아직 저장된 복구 지점이 없어요.<br>처음 바꾸기 전에 빠른 안전 백업을 권장합니다.';
  document.querySelector('[data-backup-short]').textContent = backup ? formatRelativeDate(backup.completedAt) : '아직 없음';
  document.querySelector('[data-backup-readiness]').textContent = backup ? '백업 완료' : '백업 권장';
}

function renderDisconnected(message) {
  document.querySelector('[data-friendly-headline]').textContent = '안경 연결을 기다리고 있어요';
  document.querySelector('[data-friendly-summary]').textContent = message;
  document.querySelector('[data-connection-dot]').classList.remove('online');
  document.querySelector('[data-connection-label]').textContent = '연결 기다리는 중';
}

function renderOverview() {
  const overview = state.overview;
  const properties = overview.properties;
  const modelName = `${properties.manufacturer || 'Rokid'} ${properties.model || '안경'}`;
  document.querySelector('[data-friendly-headline]').textContent = `${modelName}, 사용할 준비가 됐어요`;
  document.querySelector('[data-friendly-summary]').textContent = `배터리 ${overview.battery.level ?? '—'}% · Wi-Fi ${overview.wifi.enabled ? '켜짐' : '꺼짐'} · 화면 밝기 ${toPercent(overview.controls.brightness)}%`;
  document.querySelector('[data-model]').textContent = modelName;
  document.querySelector('[data-build]').textContent = `Android ${properties.android} · API ${properties.sdk} · ${properties.buildId}`;
  document.querySelector('[data-security-badge]').textContent = overview.access.bootloaderUnlocked ? '부트로더 잠금 해제' : '부트로더 잠김';
  document.querySelector('[data-current-activity]').textContent = overview.currentActivity || '현재 화면 미확인';
  document.querySelector('[data-battery]').textContent = `${overview.battery.level ?? '—'}%`;
  document.querySelector('[data-power-state]').textContent = overview.battery['AC powered'] === 'true' ? '전원 연결됨' : overview.battery['USB powered'] === 'true' ? 'USB로 충전 중' : '배터리 사용 중';
  document.querySelector('[data-storage]').textContent = overview.storage.available || '—';
  document.querySelector('[data-storage-detail]').textContent = `전체 ${overview.storage.size || '—'} 중 남은 공간`;
  document.querySelector('[data-display]').textContent = `${overview.display.width}×${overview.display.height}`;
  document.querySelector('[data-density]').textContent = `${overview.display.density} dpi`;
  document.querySelector('[data-access-level]').textContent = overview.access.bootloaderUnlocked ? '확장 접근 가능' : '일반 제어';
  document.querySelector('[data-access-grid]').innerHTML = [
    ['안경 명령', overview.access.adbAuthorized, '허용됨'],
    ['부트로더', overview.access.bootloaderUnlocked, overview.access.bootloaderUnlocked ? '잠금 해제' : '잠김'],
    ['디버그 앱 데이터', true, '접근 가능'],
    ['원시 파티션', overview.access.rawPartitionBackupAvailable, '복구 준비 필요']
  ].map(([label, yes, value]) => `<div class="access-item ${yes ? 'yes' : 'no'}"><span>${label}</span><strong>${yes ? '●' : '○'} ${value}</strong></div>`).join('');
  const features = overview.features.filter((feature) => /camera|sensor|bluetooth|wifi|audio|microphone|usb|vulkan|location/.test(feature));
  document.querySelector('[data-feature-count]').textContent = `${overview.features.length}개 감지`;
  document.querySelector('[data-feature-list]').innerHTML = features.map((feature) => `<span>${escapeHtml(feature.replace('android.hardware.', '').replace('android.software.', 'sw.'))}</span>`).join('');
  document.querySelector('[data-boot-facts]').innerHTML = [
    ['활성 슬롯', properties.bootSlot || '—'], ['Verified Boot', properties.verifiedBoot || '—'], ['VBMeta', properties.vbmetaState || '—'], ['Flash Lock', properties.flashLocked || '—'], ['암호화', properties.cryptoState || '—'], ['SELinux', overview.selinux || '—']
  ].map(([key, value]) => `<div><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  syncVisualControls(overview);
  applyLiveOrientation();
  if (state.profiles) renderProfiles();
}

function syncVisualControls(overview) {
  const controls = overview.controls || {};
  const brightness = Number(controls.brightness) || 128;
  document.querySelector('[data-brightness]').value = String(brightness);
  updateBrightnessVisual(brightness);
  setRadioVisual(document.querySelector('[data-radio="wifi"]'), Boolean(overview.wifi?.enabled));
  setRadioVisual(document.querySelector('[data-radio="bluetooth"]'), Boolean(controls.bluetooth));
  const rotation = document.querySelector('[data-rotation]');
  rotation.setAttribute('aria-pressed', String(Boolean(controls.rotation)));
  rotation.querySelector('[data-rotation-label]').textContent = controls.rotation ? '켜짐' : '꺼짐';
  document.querySelectorAll('[data-timeout-preset]').forEach((button) => button.classList.toggle('active', Number(button.dataset.timeoutPreset) === Number(controls.screenTimeout)));
}

function updateBrightnessVisual(value) {
  const percent = toPercent(value);
  document.querySelector('[data-brightness-value]').textContent = String(value);
  document.querySelector('[data-brightness-percent]').textContent = `${percent}%`;
  document.querySelector('[data-screen-glow]').style.filter = `brightness(${0.55 + percent / 100})`;
  document.querySelector('[data-screen-glow]').style.boxShadow = `0 15px ${20 + Math.round(percent / 2)}px rgba(69,217,133,${0.12 + percent / 250})`;
  document.querySelectorAll('[data-brightness-preset]').forEach((button) => button.classList.toggle('active', Math.abs(Number(button.dataset.brightnessPreset) - value) < 30));
}

async function switchView(view) {
  if (view === 'settings' && !state.expertMode) return;
  if (view !== 'diagnostics') stopLiveScreen();
  document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === view));
  document.querySelector('[data-view-eyebrow]').textContent = viewLabels[view][0];
  document.querySelector('[data-view-title]').textContent = viewLabels[view][1];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'apps' && !state.packages.length) await loadPackages();
  if (view === 'controls' && !state.profiles) await loadProfiles();
  if (view === 'fine-tune' && !state.fineTune) await loadFineTune();
  if (view === 'settings' && !state.settings.length) await loadSettings('system');
  if (view === 'diagnostics') {
    if (!state.packages.length) await loadPackages();
    populateLiveAppSelect();
    await loadAudit();
    startLiveScreen();
  }
  if (view === 'updates') await loadUpdateStatus();
}

async function startBackup(mode) {
  if (state.backupJob) return showToast('이미 백업하고 있어요. 잠시만 기다려 주세요.');
  if (mode === 'full' && !window.confirm('꼼꼼한 전체 백업은 시간이 오래 걸리고 저장 공간을 많이 사용할 수 있어요. 계속할까요?')) return;
  const panel = document.querySelector('[data-backup-progress]');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.querySelectorAll('[data-backup-mode]').forEach((button) => button.disabled = true);
  try {
    const job = await fetchJson('/api/backup', { method: 'POST', body: { mode } });
    state.backupJob = job.id;
    await pollBackup(job.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.backupJob = null;
    document.querySelectorAll('[data-backup-mode]').forEach((button) => button.disabled = false);
  }
}

async function pollBackup(id) {
  while (true) {
    const job = await fetchJson(`/api/jobs/${id}`);
    document.querySelector('[data-backup-stage]').textContent = friendlyBackupStage(job.stage);
    document.querySelector('[data-backup-percent]').textContent = `${job.percent}%`;
    document.querySelector('[data-backup-bar]').style.width = `${job.percent}%`;
    document.querySelector('[data-backup-detail]').textContent = job.status === 'running' ? 'USB 연결과 안경 전원을 그대로 유지해 주세요.' : job.error || '안전하게 저장했어요.';
    if (job.status === 'completed') {
      showToast(`백업 완료! ${job.result.manifest.files.length}개 항목을 저장했어요.`);
      await refreshAll();
      return;
    }
    if (job.status === 'failed') throw new Error(job.error || '백업에 실패했어요.');
    await delay(900);
  }
}

function friendlyBackupStage(stage) {
  const value = String(stage || '').toLowerCase();
  if (value.includes('package') || value.includes('apk')) return '앱을 안전하게 복사하고 있어요';
  if (value.includes('storage') || value.includes('shared')) return '공유 파일을 복사하고 있어요';
  if (value.includes('manifest') || value.includes('hash')) return '파일이 온전한지 확인하고 있어요';
  if (value.includes('complete')) return '백업이 끝났어요';
  return stage || '백업을 준비하고 있어요';
}

async function runControl(payload, successMessage = '안경에 적용했어요.', refresh = false) {
  try {
    await fetchJson('/api/device/control', { method: 'POST', body: payload });
    showToast(successMessage);
    if (refresh) {
      if (payload.action === 'key' && payload.value === 'power') await delay(450);
      await refreshOverviewOnly();
    }
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
}

async function refreshOverviewOnly() {
  const rokid = state.status?.devices?.find((item) => item.isRokid && item.authorized);
  if (!rokid) return;
  state.overview = await fetchJson(`/api/device/overview?serial=${encodeURIComponent(rokid.serial)}`);
  renderOverview();
}

async function toggleRadio(button) {
  const current = button.dataset.enabled === 'true';
  button.disabled = true;
  const enabled = !current;
  const label = button.dataset.radio === 'wifi' ? 'Wi-Fi' : 'Bluetooth';
  const succeeded = await runControl({ action: button.dataset.radio, value: enabled }, `${label}를 ${enabled ? '켰어요' : '껐어요'}.`);
  if (succeeded) setRadioVisual(button, enabled);
  button.disabled = false;
}

function setRadioVisual(button, enabled) {
  button.dataset.enabled = String(enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.querySelector('[data-radio-label]').textContent = enabled ? '켜짐' : '꺼짐';
}

async function toggleRotation() {
  const button = document.querySelector('[data-rotation]');
  const enabled = button.getAttribute('aria-pressed') !== 'true';
  button.disabled = true;
  const succeeded = await runControl({ action: 'rotation', value: enabled }, `자동 화면 회전을 ${enabled ? '켰어요' : '껐어요'}.`);
  if (succeeded) {
    button.setAttribute('aria-pressed', String(enabled));
    button.querySelector('[data-rotation-label]').textContent = enabled ? '켜짐' : '꺼짐';
  }
  button.disabled = false;
}

async function setScreenTimeout(button) {
  const value = Number(button.dataset.timeoutPreset);
  const succeeded = await runControl({ action: 'timeout', value }, `화면 대기 시간을 ${button.textContent.trim()}으로 바꿨어요.`);
  if (succeeded) document.querySelectorAll('[data-timeout-preset]').forEach((item) => item.classList.toggle('active', item === button));
}

async function runPowerAction(action) {
  const labels = { reboot: '안경 다시 시작', rebootBootloader: '부트로더로 시작' };
  if (!window.confirm(`${labels[action]}을 실행할까요? 저장 중인 작업은 중단될 수 있어요.`)) return;
  await runControl({ action, confirmation: action === 'reboot' ? '기기 재시작' : '부트로더 재시작' }, `${labels[action]} 명령을 보냈어요.`);
}

async function loadProfiles() {
  const container = document.querySelector('[data-profile-list]');
  container.innerHTML = '<div class="loading-card">사용 모드를 준비하고 있어요.</div>';
  try {
    state.profiles = await fetchJson('/api/profiles');
    renderProfiles();
  } catch (error) {
    container.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
    showToast(error.message, true);
  }
}

function renderProfiles() {
  if (!state.profiles) return;
  const profiles = [...state.profiles.builtIn, ...state.profiles.custom];
  document.querySelector('[data-profile-list]').innerHTML = profiles.map((profile) => {
    const current = profileMatchesCurrent(profile);
    return `<article class="profile-card ${escapeHtml(profile.color || 'mint')} ${current ? 'active' : ''}">${current ? '<span class="profile-current">현재 상태</span>' : ''}<span class="profile-card-icon">${escapeHtml(profile.icon || '♥')}</span><h3>${escapeHtml(profile.name)}</h3><p>${escapeHtml(profile.description)}</p><div class="profile-effects">${profileEffectLabels(profile.settings).map((label) => `<span>${escapeHtml(label)}</span>`).join('')}</div><button class="button ${current ? 'soft' : 'primary'}" data-apply-profile="${escapeHtml(profile.id)}" ${current ? 'disabled' : ''}>${current ? '지금 사용 중' : '이 모드로 바꾸기'}</button></article>`;
  }).join('');
  const undo = document.querySelector('[data-profile-undo]');
  const history = state.profiles.lastApplied;
  undo.hidden = !history || Boolean(history.undoneAt);
  if (!undo.hidden) {
    document.querySelector('[data-profile-undo-title]').textContent = `${history.profileName} 모드를 적용했어요`;
    document.querySelector('[data-profile-undo-detail]').textContent = `${formatDate(history.appliedAt)} · 적용 전 상태로 돌아갈 수 있어요.`;
  }
}

function profileMatchesCurrent(profile) {
  if (!state.overview) return false;
  const current = {
    brightness: Number(state.overview.controls?.brightness),
    screenTimeout: Number(state.overview.controls?.screenTimeout),
    rotation: Boolean(state.overview.controls?.rotation),
    wifi: Boolean(state.overview.wifi?.enabled),
    bluetooth: Boolean(state.overview.controls?.bluetooth)
  };
  return Object.keys(current).every((key) => current[key] === profile.settings[key]);
}

function profileEffectLabels(settings) {
  const timeoutLabels = { 30000: '30초 후 절전', 60000: '1분 후 절전', 300000: '5분 후 절전', 1800000: '30분 후 절전' };
  return [
    `밝기 ${toPercent(settings.brightness)}%`,
    timeoutLabels[settings.screenTimeout] || '절전 시간 저장',
    `Wi-Fi ${settings.wifi ? '켜기' : '끄기'}`,
    `Bluetooth ${settings.bluetooth ? '켜기' : '끄기'}`,
    `회전 ${settings.rotation ? '켜기' : '끄기'}`
  ];
}

async function applyProfileFromCard(event) {
  const button = event.target.closest('[data-apply-profile]');
  if (!button || !state.profiles) return;
  const profiles = [...state.profiles.builtIn, ...state.profiles.custom];
  const profile = profiles.find((item) => item.id === button.dataset.applyProfile);
  if (!profile) return;
  if (!window.confirm(`${profile.name} 모드로 바꿀까요?\n\n${profileEffectLabels(profile.settings).join(' · ')}\n\n바꾸기 전 상태는 자동으로 기억합니다.`)) return;
  button.disabled = true;
  button.textContent = '안전하게 적용 중…';
  try {
    await fetchJson('/api/profiles/apply', { method: 'POST', body: { profileId: profile.id } });
    showToast(`${profile.name} 모드로 바꿨어요. 원하면 한 번에 되돌릴 수 있어요.`);
    await refreshOverviewOnly();
    await loadProfiles();
  } catch (error) {
    showToast(error.message, true);
    await loadProfiles();
  }
}

function openSaveProfileDialog() {
  const dialog = document.querySelector('[data-profile-dialog]');
  const input = dialog.querySelector('input[name="profileName"]');
  input.value = '';
  dialog.showModal();
  setTimeout(() => input.focus(), 0);
}

async function saveProfileFromDialog(event) {
  event.preventDefault();
  const dialog = document.querySelector('[data-profile-dialog]');
  if (event.submitter?.value === 'cancel') {
    dialog.close();
    return;
  }
  const input = dialog.querySelector('input[name="profileName"]');
  const button = dialog.querySelector('[data-profile-save-submit]');
  button.disabled = true;
  try {
    const profile = await fetchJson('/api/profiles/save', { method: 'POST', body: { name: input.value } });
    dialog.close();
    showToast(`${profile.name} 모드를 저장했어요.`);
    await loadProfiles();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function undoLastProfile() {
  const button = document.querySelector('[data-profile-undo-button]');
  if (!window.confirm('가장 최근 모드를 적용하기 전 상태로 되돌릴까요?')) return;
  button.disabled = true;
  try {
    await fetchJson('/api/profiles/undo', { method: 'POST', body: {} });
    showToast('모드를 적용하기 전 상태로 되돌렸어요.');
    await refreshOverviewOnly();
    await loadProfiles();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function loadPackages() {
  const container = document.querySelector('[data-package-table]');
  container.innerHTML = '<div class="loading-card">안경에 설치된 앱을 정리하고 있어요.</div>';
  try {
    state.packages = await fetchJson('/api/device/packages');
    renderPackages();
    populateLiveAppSelect();
  } catch (error) {
    container.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
  }
}

function renderPackages() {
  if (!document.querySelector('[data-package-table]')) return;
  document.querySelectorAll('[data-package-filter]').forEach((button) => button.classList.toggle('active', button.dataset.packageFilter === state.packageFilter));
  const query = document.querySelector('[data-package-search]').value.trim().toLowerCase();
  const packages = state.packages.filter((item) => {
    const isRokid = /rokid|krokid|vibeos|glasses|hud/i.test(item.name);
    const categoryMatches = state.packageFilter === 'all' || (state.packageFilter === 'rokid' && isRokid) || (state.packageFilter === 'user' && item.thirdParty) || (state.packageFilter === 'system' && !item.thirdParty);
    return categoryMatches && (!query || `${item.name} ${friendlyAppInfo(item).name}`.toLowerCase().includes(query));
  });
  document.querySelector('[data-package-table]').innerHTML = packages.map((item) => {
    const info = friendlyAppInfo(item);
    const canOpen = item.enabled !== false && item.launchable;
    return `<article class="app-card ${item.thirdParty ? 'user' : 'system'}">
      <div class="app-card-head"><span class="app-icon">${escapeHtml(info.icon)}</span><div><h3>${escapeHtml(info.name)}</h3><small>${item.thirdParty ? '내가 설치한 앱' : info.category}</small></div><i class="app-state ${item.enabled === false ? 'off' : ''}" title="${item.enabled === false ? '사용 중지됨' : '사용 가능'}"></i></div>
      <p class="app-description">${escapeHtml(info.description)}</p>
      <div class="app-actions"><button data-package-action="launch" data-package="${escapeHtml(item.name)}" ${canOpen ? '' : 'disabled'}>${item.launchable ? 'PC 화면에서 열기' : '화면 없는 서비스'}</button><button data-package-action="forceStop" data-package="${escapeHtml(item.name)}">앱 종료</button><button class="expert-only" data-package-action="${item.enabled === false ? 'enablePackage' : 'disablePackage'}" data-package="${escapeHtml(item.name)}">${item.enabled === false ? '다시 사용' : '사용 중지'}</button></div>
      <div class="app-tech expert-only">${escapeHtml(item.name)}<br>${escapeHtml(item.path)}<br>version ${escapeHtml(item.versionName || item.versionCode || '—')}</div>
    </article>`;
  }).join('') || '<div class="loading-card">조건에 맞는 앱이 없어요.</div>';
}

function friendlyAppInfo(item) {
  const name = item.name.toLowerCase();
  if (name.includes('launcher')) return { name: 'Rokid 홈 화면', description: '안경을 켰을 때 보이는 기본 화면과 앱 이동을 담당해요.', icon: '⌂', category: '핵심 화면' };
  if (name.includes('ota') || name.includes('update')) return { name: '시스템 업데이트', description: '새 소프트웨어를 확인하고 설치 준비를 담당해요.', icon: '↑', category: '업데이트' };
  if (name.includes('hud')) return { name: '안경 화면 표시', description: '안경 렌즈에 정보와 알림이 보이도록 도와주는 핵심 기능이에요.', icon: '◉', category: '핵심 화면' };
  if (name.includes('vibeos') || name.includes('corehub')) return { name: 'VibeOS 핵심 서비스', description: '안경의 여러 기능이 서로 연결되어 작동하도록 관리해요.', icon: '◆', category: '핵심 서비스' };
  if (name.includes('camera')) return { name: '카메라', description: '사진과 영상 촬영 기능을 제공해요.', icon: '●', category: '기기 기능' };
  if (name.includes('settings')) return { name: '안경 설정', description: '안경의 시스템 설정 화면이에요.', icon: '⚙', category: '시스템' };
  const last = item.name.split('.').at(-1).replaceAll('_', ' ');
  return { name: last.charAt(0).toUpperCase() + last.slice(1), description: item.thirdParty ? '사용자가 설치한 앱이에요.' : '안경 내부에서 동작하는 시스템 구성 요소예요.', icon: item.thirdParty ? '□' : '◇', category: '시스템 구성 요소' };
}

async function handlePackageAction(event) {
  const button = event.target.closest('[data-package-action]');
  if (!button) return;
  const action = button.dataset.packageAction;
  const packageName = button.dataset.package;
  const item = state.packages.find((candidate) => candidate.name === packageName);
  const friendlyName = item ? friendlyAppInfo(item).name : packageName;
  const confirmations = { forceStop: '앱 중지', disablePackage: '앱 비활성화' };
  const question = action === 'forceStop' ? `${friendlyName} 앱을 지금 종료할까요?` : action === 'disablePackage' ? `${friendlyName}을 사용 중지할까요? 다시 켤 때까지 동작하지 않습니다.` : '';
  if (question && !window.confirm(question)) return;
  button.disabled = true;
  try {
    const succeeded = await runControl({ action, packageName, confirmation: confirmations[action] }, action === 'launch' ? `${friendlyName}을 열었어요.` : `${friendlyName}에 적용했어요.`);
    if (succeeded && action === 'launch') await switchView('diagnostics');
    if (succeeded && (action === 'disablePackage' || action === 'enablePackage')) await loadPackages();
  } finally {
    button.disabled = false;
  }
}

async function loadSettings(scope) {
  state.settingsScope = scope;
  document.querySelectorAll('[data-settings-scope]').forEach((button) => button.classList.toggle('active', button.dataset.settingsScope === scope));
  document.querySelector('[data-settings-list]').innerHTML = '<div class="loading-card">설정값을 읽고 있어요.</div>';
  state.settings = await fetchJson(`/api/device/settings?scope=${encodeURIComponent(scope)}`);
  renderSettings();
}

function renderSettings() {
  const query = document.querySelector('[data-settings-search]').value.trim().toLowerCase();
  const settings = state.settings.filter((item) => !query || `${item.key} ${item.value}`.toLowerCase().includes(query));
  document.querySelector('[data-settings-list]').innerHTML = settings.map((item) => `<div class="setting-row"><code>${escapeHtml(item.key)}</code><span>${escapeHtml(item.value)}</span></div>`).join('') || '<div class="loading-card">검색 결과가 없어요.</div>';
}

async function loadFineTune() {
  const container = document.querySelector('[data-fine-tune-list]');
  container.innerHTML = '<div class="loading-card">안경의 세부 값을 읽고 있어요.</div>';
  try {
    state.fineTune = await fetchJson('/api/fine-tune');
    renderFineTune();
  } catch (error) {
    container.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
    showToast(error.message, true);
  }
}

function renderFineTune() {
  if (!state.fineTune) return;
  document.querySelectorAll('[data-fine-category]').forEach((button) => button.classList.toggle('active', button.dataset.fineCategory === state.fineCategory));
  const query = document.querySelector('[data-fine-tune-search]').value.trim().toLowerCase();
  const showRaw = document.querySelector('[data-raw-labels]').checked;
  const items = state.fineTune.items.filter((item) => {
    const categoryMatches = state.fineCategory === '전체' || (state.fineCategory === '추천' ? item.featured : item.category === state.fineCategory);
    return categoryMatches && (!query || `${item.label} ${item.description} ${item.category} ${item.key} ${item.value}`.toLowerCase().includes(query));
  });
  const total = Object.values(state.fineTune.counts).reduce((sum, value) => sum + Number(value || 0), 0);
  document.querySelector('[data-fine-tune-count]').textContent = `${total}개`;
  document.querySelector('[data-fine-tune-list]').innerHTML = items.map((item) => {
    const riskClass = item.risk === 'locked' ? 'locked' : item.risk === 'caution' ? 'caution' : 'safe';
    return `<article class="fine-setting-card ${riskClass}" data-fine-setting-card data-scope="${escapeHtml(item.scope)}" data-setting-key="${escapeHtml(item.key)}">
      <div class="fine-setting-card-head"><span class="fine-setting-icon">${fineCategoryIcon(item.category, item.risk)}</span><div><span class="category">${escapeHtml(item.category)} · ${item.risk === 'locked' ? '읽기 전용' : item.risk === 'caution' ? '주의해서 변경' : '안전 조정'}</span><h3>${escapeHtml(item.label)}</h3></div></div>
      <p>${escapeHtml(item.description)}</p><code class="fine-setting-key ${showRaw ? 'show-raw' : ''}">${escapeHtml(item.scope)} · ${escapeHtml(item.key)}</code>
      <div class="fine-setting-control">${fineSettingControl(item)}</div>
    </article>`;
  }).join('') || '<div class="loading-card">조건에 맞는 세부 설정이 없어요. ‘모든 항목’을 눌러 더 찾아보세요.</div>';
  const undo = document.querySelector('[data-fine-tune-undo]');
  const history = state.fineTune.lastChange;
  undo.hidden = !history;
  if (history) {
    document.querySelector('[data-fine-tune-undo-title]').textContent = `${history.label}을 바꿨어요`;
    document.querySelector('[data-fine-tune-undo-detail]').textContent = `${friendlyFineValue({ value: history.before.value, input: history.before.value === '0' || history.before.value === '1' ? 'boolean' : 'text' }, history.before.value)} 값으로 돌아갈 수 있어요.`;
  }
}

function fineSettingControl(item) {
  if (!item.editable) return `<span class="fine-locked-value">🔒 현재 값 · ${escapeHtml(friendlyFineValue(item, item.value))}</span>`;
  if (item.input === 'boolean') {
    const enabled = item.value === '1';
    return `<button class="fine-boolean" data-fine-toggle aria-pressed="${enabled}"><span>${enabled ? '켜짐' : '꺼짐'}</span><i></i></button>`;
  }
  if (item.input === 'select') {
    const options = item.options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${String(value) === item.value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
    return `<select data-fine-input aria-label="${escapeHtml(item.label)} 값">${options}</select><button data-fine-save>적용</button>`;
  }
  const type = item.input === 'number' ? 'number' : 'text';
  const attributes = type === 'number' ? `${item.min !== undefined ? ` min="${item.min}"` : ''}${item.max !== undefined ? ` max="${item.max}"` : ''}${item.step !== undefined ? ` step="${item.step}"` : ' step="any"'}` : ' maxlength="4096"';
  return `<input data-fine-input type="${type}" value="${escapeHtml(item.value)}"${attributes} aria-label="${escapeHtml(item.label)} 값" /><button data-fine-save>적용</button>`;
}

function fineCategoryIcon(category, risk) {
  if (risk === 'locked') return '⌑';
  return { 화면: '◫', 조작: '☝', 소리: '♪', 전원: '⚡', 연결: '⌁', 시간: '◷', 움직임: '↝', 개인정보: '◉', 기타: '≋' }[category] || '≋';
}

function friendlyFineValue(item, value) {
  if (item.input === 'boolean') return String(value) === '1' ? '켜짐' : '꺼짐';
  const option = item.options?.find(([candidate]) => String(candidate) === String(value));
  if (option) return option[1];
  if (item.unit === 'ms') {
    const milliseconds = Number(value);
    if (milliseconds >= 60_000) return `${milliseconds / 60_000}분`;
    if (milliseconds >= 1_000) return `${milliseconds / 1_000}초`;
  }
  return String(value || '빈 값');
}

async function handleFineTuneAction(event) {
  const toggle = event.target.closest('[data-fine-toggle]');
  const save = event.target.closest('[data-fine-save]');
  if (!toggle && !save) return;
  const card = event.target.closest('[data-fine-setting-card]');
  const item = state.fineTune.items.find((candidate) => candidate.scope === card.dataset.scope && candidate.key === card.dataset.settingKey);
  if (!item) return;
  const value = toggle ? (toggle.getAttribute('aria-pressed') === 'true' ? '0' : '1') : card.querySelector('[data-fine-input]').value;
  const beforeLabel = friendlyFineValue(item, item.value);
  const afterLabel = friendlyFineValue(item, value);
  const caution = item.risk === 'caution' ? '\n\n이 항목은 Android 내부 동작에 영향을 줄 수 있어요. 문제가 생기면 위의 되돌리기를 사용하세요.' : '';
  if (!window.confirm(`${item.label}을 바꿀까요?\n\n${beforeLabel} → ${afterLabel}${caution}`)) return;
  const control = toggle || save;
  control.disabled = true;
  try {
    await fetchJson('/api/fine-tune/change', { method: 'POST', body: { scope: item.scope, key: item.key, value, confirmation: item.risk === 'caution' ? '세부 설정 변경' : '' } });
    showToast(`${item.label}을 ${afterLabel}(으)로 바꿨어요.`);
    await loadFineTune();
    if (item.featured) await refreshOverviewOnly();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    control.disabled = false;
  }
}

async function undoFineTune() {
  if (!state.fineTune?.lastChange) return;
  if (!window.confirm(`${state.fineTune.lastChange.label}의 가장 최근 변경을 되돌릴까요?`)) return;
  const button = document.querySelector('[data-fine-tune-undo-button]');
  button.disabled = true;
  try {
    await fetchJson('/api/fine-tune/undo', { method: 'POST', body: {} });
    showToast('세부 설정을 바꾸기 전 값으로 되돌렸어요.');
    await loadFineTune();
    await refreshOverviewOnly();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function startLiveScreen() {
  if (state.liveScreen.active) return;
  const placeholder = document.querySelector('[data-live-placeholder]');
  const frame = document.querySelector('[data-live-frame]');
  state.liveScreen.active = true;
  state.liveScreen.ready = false;
  const generation = ++state.liveScreen.generation;
  frame.classList.remove('paused');
  placeholder.classList.remove('ready');
  placeholder.classList.remove('error');
  placeholder.querySelector('strong').textContent = '안경 화면 연결 중';
  placeholder.querySelector('small').textContent = '첫 화면을 가져오고 있어요.';
  document.querySelector('[data-live-toggle]').textContent = '일시정지';
  document.querySelector('[data-live-status]').textContent = '실시간 화면 연결 중';
  applyLiveOrientation();
  runLiveScreenLoop(generation);
}

function stopLiveScreen() {
  if (!state.liveScreen.active) return;
  state.liveScreen.active = false;
  state.liveScreen.generation += 1;
  state.liveScreen.pointer = null;
  const image = document.querySelector('[data-live-image]');
  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
  if (state.liveScreen.objectUrl) URL.revokeObjectURL(state.liveScreen.objectUrl);
  state.liveScreen.objectUrl = '';
  document.querySelector('[data-live-frame]').classList.add('paused');
  document.querySelector('[data-live-toggle]').textContent = '다시 보기';
  document.querySelector('[data-live-status]').textContent = '실시간 화면 일시정지';
}

function toggleLiveScreen() {
  if (state.liveScreen.active) stopLiveScreen();
  else startLiveScreen();
}

async function runLiveScreenLoop(generation) {
  const image = document.querySelector('[data-live-image]');
  const placeholder = document.querySelector('[data-live-placeholder]');
  let consecutiveFailures = 0;
  while (state.liveScreen.active && generation === state.liveScreen.generation) {
    try {
      const response = await fetch(`/api/device/screenshot?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`화면 응답 ${response.status}`);
      const blob = await response.blob();
      if (!blob.size || !blob.type.startsWith('image/')) throw new Error('올바른 화면 이미지가 아닙니다.');
      if (!state.liveScreen.active || generation !== state.liveScreen.generation) break;
      const nextUrl = URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('화면 이미지 표시 실패'));
          image.src = nextUrl;
        });
      } catch (error) {
        URL.revokeObjectURL(nextUrl);
        throw error;
      }
      if (!state.liveScreen.active || generation !== state.liveScreen.generation) {
        URL.revokeObjectURL(nextUrl);
        break;
      }
      if (state.liveScreen.objectUrl && state.liveScreen.objectUrl !== nextUrl) URL.revokeObjectURL(state.liveScreen.objectUrl);
      state.liveScreen.objectUrl = nextUrl;
      consecutiveFailures = 0;
      state.liveScreen.ready = true;
      placeholder.classList.add('ready');
      placeholder.classList.remove('error');
      document.querySelector('[data-live-status]').textContent = state.overview?.power?.screenOn === false
        ? '안경 화면이 꺼져 있어 검게 보입니다 · 아래 “화면 전원”을 눌러 켜세요'
        : '마우스로 바로 조작할 수 있어요';
      updateLiveScreenCaption();
      await delay(70);
    } catch (error) {
      if (!state.liveScreen.active || generation !== state.liveScreen.generation) break;
      consecutiveFailures += 1;
      if (!state.liveScreen.ready) {
        placeholder.classList.remove('ready');
        placeholder.classList.add('error');
        placeholder.querySelector('strong').textContent = '화면 연결을 다시 시도하고 있어요';
        placeholder.querySelector('small').textContent = `${Math.min(5, consecutiveFailures)}초 뒤 자동으로 다시 확인합니다.`;
      }
      document.querySelector('[data-live-status]').textContent = '화면 자동 재연결 중';
      await delay(Math.min(5_000, 700 * consecutiveFailures));
    }
  }
}

function toggleLiveOrientation() {
  state.liveScreen.orientation = state.liveScreen.orientation === 'portrait' ? 'hud-landscape' : 'portrait';
  saveAndApplyLiveOrientation();
}

function saveAndApplyLiveOrientation() {
  localStorage.setItem('rokid-screen-orientation', state.liveScreen.orientation);
  applyLiveOrientation();
}

function applyLiveOrientation() {
  const frame = document.querySelector('[data-live-frame]');
  const orientation = state.liveScreen.orientation;
  frame.classList.toggle('landscape', orientation !== 'portrait');
  document.querySelector('[data-live-orientation]').textContent = orientation === 'portrait' ? 'HUD 가로 보기' : '전체 원본 보기';
  updateLiveScreenCaption();
}

function updateLiveScreenCaption() {
  const rawWidth = Number(state.overview?.display?.width) || 480;
  const rawHeight = Number(state.overview?.display?.height) || 640;
  const view = screenViewDimensions(rawWidth, rawHeight, state.liveScreen.orientation);
  const activity = state.overview?.currentActivity?.split('/').at(-1) || '현재 안경 화면';
  const orientationLabel = state.liveScreen.orientation === 'portrait' ? '전체 원본' : '광학 HUD 가로';
  document.querySelector('[data-live-activity]').textContent = `${activity} · ${view.width}×${view.height} ${orientationLabel} · 원본 ${rawWidth}×${rawHeight}`;
}

function bindLiveScreenPointer() {
  const frame = document.querySelector('[data-live-frame]');
  frame.addEventListener('pointerdown', (event) => {
    if (!state.liveScreen.active || event.button !== 0) return;
    event.preventDefault();
    const point = liveScreenPoint(event);
    state.liveScreen.pointer = { pointerId: event.pointerId, point, startedAt: Date.now(), clientX: event.clientX, clientY: event.clientY };
    frame.setPointerCapture(event.pointerId);
    frame.classList.add('interacting');
    showTouchIndicator(event);
  });
  frame.addEventListener('pointerup', async (event) => {
    const start = state.liveScreen.pointer;
    if (!start || start.pointerId !== event.pointerId) return;
    state.liveScreen.pointer = null;
    frame.classList.remove('interacting');
    const end = liveScreenPoint(event);
    const elapsed = Date.now() - start.startedAt;
    const distance = Math.hypot(end.x - start.point.x, end.y - start.point.y);
    const kind = distance >= 12 ? 'swipe' : elapsed >= 550 ? 'longPress' : 'tap';
    const payload = kind === 'swipe'
      ? { kind, x: start.point.x, y: start.point.y, endX: end.x, endY: end.y, durationMs: Math.min(2_000, Math.max(80, elapsed)) }
      : { kind, x: start.point.x, y: start.point.y, durationMs: kind === 'longPress' ? Math.min(2_000, Math.max(550, elapsed)) : undefined };
    document.querySelector('[data-live-status]').textContent = kind === 'swipe' ? '드래그를 안경에 전달 중' : kind === 'longPress' ? '길게 누르기를 전달 중' : '탭을 안경에 전달 중';
    try {
      await fetchJson('/api/device/screen-interaction', { method: 'POST', body: payload });
      document.querySelector('[data-live-status]').textContent = '조작 완료 · 화면 갱신 중';
    } catch (error) {
      showToast(error.message, true);
      document.querySelector('[data-live-status]').textContent = '조작을 전달하지 못했어요';
    }
  });
  frame.addEventListener('pointercancel', () => {
    state.liveScreen.pointer = null;
    frame.classList.remove('interacting');
  });
}

function liveScreenPoint(event) {
  const frame = document.querySelector('[data-live-frame]');
  const rect = frame.getBoundingClientRect();
  const width = Number(state.overview?.display?.width) || 480;
  const height = Number(state.overview?.display?.height) || 640;
  return mapViewPointToDevice({
    normalizedX: (event.clientX - rect.left) / rect.width,
    normalizedY: (event.clientY - rect.top) / rect.height,
    rawWidth: width,
    rawHeight: height,
    orientation: state.liveScreen.orientation
  });
}

function showTouchIndicator(event) {
  const frame = document.querySelector('[data-live-frame]');
  const rect = frame.getBoundingClientRect();
  const indicator = document.querySelector('[data-touch-indicator]');
  indicator.style.left = `${((event.clientX - rect.left) / rect.width) * 100}%`;
  indicator.style.top = `${((event.clientY - rect.top) / rect.height) * 100}%`;
  indicator.classList.remove('show');
  void indicator.offsetWidth;
  indicator.classList.add('show');
}

function populateLiveAppSelect() {
  const select = document.querySelector('[data-live-app-select]');
  if (!select || !state.packages.length) return;
  const openable = state.packages.filter((item) => item.enabled !== false && item.launchable).sort((a, b) => {
    const aRokid = /rokid|krokid|vibeos|glasses|hud/i.test(a.name);
    const bRokid = /rokid|krokid|vibeos|glasses|hud/i.test(b.name);
    return Number(bRokid) - Number(aRokid) || friendlyAppInfo(a).name.localeCompare(friendlyAppInfo(b).name, 'ko');
  });
  select.innerHTML = openable.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(friendlyAppInfo(item).name)}${item.thirdParty ? ' · 내가 설치한 앱' : ''}</option>`).join('');
}

async function openSelectedAppOnScreen() {
  const select = document.querySelector('[data-live-app-select]');
  const item = state.packages.find((candidate) => candidate.name === select.value);
  if (!item) return showToast('열 앱을 먼저 골라 주세요.', true);
  const button = document.querySelector('[data-live-open-app]');
  button.disabled = true;
  try {
    const succeeded = await runControl({ action: 'launch', packageName: item.name }, `${friendlyAppInfo(item).name}을 안경에서 열었어요.`);
    if (succeeded) {
      if (!state.liveScreen.active) startLiveScreen();
      document.querySelector('[data-live-activity]').textContent = friendlyAppInfo(item).name;
    }
  } finally {
    button.disabled = false;
  }
}

async function loadAudit() {
  try {
    const records = await fetchJson('/api/audit?limit=80');
    document.querySelector('[data-audit-list]').innerHTML = records.slice().reverse().map((item) => `<div class="audit-item"><strong>${escapeHtml(friendlyAuditLabel(item))}</strong><span>${escapeHtml(formatDate(item.timestamp))} · ${escapeHtml(friendlyStatus(item.status))}</span></div>`).join('') || '<div class="loading-card">아직 바꾼 내용이 없어요.</div>';
  } catch (error) {
    document.querySelector('[data-audit-list]').innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
  }
}

function friendlyAuditLabel(item) {
  const labels = { brightness: '화면 밝기를 바꿈', timeout: '화면 대기 시간을 바꿈', rotation: '자동 회전을 바꿈', wifi: 'Wi-Fi 상태를 바꿈', bluetooth: 'Bluetooth 상태를 바꿈', key: '안경 버튼을 누름', launch: '앱을 엶', forceStop: '앱을 종료함', disablePackage: '앱을 사용 중지함', enablePackage: '앱을 다시 사용함', reboot: '안경을 다시 시작함', rebootBootloader: '부트로더로 다시 시작함' };
  if (item.type === 'profile.saved') return `${item.profileName || '사용자'} 모드를 저장함`;
  if (item.type === 'profile.apply') return `${item.profileName || '사용'} 모드를 적용함`;
  if (item.type === 'profile.undo') return `${item.profileName || '최근'} 모드 적용을 되돌림`;
  if (item.type === 'screen.interaction') return item.kind === 'swipe' ? 'PC 화면에서 드래그함' : item.kind === 'longPress' ? 'PC 화면을 길게 누름' : 'PC 화면을 탭함';
  if (item.type === 'setting.change') return `${item.label || item.key || '세부 설정'}을 바꿈`;
  if (item.type === 'setting.undo') return `${item.label || item.key || '세부 설정'} 변경을 되돌림`;
  if (item.type?.includes('backup')) return item.status === 'completed' ? '안전 백업을 완료함' : '안전 백업 작업';
  return labels[item.action] || '안경 상태를 확인함';
}

function friendlyStatus(status) {
  const labels = {
    succeeded: '완료',
    completed: '완료',
    passed: '통과',
    failed: '실패',
    blocked: '차단됨',
    pending: '대기 중',
    running: '실행 중',
    normal: '정상',
    update_success: '업데이트 성공',
    idle: '대기',
    checking: '확인 중',
    downloading: '내려받는 중',
    updating: '적용 중',
    unknown: '확인 불가'
  };
  return labels[status] || (status ? '상태 확인 필요' : '기록됨');
}

async function loadLogcat() {
  const output = document.querySelector('[data-log-output]');
  output.textContent = '전문가 로그를 읽고 있습니다…';
  try { output.textContent = (await fetchJson('/api/device/logcat?lines=250')).output || '표시할 로그가 없습니다.'; }
  catch (error) { output.textContent = error.message; }
}

async function loadUpdateStatus() {
  const container = document.querySelector('[data-update-packages]');
  container.innerHTML = '<div class="loading-card">보관함에서 업데이트 파일을 찾고 있어요.</div>';
  try {
    state.update = await fetchJson('/api/update/status');
    const update = state.update;
    document.querySelector('[data-ota-endpoint]').textContent = update.vendor.checkEndpoint || '설정 없음';
    document.querySelector('[data-ota-version]').textContent = `OTA ${update.vendor.packageVersion || '—'} · ${update.vendor.packageVersionCode || '—'}`;
    document.querySelector('[data-ota-state]').textContent = `확인 ${friendlyStatus(update.deviceState.check)} · 업그레이드 ${friendlyStatus(update.deviceState.upgrade)}`;
    document.querySelector('[data-update-inbox]').textContent = update.localVault.inboxRoot;
    const packages = update.localVault.packages;
    updateWizard(packages.length > 0);
    container.innerHTML = packages.map((item) => {
      const structurallyValid = item.hasPayload && item.hasPayloadProperties;
      const prepared = state.preparedPackages.has(item.filename);
      return `<article class="update-package-card"><h3>${escapeHtml(item.filename)}</h3><small>${formatBytes(item.size)} · ${item.entryCount}개 내부 파일</small><div class="update-checks"><span class="${structurallyValid ? 'ok' : ''}">${structurallyValid ? '✓ 기본 업데이트 구조 확인' : '⚠ 필요한 내부 파일 없음'}</span><span class="${prepared ? 'ok' : ''}">${prepared ? '✓ 안전 검사 결과 저장됨' : '○ 아직 안전 검사 전'}</span><span class="expert-only">SHA-256 ${escapeHtml(item.sha256.slice(0, 18))}…</span></div><button class="button ${prepared ? 'soft' : 'primary'} block" data-prepare-update="${escapeHtml(item.filename)}" ${structurallyValid ? '' : 'disabled'}>${prepared ? '다시 검사하기' : '안전 검사 시작'}</button></article>`;
    }).join('') || '<div class="loading-card">아직 업데이트 ZIP 파일이 없어요. 위의 ‘보관함 폴더 열기’부터 눌러주세요.</div>';
  } catch (error) {
    container.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
    showToast(error.message, true);
  }
}

function updateWizard(hasPackage) {
  const steps = document.querySelectorAll('.wizard-step');
  steps[1].classList.toggle('complete', hasPackage);
  steps[1].classList.toggle('active', !hasPackage);
  steps[2].classList.toggle('active', hasPackage);
}

async function openUpdateInbox() {
  try {
    await fetchJson('/api/update/open-inbox', { method: 'POST', body: {} });
    showToast('업데이트 파일을 넣을 Windows 폴더를 열었어요.');
  } catch (error) { showToast(error.message, true); }
}

async function importUpdateFile(file) {
  if (!file) return;
  const status = document.querySelector('[data-upload-status]');
  if (!file.name.toLowerCase().endsWith('.zip')) {
    status.textContent = 'ZIP 파일만 선택할 수 있어요.';
    showToast('업데이트 ZIP 파일을 선택해 주세요.', true);
    return;
  }
  status.textContent = `${file.name} 복사 중… 창을 닫지 마세요.`;
  try {
    const response = await fetch(`/api/update/import?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-rokid-control-token': state.token },
      body: file
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `파일을 가져오지 못했어요 (${response.status})`);
    status.textContent = `${file.name} 저장 완료 · 이제 안전 검사를 눌러주세요.`;
    showToast('업데이트 파일을 보관함에 안전하게 복사했어요.');
    await loadUpdateStatus();
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message, true);
  }
}

async function prepareUpdatePackage(event) {
  const button = event.target.closest('[data-prepare-update]');
  if (!button) return;
  button.disabled = true;
  try {
    await fetchJson('/api/update/prepare', { method: 'POST', body: { filename: button.dataset.prepareUpdate } });
    state.preparedPackages.add(button.dataset.prepareUpdate);
    showToast('업데이트 파일의 안전 검사를 마쳤어요. 실제 설치는 아직 잠겨 있습니다.');
    await loadUpdateStatus();
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

async function fetchJson(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-rokid-control-token': state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `요청을 처리하지 못했어요 (${response.status})`);
  return payload;
}

function showToast(message, error = false) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' error' : ''}`;
  toast.textContent = message;
  document.querySelector('[data-toasts]').append(toast);
  setTimeout(() => toast.remove(), 4_200);
}

function toPercent(value) { return Math.round((Number(value) / 255) * 100); }
function formatDate(value) { return value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function formatRelativeDate(value) {
  if (!value) return '아직 없음';
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  return days <= 0 ? '오늘 완료' : days === 1 ? '어제 완료' : `${days}일 전`;
}
function formatBytes(value) {
  const size = Number(value) || 0;
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}
function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
