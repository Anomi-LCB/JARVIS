const PROPERTY_FIELDS = {
  manufacturer: 'ro.product.manufacturer',
  model: 'ro.product.model',
  device: 'ro.product.device',
  android: 'ro.build.version.release',
  sdk: 'ro.build.version.sdk',
  fingerprint: 'ro.build.fingerprint',
  hardware: 'ro.hardware',
  verifiedBoot: 'ro.boot.verifiedbootstate',
  flashLocked: 'ro.boot.flash.locked',
  vbmetaState: 'ro.boot.vbmeta.device_state',
  bootSlot: 'ro.boot.slot_suffix',
  buildType: 'ro.build.type',
  buildId: 'ro.build.id',
  cryptoState: 'ro.crypto.state'
};

const KEY_EVENTS = {
  home: 3,
  back: 4,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  enter: 66,
  power: 26,
  volumeUp: 24,
  volumeDown: 25,
  camera: 27
};

const CONTROL_CONFIRMATIONS = {
  forceStop: '앱 중지',
  disablePackage: '앱 비활성화',
  reboot: '기기 재시작',
  rebootBootloader: '부트로더 재시작'
};

export class DeviceService {
  constructor({ adb, audit }) {
    this.adb = adb;
    this.audit = audit;
  }

  async devices() {
    const devices = await this.adb.listDevices();
    return devices.map((device) => ({
      ...device,
      isRokid: /rokid|glasses/i.test(`${device.product ?? ''} ${device.model ?? ''} ${device.device ?? ''}`),
      authorized: device.state === 'device'
    }));
  }

  async selectRokid(serial = '') {
    const devices = await this.devices();
    const selected = serial
      ? devices.find((device) => device.serial === serial && device.authorized)
      : devices.find((device) => device.isRokid && device.authorized);
    if (!selected) throw new DeviceError(409, '승인된 Rokid 장치를 찾을 수 없습니다.');
    return selected;
  }

