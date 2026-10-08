import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DeviceError } from './device-service.js';

const SCOPES = ['system', 'secure', 'global'];
const FRIENDLY_SETTINGS = new Map(Object.entries({
  'system:screen_brightness': { label: '화면 밝기', description: '렌즈 화면이 얼마나 밝게 보일지 조절합니다.', category: '화면', input: 'number', min: 1, max: 255, featured: true },
  'system:screen_off_timeout': { label: '자동 화면 꺼짐 시간', description: '조작하지 않을 때 화면을 끄기까지 기다리는 시간입니다.', category: '전원', input: 'select', options: [['30000', '30초'], ['60000', '1분'], ['300000', '5분'], ['1800000', '30분']], unit: 'ms', featured: true },
  'system:accelerometer_rotation': { label: '자동 화면 회전', description: '안경 방향에 맞춰 화면을 자동으로 돌립니다.', category: '화면', input: 'boolean', featured: true },
  'system:user_rotation': { label: '고정 화면 방향', description: '자동 회전을 끈 상태에서 사용할 화면 방향입니다.', category: '화면', input: 'select', options: [['0', '기본'], ['1', '왼쪽'], ['2', '거꾸로'], ['3', '오른쪽']], featured: true },
  'system:font_scale': { label: '글자 크기 배율', description: '앱과 메뉴에 표시되는 글자 크기를 조절합니다.', category: '화면', input: 'number', min: 0.5, max: 2, step: 0.05, featured: true },
  'system:show_touches': { label: '터치 위치 표시', description: 'PC에서 누른 위치를 안경 화면에 동그라미로 보여줍니다.', category: '조작', input: 'boolean', featured: true },
  'system:pointer_location': { label: '터치 이동 경로 표시', description: '드래그 좌표와 이동 경로를 화면 위에 표시합니다.', category: '조작', input: 'boolean', featured: true },
  'system:sound_effects_enabled': { label: '버튼 효과음', description: '화면 항목을 누를 때 효과음을 냅니다.', category: '소리', input: 'boolean', featured: true },
  'system:haptic_feedback_enabled': { label: '조작 진동', description: '지원되는 조작에 진동 반응을 사용합니다.', category: '조작', input: 'boolean', featured: true },
  'system:lockscreen_sounds_enabled': { label: '잠금 효과음', description: '화면을 잠그거나 풀 때 효과음을 냅니다.', category: '소리', input: 'boolean', featured: true },
  'global:window_animation_scale': { label: '창 열림 애니메이션 속도', description: '창이 열리고 닫히는 움직임의 속도입니다.', category: '움직임', input: 'select', options: [['0.0', '움직임 없음'], ['0.5', '빠르게'], ['1.0', '기본'], ['1.5', '느리게'], ['2.0', '매우 느리게']], featured: true },
  'global:transition_animation_scale': { label: '화면 전환 애니메이션 속도', description: '앱 화면 사이를 이동할 때의 움직임 속도입니다.', category: '움직임', input: 'select', options: [['0.0', '움직임 없음'], ['0.5', '빠르게'], ['1.0', '기본'], ['1.5', '느리게'], ['2.0', '매우 느리게']], featured: true },
  'global:animator_duration_scale': { label: '화면 요소 애니메이션 속도', description: '버튼과 패널 같은 요소의 움직임 속도입니다.', category: '움직임', input: 'select', options: [['0.0', '움직임 없음'], ['0.5', '빠르게'], ['1.0', '기본'], ['1.5', '느리게'], ['2.0', '매우 느리게']], featured: true },
  'global:stay_on_while_plugged_in': { label: '전원 연결 중 화면 유지', description: 'USB 또는 전원에 연결했을 때 화면이 자동으로 꺼지지 않게 합니다.', category: '전원', input: 'select', options: [['0', '사용 안 함'], ['1', '충전기 연결 시'], ['2', 'USB 연결 시'], ['3', '충전기 또는 USB'], ['7', '어떤 전원이든']], featured: true },
  'global:auto_time': { label: '날짜·시간 자동 설정', description: '네트워크가 알려주는 날짜와 시간을 사용합니다.', category: '시간', input: 'boolean', featured: true },
  'global:auto_time_zone': { label: '시간대 자동 설정', description: '현재 위치의 시간대를 자동으로 사용합니다.', category: '시간', input: 'boolean', featured: true },
  'global:airplane_mode_on': { label: '비행기 모드 상태', description: '대부분의 무선 연결이 한 번에 꺼져 있는지 보여줍니다. Android가 직접 관리하므로 여기서는 읽기만 합니다.', category: '연결', input: 'boolean', locked: true, featured: true },
  'secure:location_mode': { label: '위치 기능 모드', description: '앱이 위치 센서를 사용할 수 있는 범위를 정합니다.', category: '개인정보', input: 'select', options: [['0', '사용 안 함'], ['1', '센서만'], ['2', '네트워크만'], ['3', '모두 사용']], risk: 'caution', featured: true }
}));

