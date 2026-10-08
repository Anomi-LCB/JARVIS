import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BUILT_IN_PROFILES = [
  {
    id: 'comfort',
    name: '편안한 실내',
    icon: '◐',
    color: 'mint',
    description: '집이나 사무실에서 눈이 편하고 연결이 유지되는 균형 설정이에요.',
    settings: { brightness: 95, screenTimeout: 300_000, rotation: true, wifi: true, bluetooth: true }
  },
  {
    id: 'outdoor',
    name: '밝은 야외',
    icon: '☀',
    color: 'sun',
    description: '햇빛 아래에서 화면이 잘 보이도록 밝기를 높이고 화면을 오래 유지해요.',
    settings: { brightness: 225, screenTimeout: 300_000, rotation: true, wifi: true, bluetooth: true }
  },
  {
    id: 'battery',
    name: '배터리 아끼기',
    icon: '♢',
    color: 'blue',
    description: '밝기와 대기 시간을 낮추고 무선 연결을 꺼서 사용 시간을 늘려요.',
    settings: { brightness: 55, screenTimeout: 30_000, rotation: false, wifi: false, bluetooth: false }
  }
];

export class ProfileService {
  constructor({ deviceService, audit, dataRoot, now = () => new Date() }) {
    this.deviceService = deviceService;
    this.audit = audit;
    this.profileRoot = resolve(dataRoot, 'profiles');
    this.customPath = join(this.profileRoot, 'custom-profiles.json');
    this.historyPath = join(this.profileRoot, 'last-application.json');
    this.now = now;
  }

  async list() {
    await this.ensureDirectory();
    const [custom, lastApplied] = await Promise.all([
      readJson(this.customPath, []),
      readJson(this.historyPath, null)
    ]);
    return {
      profileVersion: 'rokid-visual-profiles-v1',
      builtIn: BUILT_IN_PROFILES,
      custom: Array.isArray(custom) ? custom : [],
      lastApplied
    };
  }

  async saveCurrent(name, serial = '') {
    const safeName = assertProfileName(name);
    const overview = await this.deviceService.overview(serial);
    const custom = await readJson(this.customPath, []);
    const profile = {
      id: `custom-${randomUUID()}`,
      name: safeName,
      icon: '♥',
      color: 'purple',
      description: '내가 직접 조절한 현재 상태를 저장한 모드예요.',
      settings: captureSettings(overview),
      createdAt: this.now().toISOString(),
      custom: true
    };
    await this.writeJson(this.customPath, [...(Array.isArray(custom) ? custom : []), profile].slice(-20));
    await this.audit.append({ type: 'profile.saved', profileId: profile.id, profileName: profile.name, status: 'succeeded' });
    return profile;
  }

  async apply(profileId, serial = '') {
    const profile = await this.findProfile(profileId);
    const overview = await this.deviceService.overview(serial);
    const before = captureSettings(overview);
    const changes = diffSettings(before, profile.settings);
    const applied = [];
    try {
      for (const change of changes) {
        await this.deviceService.control({ action: change.action, value: change.after, serial });
        applied.push(change);
      }
    } catch (error) {
      const rollbackErrors = await this.rollback(applied, before, serial);
      await this.audit.append({ type: 'profile.apply', profileId: profile.id, profileName: profile.name, status: 'failed', rolledBack: rollbackErrors.length === 0, rollbackErrors, error: String(error.message).slice(0, 240) });
      throw new ProfileError(502, rollbackErrors.length ? '모드 적용과 자동 되돌리기 중 일부가 실패했습니다. 감사 기록을 확인해 주세요.' : '모드를 적용하지 못해 바뀐 항목을 원래대로 되돌렸습니다.');
    }
    const history = {
      historyVersion: 'rokid-profile-history-v1',
      profileId: profile.id,
      profileName: profile.name,
      appliedAt: this.now().toISOString(),
      before,
      after: profile.settings,
      changes,
      undoneAt: null
    };
    await this.writeJson(this.historyPath, history);
    await this.audit.append({ type: 'profile.apply', profileId: profile.id, profileName: profile.name, status: 'succeeded', changeCount: changes.length });
    return { status: 'applied', profile, changes, before, after: profile.settings };
  }

  async undo(serial = '') {
    const history = await readJson(this.historyPath, null);
    if (!history || history.undoneAt) throw new ProfileError(409, '되돌릴 최근 모드 변경이 없습니다.');
    const overview = await this.deviceService.overview(serial);
    const current = captureSettings(overview);
    const changes = diffSettings(current, history.before);
    const applied = [];
    try {
      for (const change of changes) {
        await this.deviceService.control({ action: change.action, value: change.after, serial });
        applied.push(change);
      }
    } catch (error) {
      const rollbackErrors = await this.rollback(applied, current, serial);
      await this.audit.append({ type: 'profile.undo', profileId: history.profileId, status: 'failed', rolledBack: rollbackErrors.length === 0, error: String(error.message).slice(0, 240) });
      throw new ProfileError(502, '되돌리기를 완료하지 못했습니다. 현재 상태는 가능한 범위에서 보존했습니다.');
    }
    history.undoneAt = this.now().toISOString();
    await this.writeJson(this.historyPath, history);
    await this.audit.append({ type: 'profile.undo', profileId: history.profileId, profileName: history.profileName, status: 'succeeded', changeCount: changes.length });
    return { status: 'undone', profileName: history.profileName, restored: history.before, changes };
  }

  async findProfile(profileId) {
    const profiles = await this.list();
    const found = [...profiles.builtIn, ...profiles.custom].find((profile) => profile.id === profileId);
    if (!found) throw new ProfileError(404, '저장된 모드를 찾을 수 없습니다.');
    return found;
  }

  async rollback(applied, snapshot, serial) {
    const errors = [];
    for (const change of applied.slice().reverse()) {
      try {
        await this.deviceService.control({ action: change.action, value: snapshot[change.key], serial });
      } catch (error) {
        errors.push({ action: change.action, error: String(error.message).slice(0, 160) });
      }
    }
    return errors;
  }

  async ensureDirectory() {
    await mkdir(this.profileRoot, { recursive: true });
  }

  async writeJson(path, value) {
    await this.ensureDirectory();
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

export class ProfileError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function captureSettings(overview) {
  return {
    brightness: Number(overview.controls?.brightness) || 128,
    screenTimeout: Number(overview.controls?.screenTimeout) || 60_000,
    rotation: Boolean(overview.controls?.rotation),
    wifi: Boolean(overview.wifi?.enabled),
    bluetooth: Boolean(overview.controls?.bluetooth)
  };
}

function diffSettings(before, after) {
  const actions = { brightness: 'brightness', screenTimeout: 'timeout', rotation: 'rotation', wifi: 'wifi', bluetooth: 'bluetooth' };
  return Object.entries(actions).filter(([key]) => before[key] !== after[key]).map(([key, action]) => ({ key, action, before: before[key], after: after[key] }));
}

function assertProfileName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 1 || name.length > 30 || /[\r\n\t<>]/.test(name)) throw new ProfileError(400, '모드 이름은 1~30자의 일반 문자로 입력해 주세요.');
  return name;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
