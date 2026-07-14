import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 여러 프로세스(Core·PC-Agent)가 같은 파일을 봐야 하므로 cwd에 의존하지 않는 절대 경로를 쓴다.
function defaultMacroPath() {
  if (process.env.JARVIS_MACRO_PATH) return process.env.JARVIS_MACRO_PATH;
  if (process.env.JARVIS_BRIDGE_STATE_DIR) return join(process.env.JARVIS_BRIDGE_STATE_DIR, 'macros.json');
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return join(home, '.jarvis', 'macros.json');
}

// 명시적 매크로: 사용자가 이름 붙여 저장한 작업. 자연어로 저장·실행을 인식한다.
// 저장 예: "다운로드 정리를 주간청소로 저장해줘", "이 작업 주간정리로 기억해"
// 실행 예: "주간청소", "주간청소 해줘", "주간정리 실행"
export class MacroStore {
  constructor({ path = null } = {}) {
    this.path = path ?? defaultMacroPath();
    this.macros = this.load();
  }

  load() {
    try {
      if (existsSync(this.path)) return JSON.parse(readFileSync(this.path, 'utf8')) ?? {};
    } catch { /* corrupt/absent -> empty */ }
    return {};
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.macros, null, 2), 'utf8');
    } catch { /* optional */ }
  }

  normalizeName(name) {
    return String(name ?? '').trim().replace(/["'']/g, '').toLowerCase();
  }

  save(name, command) {
    const key = this.normalizeName(name);
    if (!key || !command) return false;
    this.macros[key] = { name: String(name).trim().replace(/["'']/g, ''), command: String(command).trim(), createdAt: new Date().toISOString() };
    this.persist();
    return true;
  }

  list() {
    return Object.values(this.macros).map((m) => m.name);
  }

  // 이름이 "저장 위치"처럼 보이면 매크로 이름이 아니다("D드라이브로 저장", "다운로드 폴더로 저장").
  looksLikeDestination(name) {
    return /드라이브|폴더|디렉[터토]리|경로|바탕화면|다운로드|문서함|desktop|downloads|documents|^[A-Za-z]:?$|여기|거기/i.test(String(name ?? ''));
  }

  // "다운로드 정리를 '주간청소'로 저장/기억해줘" 형태에서 {name, command}를 뽑는다.
  parseSave(rawText) {
    const text = String(rawText ?? '').trim();
    if (!/(저장|기억)/.test(text)) return null;
    // 형태 A: <명령>을(를)/<공백> <이름>(으)로 저장/기억  (이름은 공백 없는 한 토큰)
    let m = text.match(/^(.+?)[\s을를]+['"]?([가-힣A-Za-z0-9_]{1,20})['"]?\s*(?:으로|로)\s*(?:저장|기억)(?:\s*해\s*줘|해|하기|할래|하자|할게)?\s*$/);
    if (m && m[1].trim() && m[2].trim() && !this.looksLikeDestination(m[2])) return { command: m[1].trim(), name: m[2].trim() };
    // 형태 B: <이름>(으)로 저장: <명령>
    m = text.match(/['"]?([가-힣A-Za-z0-9_ ]{1,20}?)['"]?\s*(?:으로|로)\s*(?:저장|기억)\s*[:：]\s*(.+)$/);
    if (m && m[1].trim() && m[2].trim() && !this.looksLikeDestination(m[1])) return { command: m[2].trim(), name: m[1].trim() };
    return null;
  }

  // 실행 요청이면 저장된 명령을 돌려준다. "주간청소", "주간청소 해줘/실행/불러와" 등.
  resolveRun(rawText) {
    const stripped = String(rawText ?? '').trim().replace(/\s*(해\s*줘|해|실행(해\s*줘)?|불러와|돌려\s*줘?|시작|줘)\s*$/u, '').trim();
    for (const candidate of [rawText.trim(), stripped]) {
      const key = this.normalizeName(candidate);
      if (key && this.macros[key]) return this.macros[key];
    }
    return null;
  }
}