const LOCKED_KEYS = /^(android_id|bluetooth_address|boot_count|device_provisioned|development_settings_enabled|adb_enabled|install_non_market_apps|package_verifier_enable|verifier_verify_adb_installs)$/;

export class FineTuneService {
  constructor({ deviceService, audit, dataRoot, now = () => new Date() }) {
    this.deviceService = deviceService;
    this.audit = audit;
    this.now = now;
    this.historyPath = join(resolve(dataRoot), 'fine-tune', 'history.json');
  }

  async list(serial = '') {
    const scopeEntries = await Promise.all(SCOPES.map(async (scope) => [scope, await this.deviceService.settings(scope, serial)]));
    const items = scopeEntries.flatMap(([scope, settings]) => settings.map((item) => describeSetting(scope, item)));
    const history = await this.readHistory();
    return {
      editorVersion: 'rokid-visual-settings-v1',
      counts: Object.fromEntries(scopeEntries.map(([scope, settings]) => [scope, settings.length])),
      items,
      lastChange: history.findLast((item) => !item.undoneAt) ?? null
    };
  }

  async change({ scope, key, value, confirmation = '', serial = '' }) {
    const current = await this.deviceService.readSetting(scope, key, serial);
    if (!current.exists) throw new DeviceError(404, '현재 안경에 존재하는 설정만 바꿀 수 있습니다.');
    const metadata = describeSetting(scope, { key, value: current.value });
    if (!metadata.editable) throw new DeviceError(412, '기기 식별·복구에 영향을 주는 항목이라 이 화면에서는 변경을 잠갔습니다.');
    if (metadata.risk === 'caution' && confirmation !== '세부 설정 변경') {
      throw new DeviceError(412, '확인 문구 “세부 설정 변경”이 필요합니다.', { requiredConfirmation: '세부 설정 변경' });
    }
    const normalized = normalizeValue(metadata, value);
    if (normalized === current.value) return { status: 'unchanged', item: metadata };
    const startedAt = Date.now();
    try {
      await this.deviceService.writeSetting(scope, key, normalized, serial);
      const after = await this.deviceService.readSetting(scope, key, serial);
      if (!after.exists || after.value !== normalized) throw new Error('안경이 새 값을 유지하지 않았습니다. 이 항목은 시스템에서 자동 관리할 수 있습니다.');
      const record = {
        id: randomUUID(), timestamp: this.now().toISOString(), scope, key,
        label: metadata.label, before: current, after, risk: metadata.risk
      };
      const history = await this.readHistory();
      await this.writeHistory([...history, record].slice(-50));
      await this.audit.append({ type: 'setting.change', serial, scope, key, label: metadata.label, before: current.value, after: after.value, status: 'succeeded', durationMs: Date.now() - startedAt });
      return { status: 'changed', record, item: { ...metadata, value: after.value } };
    } catch (error) {
      await this.audit.append({ type: 'setting.change', serial, scope, key, label: metadata.label, status: 'failed', error: String(error.message).slice(0, 300), durationMs: Date.now() - startedAt });
      throw error;
    }
  }

  async undo(serial = '') {
    const history = await this.readHistory();
    const index = history.findLastIndex((item) => !item.undoneAt);
    if (index < 0) throw new DeviceError(409, '되돌릴 세부 설정 변경이 없습니다.');
    const record = history[index];
    const current = await this.deviceService.readSetting(record.scope, record.key, serial);
    if (record.before.exists) await this.deviceService.writeSetting(record.scope, record.key, record.before.value, serial);
    else await this.deviceService.deleteSetting(record.scope, record.key, serial);
    const restored = await this.deviceService.readSetting(record.scope, record.key, serial);
    if (restored.exists !== record.before.exists || restored.value !== record.before.value) throw new Error('이 설정을 이전 값으로 되돌리지 못했습니다.');
    history[index] = { ...record, undoneAt: this.now().toISOString(), valueBeforeUndo: current.value };
    await this.writeHistory(history);
    await this.audit.append({ type: 'setting.undo', serial, scope: record.scope, key: record.key, label: record.label, status: 'succeeded' });
    return { status: 'undone', record: history[index], restored };
  }

