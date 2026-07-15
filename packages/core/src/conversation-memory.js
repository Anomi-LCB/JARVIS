import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

// 대화기억(작업 일지): 완료된 작업을 파일로 영속해 두고,
// "그거 메일로 보내줘" / "방금 만든 파일 열어줘" 같은 지시어를 실제 파일로 해석한다.
// Core 서비스·브릿지·PC에이전트가 각자 런타임을 합성하므로 매크로처럼 홈 고정 경로를 공유한다.
const DEFAULT_JOURNAL = resolve(homedir(), '.jarvis', 'work-journal.jsonl');
const MAX_ENTRIES = 300; // 파일이 이 배수(2배)를 넘으면 최근 것만 남기고 다시 쓴다.

// 지시어의 명사가 파일 종류를 특정하면 그 확장자만 후보로 삼는다.
const typeHints = [
  { pattern: /엑셀|xlsx|스프레드시트|정산표|가계부/i, exts: ['.xlsx'] },
  { pattern: /워드|docx/i, exts: ['.docx'] },
  { pattern: /pdf|피디에프/i, exts: ['.pdf'] },
  { pattern: /한글|hwpx?|아래아/i, exts: ['.hwp', '.hwpx'] },
  { pattern: /피피티|파워포인트|발표|슬라이드|프레젠테이션|pptx?/i, exts: ['.pptx', '.ppt'] },
  { pattern: /메모|텍스트|txt/i, exts: ['.txt'] }
];

// 시간 단서(방금/아까/최근) 또는 지시 대명사(그거/그 파일)가 있어야 참조로 본다.
const temporalCue = /(방금|아까|조금\s*전|좀\s*전|마지막(에|으로)?|최근에?)\s*(만든|작성한|생성한|만들었던|저장한)?/;
const demonstrativeCue = /(그거|그것|이거|그\s*(파일|문서|엑셀|워드|보고서|피피티|발표\s*자료|pdf|한글|메모))/;
// 참조를 소비하는 동사가 함께 있어야 오탐을 줄인다(새 문서 생성 문장과 구분).
const consumingVerb = /(보내|전송|첨부|공유|올려|열어|실행|수정|고쳐|바꿔|편집|이동|옮겨|복사|이름|확인|보여)/;

export class WorkMemory {
  constructor({ journalPath = null, clock = () => new Date() } = {}) {
    this.journalPath = journalPath ?? process.env.JARVIS_WORK_JOURNAL ?? DEFAULT_JOURNAL;
    this.clock = clock;
  }

  load() {
    try {
      if (!existsSync(this.journalPath)) return [];
      const lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
      const entries = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* 손상 줄은 건너뛴다 */ }
      }
      return entries;
    } catch {
      return [];
    }
  }

  record({ taskId = null, rawText = '', actionType = null, outputPaths = [], summary = null, status = 'success' } = {}) {
    try {
      const entry = {
        at: this.clock().toISOString(),
        taskId,
        rawText: String(rawText).slice(0, 300),
        actionType,
        outputPaths: (Array.isArray(outputPaths) ? outputPaths : []).map((p) => String(p)).slice(0, 10),
        summary: summary ? String(summary).slice(0, 300) : null,
        status
      };
      mkdirSync(dirname(this.journalPath), { recursive: true });
      appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf8');
      this.compactIfNeeded();
      return entry;
    } catch {
      return null; // 기억 기록 실패가 본 작업을 깨면 안 된다.
    }
  }

  compactIfNeeded() {
    try {
      const entries = this.load();
      if (entries.length <= MAX_ENTRIES * 2) return;
      const keep = entries.slice(-MAX_ENTRIES);
      writeFileSync(this.journalPath, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch { /* ignore */ }
  }

  recent(limit = 20) {
    return this.load().slice(-limit).reverse(); // 최신 우선
  }

  // 산출물이 있는 성공 작업만, 최신 우선.
  recentOutputs(limit = 20) {
    return this.recent(50)
      .filter((e) => e.status === 'success' && e.outputPaths?.length)
      .slice(0, limit);
  }

  // 지시어("그거/방금 만든 보고서")를 최근 산출물로 해석한다.
  // 해석 성공 시 { path, entry, matchedPhrase, hintedExts } 반환, 아니면 null.
  resolveReference(rawText) {
    const text = String(rawText ?? '');
    if (!text) return null;
    if (!consumingVerb.test(text)) return null; // 산출물을 쓰는 동사가 없으면 참조 아님
    const temporal = text.match(temporalCue);
    const demonstrative = text.match(demonstrativeCue);
    const hinted = typeHints.find((h) => h.pattern.test(text));
    // 지시 대명사("그거/그 파일")는 그 자체로 참조.
    // 시간 단서("방금/아까")만 있을 때는 생성 수식어나 파일 종류 명사가 함께 있어야 한다
    // ("방금 목록 보여줘" 같은 문장을 참조로 오인하지 않기 위해).
    const creationModifier = /(만든|작성한|생성한|만들었던|저장한)/.test(text);
    const isReference = Boolean(demonstrative) || (Boolean(temporal?.[0]?.trim()) && (creationModifier || Boolean(hinted)));
    if (!isReference) return null;

    const candidates = this.recentOutputs(20).filter((entry) =>
      !hinted || entry.outputPaths.some((p) => hinted.exts.some((ext) => p.toLowerCase().endsWith(ext)))
    );
    if (!candidates.length) return null;
    const entry = candidates[0];
    const path = hinted
      ? entry.outputPaths.find((p) => hinted.exts.some((ext) => p.toLowerCase().endsWith(ext)))
      : entry.outputPaths[entry.outputPaths.length - 1];
    if (!path) return null;

    // 문장에서 치환할 구간: 시간단서+수식어+명사 또는 지시 대명사 구.
    const phrasePattern = new RegExp(
      `(방금|아까|조금\\s*전|좀\\s*전|마지막(?:에|으로)?|최근에?)?\\s*(만든|작성한|생성한|만들었던|저장한)?\\s*(그\\s*)?(거|것|파일|문서|엑셀|워드|보고서|피피티|발표\\s*자료|pdf|한글|메모|그거|그것|이거)(?:[을를은는이가]?)`
    );
    const phrase = text.match(phrasePattern);
    const fallbackPhrase = demonstrative?.[0] ?? temporal?.[0]?.trim() ?? '';
    const matchedPhrase = phrase && phrase[0].trim() ? phrase[0] : fallbackPhrase;
    if (!matchedPhrase) return null;
    return {
      path,
      entry,
      matchedPhrase,
      hintedExts: hinted?.exts ?? null
    };
  }

  // 지시어를 파일명으로 바꾼 새 문장을 만든다. 해석 불가면 원문 유지.
  rewriteWithReference(rawText) {
    const hit = this.resolveReference(rawText);
    if (!hit) return null;
    const name = basename(hit.path);
    const rewritten = String(rawText).replace(hit.matchedPhrase, `"${name}"`)
      + ` [파일 경로: ${hit.path}]`;
    return { rewritten, ...hit };
  }

  // LLM 프롬프트에 넣을 최근 작업 요약(간결).
  contextHints(limit = 5) {
    return this.recentOutputs(limit).map((e) => {
      const files = e.outputPaths.map((p) => basename(p)).join(', ');
      return `- ${e.at.slice(0, 16).replace('T', ' ')} "${e.rawText}" → ${files}`;
    });
  }
}