  async overview(serial = '') {
    const device = await this.selectRokid(serial);
    const entries = await Promise.all(Object.entries(PROPERTY_FIELDS).map(async ([key, property]) => [
      key,
      await this.safeShell(device.serial, ['getprop', property])
    ]));
    const [display, density, battery, storage, wifi, activity, selinux, features, brightness, screenTimeout, rotation, bluetooth, power] = await Promise.all([
      this.safeShell(device.serial, ['wm', 'size']),
      this.safeShell(device.serial, ['wm', 'density']),
      this.safeShell(device.serial, ['dumpsys', 'battery']),
      this.safeShell(device.serial, ['df', '-h', '/data']),
      this.safeShell(device.serial, ['dumpsys', 'wifi']),
      this.safeShell(device.serial, ['dumpsys', 'activity', 'activities']),
      this.safeShell(device.serial, ['getenforce']),
      this.safeShell(device.serial, ['pm', 'list', 'features']),
      this.safeShell(device.serial, ['settings', 'get', 'system', 'screen_brightness']),
      this.safeShell(device.serial, ['settings', 'get', 'system', 'screen_off_timeout']),
      this.safeShell(device.serial, ['settings', 'get', 'system', 'accelerometer_rotation']),
      this.safeShell(device.serial, ['settings', 'get', 'global', 'bluetooth_on']),
      this.safeShell(device.serial, ['dumpsys', 'power'])
    ]);
    return {
      serial: device.serial,
      transport: device,
      properties: Object.fromEntries(entries),
      display: parseDisplay(display, density),
      battery: parseKeyValues(battery),
      storage: parseStorage(storage),
      wifi: parseWifi(wifi),
      controls: {
        brightness: parseBoundedInteger(brightness, 1, 255, 128),
        screenTimeout: parseBoundedInteger(screenTimeout, 15_000, 1_800_000, 60_000),
        rotation: String(rotation).trim() === '1',
        bluetooth: String(bluetooth).trim() === '1'
      },
      power: parsePowerState(power),
      currentActivity: parseCurrentActivity(activity),
      selinux,
      features: features.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^feature:/, '')),
      access: {
        adbAuthorized: true,
        bootloaderUnlocked: Object.fromEntries(entries).vbmetaState === 'unlocked' || Object.fromEntries(entries).flashLocked === '0',
        root: false,
        rawPartitionBackupAvailable: false,
        note: '현재 ADB shell과 debuggable 앱 데이터에 접근할 수 있습니다. 원시 파티션은 루트/복구 환경이 필요합니다.'
      }
    };
  }

  async packages(serial = '') {
    const device = await this.selectRokid(serial);
    const [paths, thirdParty, launchActivities] = await Promise.all([
      this.adb.shell(device.serial, ['pm', 'list', 'packages', '-f']),
      this.adb.shell(device.serial, ['pm', 'list', 'packages', '-3']),
      this.safeShell(device.serial, ['cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'])
    ]);
    const third = new Set(parsePackageNames(thirdParty));
    const launchable = parseLaunchablePackages(launchActivities);
    const packages = paths.split(/\r?\n/).map(parsePackagePath).filter(Boolean).map((item) => ({
      ...item,
      launchable: launchable.has(item.name),
      launchComponent: launchable.get(item.name) ?? ''
    }));
    const details = await mapLimit(packages, 5, async (item) => {
      if (!isRokidPackage(item.name) && !third.has(item.name)) return { ...item, thirdParty: third.has(item.name) };
      const dump = await this.safeShell(device.serial, ['dumpsys', 'package', item.name]);
      return { ...item, thirdParty: third.has(item.name), ...parsePackageDetails(dump) };
    });
    return details.sort((a, b) => Number(isRokidPackage(b.name)) - Number(isRokidPackage(a.name)) || a.name.localeCompare(b.name));
  }

  async settings(scope = 'system', serial = '') {
    if (!['system', 'secure', 'global'].includes(scope)) throw new DeviceError(400, '지원하지 않는 설정 범위입니다.');
    const device = await this.selectRokid(serial);
    const output = await this.adb.shell(device.serial, ['settings', 'list', scope]);
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const index = line.indexOf('=');
      return { key: index >= 0 ? line.slice(0, index) : line, value: index >= 0 ? line.slice(index + 1) : '' };
    });
  }

  async logcat({ serial = '', lines = 200 } = {}) {
    const device = await this.selectRokid(serial);
    const safeLines = Math.min(Math.max(Number(lines) || 200, 20), 1000);
    return this.adb.shell(device.serial, ['logcat', '-d', '-t', String(safeLines)], { maxBuffer: 8 * 1024 * 1024 });
  }

  async screenshot(serial = '') {
    const device = await this.selectRokid(serial);
    return this.adb.execOut(device.serial, ['screencap', '-p'], { maxBuffer: 32 * 1024 * 1024 });
  }

  async screenInteraction({ kind, x, y, endX, endY, durationMs, serial = '' }) {
    const device = await this.selectRokid(serial);
    const display = parseDisplay(
      await this.safeShell(device.serial, ['wm', 'size']),
      await this.safeShell(device.serial, ['wm', 'density'])
    );
    if (!display.width || !display.height) throw new DeviceError(409, '안경 화면 크기를 확인할 수 없습니다.');
    const start = {
      x: assertInteger(x, 0, display.width - 1, '가로 위치'),
      y: assertInteger(y, 0, display.height - 1, '세로 위치')
    };
    let args;
    if (kind === 'tap') {
      args = ['input', 'tap', String(start.x), String(start.y)];
    } else if (kind === 'swipe' || kind === 'longPress') {
      const finish = kind === 'longPress'
        ? start
        : {
            x: assertInteger(endX, 0, display.width - 1, '끝 가로 위치'),
            y: assertInteger(endY, 0, display.height - 1, '끝 세로 위치')
          };
      const safeDuration = assertInteger(durationMs ?? (kind === 'longPress' ? 650 : 280), 50, 5_000, '누르는 시간');
      args = ['input', 'swipe', String(start.x), String(start.y), String(finish.x), String(finish.y), String(safeDuration)];
    } else {
      throw new DeviceError(400, '지원하지 않는 화면 조작입니다.');
    }
    const startedAt = Date.now();
    try {
      const output = await this.adb.shell(device.serial, args);
      const record = await this.audit.append({
        type: 'screen.interaction', serial: device.serial, kind, start,
        end: kind === 'swipe' ? { x: Number(endX), y: Number(endY) } : undefined,
        durationMs: kind === 'tap' ? undefined : Number(durationMs ?? (kind === 'longPress' ? 650 : 280)),
        status: 'succeeded', elapsedMs: Date.now() - startedAt
      });
      return { status: 'succeeded', display, audit: record, output };
    } catch (error) {
      await this.audit.append({ type: 'screen.interaction', serial: device.serial, kind, start, status: 'failed', error: String(error.message).slice(0, 300), elapsedMs: Date.now() - startedAt });
      throw error;
    }
  }

  async readSetting(scope, key, serial = '') {
    assertSettingScope(scope);
    assertSettingKey(key);
    const items = await this.settings(scope, serial);
    const found = items.find((item) => item.key === key);
    return found ? { exists: true, value: found.value } : { exists: false, value: '' };
  }

  async writeSetting(scope, key, value, serial = '') {
    assertSettingScope(scope);
    assertSettingKey(key);
    const safeValue = assertSettingValue(value);
    const device = await this.selectRokid(serial);
    return this.adb.shell(device.serial, ['settings', 'put', scope, key, safeValue]);
  }

  async deleteSetting(scope, key, serial = '') {
    assertSettingScope(scope);
    assertSettingKey(key);
    const device = await this.selectRokid(serial);
    return this.adb.shell(device.serial, ['settings', 'delete', scope, key]);
  }

  async control({ action, value, packageName, confirmation, serial = '' }) {
    const device = await this.selectRokid(serial);
    const required = CONTROL_CONFIRMATIONS[action];
    if (required && confirmation !== required) {
      throw new DeviceError(412, `확인 문구 “${required}”가 필요합니다.`, { requiredConfirmation: required });
    }
    const args = await this.controlArgs(device.serial, { action, value, packageName });
    const startedAt = Date.now();
    try {
      const output = await this.adb.shell(device.serial, args, { timeout: action.startsWith('reboot') ? 10_000 : 30_000 });
      const record = await this.audit.append({ type: 'device.control', serial: device.serial, action, value, packageName, status: 'succeeded', durationMs: Date.now() - startedAt });
      return { status: 'succeeded', output, audit: record };
    } catch (error) {
      await this.audit.append({ type: 'device.control', serial: device.serial, action, value, packageName, status: 'failed', error: String(error.message).slice(0, 300), durationMs: Date.now() - startedAt });
      throw error;
    }
  }

  async controlArgs(serial, { action, value, packageName }) {
    if (action === 'key') {
      if (!Object.hasOwn(KEY_EVENTS, value)) throw new DeviceError(400, '지원하지 않는 키입니다.');
      return ['input', 'keyevent', String(KEY_EVENTS[value])];
    }
    if (action === 'brightness') return ['settings', 'put', 'system', 'screen_brightness', String(assertInteger(value, 1, 255, '밝기'))];
    if (action === 'timeout') return ['settings', 'put', 'system', 'screen_off_timeout', String(assertInteger(value, 15_000, 1_800_000, '화면 꺼짐 시간'))];
    if (action === 'rotation') return ['settings', 'put', 'system', 'accelerometer_rotation', value === true || value === '1' ? '1' : '0'];
    if (action === 'wifi') return ['svc', 'wifi', asEnabled(value) ? 'enable' : 'disable'];
    if (action === 'bluetooth') return ['svc', 'bluetooth', asEnabled(value) ? 'enable' : 'disable'];
    if (['launch', 'forceStop', 'enablePackage', 'disablePackage'].includes(action)) {
      assertPackageName(packageName);
      const installed = new Map((await this.packages(serial)).map((item) => [item.name, item]));
      if (!installed.has(packageName)) throw new DeviceError(404, '설치된 패키지가 아닙니다.');
      if (action === 'launch') {
        const component = installed.get(packageName).launchComponent;
        if (!component) throw new DeviceError(409, '이 구성 요소는 직접 여는 화면이 없는 백그라운드 서비스입니다.');
        return ['am', 'start', '-n', component];
      }
      if (action === 'forceStop') return ['am', 'force-stop', packageName];
      if (action === 'enablePackage') return ['pm', 'enable', packageName];
      return ['pm', 'disable-user', '--user', '0', packageName];
    }
    if (action === 'reboot') return ['reboot'];
    if (action === 'rebootBootloader') return ['reboot', 'bootloader'];
    throw new DeviceError(400, '지원하지 않는 제어 동작입니다.');
  }

  async safeShell(serial, args) {
    try {
      return await this.adb.shell(serial, args);
    } catch {
      return '';
    }
  }
}