  async readHistory() {
    try {
      const parsed = JSON.parse(await readFile(this.historyPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeHistory(value) {
    await mkdir(dirname(this.historyPath), { recursive: true });
    const temporaryPath = `${this.historyPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.historyPath);
  }
}

function describeSetting(scope, item) {
  const known = FRIENDLY_SETTINGS.get(`${scope}:${item.key}`);
  const locked = Boolean(known?.locked) || LOCKED_KEYS.test(item.key);
  const booleanLike = item.value === '0' || item.value === '1';
  const numeric = item.value !== '' && Number.isFinite(Number(item.value));
  return {
    scope,
    key: item.key,
    value: item.value,
    label: known?.label ?? friendlyUnknownLabel(item.key),
    description: known?.description ?? 'Android가 보관하는 세부 동작값입니다. 기능을 정확히 아는 경우에만 바꾸세요.',
    category: known?.category ?? inferCategory(item.key),
    input: known?.input ?? (booleanLike ? 'boolean' : numeric ? 'number' : 'text'),
    min: known?.min,
    max: known?.max,
    step: known?.step,
    unit: known?.unit,
    options: known?.options,
    featured: Boolean(known?.featured),
    editable: !locked,
    risk: locked ? 'locked' : known?.risk ?? (known ? 'safe' : 'caution')
  };
}

function normalizeValue(metadata, value) {
  if (metadata.input === 'boolean') return value === true || value === 'true' || value === 1 || value === '1' ? '1' : '0';
  if (metadata.input === 'select') {
    const selected = String(value);
    if (!metadata.options?.some(([candidate]) => String(candidate) === selected)) throw new DeviceError(400, '목록에 있는 값을 선택해 주세요.');
    return selected;
  }
  if (metadata.input === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new DeviceError(400, '숫자 값을 입력해 주세요.');
    if (metadata.min !== undefined && number < metadata.min) throw new DeviceError(400, `${metadata.label}의 가장 작은 값은 ${metadata.min}입니다.`);
    if (metadata.max !== undefined && number > metadata.max) throw new DeviceError(400, `${metadata.label}의 가장 큰 값은 ${metadata.max}입니다.`);
    return String(number);
  }
  const text = String(value ?? '').trim();
  if (!text && metadata.input !== 'text') throw new DeviceError(400, '값을 입력해 주세요.');
  return text;
}

function inferCategory(key) {
  if (/display|screen|brightness|rotation|font|color|density/i.test(key)) return '화면';
  if (/sound|audio|volume|ring|vibrat|haptic/i.test(key)) return '소리';
  if (/wifi|bluetooth|network|airplane|data|usb/i.test(key)) return '연결';
  if (/touch|pointer|gesture|button|key/i.test(key)) return '조작';
  if (/time|date|clock|zone/i.test(key)) return '시간';
  if (/battery|power|sleep|timeout|stay_on/i.test(key)) return '전원';
  if (/location|privacy|camera|microphone|permission/i.test(key)) return '개인정보';
  return '기타';
}

function friendlyUnknownLabel(key) {
  const words = String(key).split(/[_:.]+/).filter(Boolean).map((word) => TOKEN_LABELS[word.toLowerCase()] ?? word);
  return words.join(' · ');
}

const TOKEN_LABELS = {
  enabled: '사용', disabled: '사용 안 함', mode: '모드', timeout: '대기 시간', screen: '화면', display: '화면',
  brightness: '밝기', rotation: '회전', sound: '소리', volume: '음량', wifi: 'Wi-Fi', bluetooth: 'Bluetooth',
  auto: '자동', time: '시간', zone: '시간대', location: '위치', power: '전원', battery: '배터리', touch: '터치',
  show: '표시', pointer: '포인터', animation: '움직임', scale: '배율', font: '글자', user: '사용자', system: '시스템'
};