export class DeviceError extends Error {
  constructor(statusCode, message, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function parsePackagePath(line) {
  const match = String(line).match(/^package:(.+)=(.+)$/);
  return match ? { path: match[1], name: match[2] } : null;
}

export function parseLaunchablePackages(output) {
  const components = String(output).match(/(?:^|\s)([a-zA-Z][\w]*(?:\.[\w]+)+\/[^\s]+)/gm) ?? [];
  return new Map(components.map((entry) => {
    const component = entry.trim();
    return [component.split('/')[0], component];
  }));
}

function parsePackageNames(output) {
  return String(output).split(/\r?\n/).map((line) => line.replace(/^package:/, '').trim()).filter(Boolean);
}

function parsePackageDetails(output) {
  return {
    versionName: output.match(/versionName=([^\s]+)/)?.[1] ?? '',
    versionCode: output.match(/versionCode=(\d+)/)?.[1] ?? '',
    debuggable: /flags=\[[^\]]*DEBUGGABLE/.test(output),
    enabled: !/User 0:[^\n]*enabled=(?:2|3|4)/.test(output),
    permissions: [...output.matchAll(/android\.permission\.([A-Z0-9_]+)/g)].map((match) => match[1]).filter((value, index, all) => all.indexOf(value) === index)
  };
}

function parseDisplay(size, density) {
  const match = size.match(/Physical size:\s*(\d+)x(\d+)/);
  return { width: Number(match?.[1] ?? 0), height: Number(match?.[2] ?? 0), density: Number(density.match(/Physical density:\s*(\d+)/)?.[1] ?? 0) };
}

function parseKeyValues(output) {
  return Object.fromEntries(String(output).split(/\r?\n/).map((line) => line.trim().match(/^([^:]+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2]]));
}

function parseStorage(output) {
  const lines = String(output).split(/\r?\n/).filter(Boolean);
  const cells = lines.at(-1)?.trim().split(/\s+/) ?? [];
  return { raw: output, size: cells[1] ?? '', used: cells[2] ?? '', available: cells[3] ?? '', usePercent: cells[4] ?? '' };
}

function parseWifi(output) {
  return { enabled: /Wi-Fi is enabled|mWifiEnabled=true/i.test(output), state: output.match(/Wi-Fi is (enabled|disabled)/i)?.[1] ?? 'unknown' };
}

function parseCurrentActivity(output) {
  return output.match(/(?:topResumedActivity|ResumedActivity):\s*ActivityRecord\{[^}]*\s([\w.]+\/[\w.$]+)/)?.[1] ?? '';
}

function parsePowerState(output) {
  const wakefulness = String(output).match(/mWakefulness=(\w+)/)?.[1] ?? 'Unknown';
  return { wakefulness, screenOn: /^Awake$/i.test(wakefulness) };
}

function parseBoundedInteger(value, min, max, fallback) {
  const number = Number(String(value).trim());
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function isRokidPackage(name) {
  return /rokid|krokid|vibeos|glasses|hud/i.test(name);
}

function assertInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new DeviceError(400, `${label} 값이 허용 범위를 벗어났습니다.`);
  return number;
}

function asEnabled(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function assertPackageName(value) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(String(value ?? ''))) throw new DeviceError(400, '잘못된 패키지 이름입니다.');
}

function assertSettingScope(value) {
  if (!['system', 'secure', 'global'].includes(value)) throw new DeviceError(400, '지원하지 않는 설정 범위입니다.');
}

function assertSettingKey(value) {
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(String(value ?? ''))) throw new DeviceError(400, '설정 이름이 올바르지 않습니다.');
}

function assertSettingValue(value) {
  const text = String(value ?? '');
  if (text.length > 4_096 || /[\u0000-\u001f\u007f;&|`$<>"'\\]/.test(text)) {
    throw new DeviceError(400, '이 값은 안전한 시각 편집기로 변경할 수 없습니다.');
  }
  return text;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
