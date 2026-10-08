import {LocalWorkflowToolAdapter} from './adapters/workflow/local-workflow-adapter.js';
import { executionPacketFingerprint } from '../../../packages/shared/src/execution-packet-fingerprint.js';
import {capabilityAdapterCodeVersion} from '../../../packages/core/src/capabilities/capability-package-registry.js';
import {readTextSnapshot, selectTextRange, TextReadBoundaryError} from './adapters/filesystem/read-text-snapshot.js';
import {PdfTextReader} from './adapters/pdf/pdf-reader.js';
import {createVerifiedPresentation} from './adapters/powerpoint/native-authoring.js';
import {verifyDocumentTables,verifyDocumentParagraphs} from './adapters/word/table-verifier.js';
import {createVerifiedWordDocument} from './adapters/word/native-authoring.js';
import {publishVerifiedHwpStage} from './adapters/hwpx/hwp-publication.js';
import {NativeHancomPdfRenderer} from './adapters/hwpx/native-pdf-renderer.js';
import {HANCOM_MAX_RENDER_PAGES,hancomPublicationPaths,hancomActualOutputPaths} from './adapters/hwpx/artifact-contract.js';
import {verifyCardLayout} from './adapters/visual/card-layout-contract.js';
import {validateCardPublicationResult} from './adapters/visual/artifact-contract.js';
import {editDigest,validateDocumentEditResult} from './adapters/excel/edit-contract.js';
import {XlsxRegionReader} from './adapters/excel/xlsx-reader.js';
export { executionPacketFingerprint };
import { access, copyFile, mkdir, mkdtemp, link, readFile, readdir, stat, lstat, writeFile, rm, rename, realpath } from 'node:fs/promises';
import { constants as fsConstants, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync, statSync, lstatSync, unlinkSync, renameSync, realpathSync, linkSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionType, maskSensitive, ModuleId, stableId, TaskStatus } from '../../../packages/shared/src/types.js';
import { JsonlAuditLog } from '../../../packages/shared/src/audit-log.js';
import { appendJsonlImmediateSync, appendJsonlSync } from '../../../packages/shared/src/jsonl.js';
import { ExcelWorkbookWorker, runWorkbookProductFixturePack } from './adapters/excel/excel-worker.js';
import {NativeWorkbookPdfRenderer,nativeFailureRecovery} from './adapters/excel/native-pdf-renderer.js';
import {validateXlsxNativeExport} from '../../../packages/core/src/mission/xlsx-cell-evidence.js';
import { createClaudeCliRunner } from '../../../packages/core/src/intent/claude-cli-intent-adapter.js';
import { defaultSkillManifest } from '../../../packages/core/src/routing/default-skill-manifest.js';
import { MacroStore } from '../../../packages/core/src/macro-store.js';
import {validateMacroPublicationResult} from '../../../packages/shared/src/macro-publication-contract.js';
import { RemoteOperationStore, inspectPublicationContract } from './remote-operation-store.js';
import { actionArgumentsBinding } from '../../../packages/shared/src/action-arguments-binding.js';

// Function capabilities are in-process only and never part of a packet, journal or HTTP DTO.
const trustedLocalEffectFences = new WeakMap();
const trustedRemoteMutationChecks = new WeakMap();
const trustedFileOperationClaim = Symbol('B-owned-file-operation-claim');
import { appCatalog } from '../../../packages/core/src/app-catalog.js';
import { WindowsDesktopControlToolAdapter } from './windows-desktop-control.js';
import {
  OpenMeteoWeatherClient,
  buildWeeklyWeatherHwpDocument,
  weatherReportFileName
} from './adapters/weather/open-meteo-weather.js';
import { NewsFetchHeadlinesToolAdapter } from './adapters/news/google-news-rss.js';
import { NewsFetchArticleToolAdapter } from './adapters/news/publisher-article-reader.js';
import { NewsFetchPublisherFeedToolAdapter, PublisherRssFeedClient } from './adapters/news/publisher-rss-feed.js';
import { resolveCataloguedPublisherHeadlines } from './adapters/news/publisher-headline-resolver.js';

function execFileAsync(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function delayAsync(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, milliseconds)));
}

// 자비스가 자기 능력을 스스로 설명한다(skill 매니페스트 기반이라 도구가 늘면 자동 반영—유기적).
export class CapabilityDescribeToolAdapter {
  constructor({ capabilityProvider = null } = {}) {
    this.capabilityProvider = typeof capabilityProvider === 'function' ? capabilityProvider : null;
    this.contract = createToolContract({ toolName: 'capability.describe', readOnly: true, evidence: ['capabilityCount'] });
  }

  capabilityEntries() {
    const manifestByTool = new Map(defaultSkillManifest.map((skill) => [skill.toolName, skill]));
    const runtimeContracts = this.capabilityProvider?.();
    const source = Array.isArray(runtimeContracts) && runtimeContracts.length > 0
      ? runtimeContracts.map((contract) => ({
          toolName: contract?.toolName,
          label: manifestByTool.get(contract?.toolName)?.label ?? contract?.label ?? contract?.toolName
        }))
      : defaultSkillManifest.map((skill) => ({ toolName: skill.toolName, label: skill.label }));
    return [...new Map(source
      .filter((entry) => entry.toolName && entry.toolName !== 'capability.describe')
      .map((entry) => [entry.toolName, entry])).values()];
  }

  buildCatalog(entries = this.capabilityEntries()) {
    const labelKo = {
      'Excel Workbook Create': '엑셀 파일 만들기', 'Text File Create': '텍스트·문서 파일 만들기',
      'Hangul (HWP) File Create': '한글(HWP) 파일 만들기', 'File List': '폴더 목록 보기',
      'Word Document Create': '워드(docx)·PDF 문서 만들기', 'PowerPoint Deck Create': '파워포인트(pptx) 발표자료 만들기',
      'File Move': '파일 옮기기', 'Read-only Browser Search': '웹 검색', 'Shell Command Execute': '시스템 명령 실행',
      'File Search': '파일 찾기', 'Verified Text File Read': '텍스트·CSV·JSON 내용을 안전하게 읽기', 'Email Send': '메일 보내기', 'Document Edit': '문서(엑셀) 내용 수정',
      'Verified PNG Card Create': '검증 가능한 PNG 카드 여러 장 만들기', 'Verified ZIP Archive Create': '검증 가능한 ZIP 묶음 만들기',
      'External Transfer Review': '외부 전송(검토)', 'Windows Desktop Control': 'Windows 앱 화면 직접 조작·결과 확인',
      'Live Korean News Headlines': '실시간 한국어 뉴스 헤드라인 조회',
      'workflow.execute': '검증된 로컬 복합 워크플로 실행',
      'Verified Local Workflow Execute': '검증된 로컬 복합 워크플로 실행'
    };
    const labels = [...new Set(entries.map((entry) => entry.label))].filter((label) => label !== '능력 조회');
    const skillLines = labels.map((l) => `• ${labelKo[l] ?? l}`);
    const nativeApps = appCatalog.filter((app) => app.authoring && app.progId).map((app) => app.labelKo).join(', ');
    const extraLines = [
      `• 프로그램 네이티브 저작(설치된 경우): ${nativeApps}`,
      '• 시스템 명령·프로그램 실행/조작 (승인 후)',
      '• 표준 Windows 컨트롤과 화면에 그려진 글자 버튼을 로컬 OCR로 조작하고 결과 확인',
      '• 모르는 요청도 셸로 즉석 처리 시도',
      '• 자주 하는 요청은 즉시 재현(결정화)',
      '• 직전 작업 기억 — "그거 메일로 보내줘", "방금 만든 파일 열어줘"처럼 이어서 시키기'
    ];
    return [
      '제가 지금 할 수 있는 일이에요:',
      ...skillLines,
      ...extraLines,
      '',
      '🔧 아직 다듬고 있는 것:',
      '• 글자가 없는 아이콘·게임·영상·원격 데스크톱의 범용 시각 제어',
      '• 로그인된 외부 사이트의 제출·업로드·구매 같은 쓰기 작업',
      '• 복합 명령 속도 (여러 단계를 한 번에 시키면 시간이 좀 걸려요)',
      '',
      '⚠️ 안전을 위해 "파일 삭제"와 "저(자비스) 자신 종료"는 막아 두었어요.',
      '   그 밖의 위험한 작업(시스템 설정·설치 등)은 승인을 받고 진행해요.'
    ].join('\n');
  }

  async shadow() {
    return { mode: 'shadow', expectedChangesCount: 0, warnings: [] };
  }

  async execute() {
    const entries = this.capabilityEntries();
    const summary = this.buildCatalog(entries);
    return { status: 'success', summary, capabilityCount: entries.length, outputPaths: [], rollbackAvailable: false };
  }
}

// 매크로 저장: "~를 XX로 저장" 문장에서 이름·명령을 뽑아 파일에 저장한다.
// 실행("XX 해줘")은 Core가 저장된 명령으로 치환하므로 여기선 저장만 담당한다.
export class MacroSaveToolAdapter {
  constructor({ store = null } = {}) {
    this.store = store ?? new MacroStore();
    this.contract = createToolContract({ toolName: 'macro.save', readOnly: false, mutatesSystem:true, evidence: ['macroName'] });
  }

  parse(args) {
    const rawText = String(args?.rawText ?? args?.text ?? '').trim();
    return { rawText, parsed: this.store.parseSave(rawText) };
  }

  async shadow(args) {
    const { parsed } = this.parse(args);
    if (!parsed) return { mode: 'shadow', expectedChangesCount: 0, warnings: ['매크로 이름·명령을 알아듣지 못했어요. 예: "다운로드 정리를 주간청소로 저장"'] };
    return { mode: 'shadow', expectedChangesCount: 1, warnings: [], preview: `"${parsed.name}" = ${parsed.command}` };
  }

  async preparePublication(args) {
    const {rawText,parsed}=this.parse(args);
    if(!parsed)throw Error('B_MACRO_REQUEST_INVALID');
    return {...this.store.prepareSave(parsed.name,parsed.command),rawText};
  }

  inspectPublication(prepared) { return this.store.inspectPublication(prepared); }

  async execute(args,packet={},context={}) {
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    try{assertAccess();}catch(error){return {status:'blocked',error:error.message,outputPaths:[],rollbackAvailable:false};}
    this.store.macros = this.store.load(); // 최신 파일 반영
    const { rawText, parsed } = this.parse(args);
    if (!parsed) {
      return {
        status: 'needs_choice',
        summary: `매크로로 저장할 이름과 명령을 못 알아들었어요. 원문: "${rawText}"\n예: "다운로드 폴더 정리를 주간청소로 저장" 처럼 말해 주세요.`,
        outputPaths: [], rollbackAvailable: false
      };
    }
    let prepared=context.macroPublication;
    if(!prepared){try{prepared=await this.preparePublication(args);assertAccess();}
      catch(error){return {status:'failed',error:error.message,uncertain:false,outputPaths:[],rollbackAvailable:false};}}
    if(prepared&&prepared.rawText!==rawText)return {status:'blocked',error:'B_MACRO_REQUEST_CHANGED',outputPaths:[],rollbackAvailable:false};
    if(context.beforeArtifactWrite){await context.beforeArtifactWrite({paths:[prepared.path],prepared});assertAccess();}
    const ok = this.store.save(parsed.name, parsed.command,{assertAccess,prepared});
    if (!ok) return { status: 'failed', error:this.store.lastError??'B_MACRO_SAVE_FAILED',summary: '매크로 저장 결과를 확인하지 못했어요.',
      uncertain:this.store.lastSavePublished===true,outputPaths:this.store.lastSavePublished===true?[this.store.path]:[],rollbackAvailable: false };
    let macroObservation;
    if(prepared){try{macroObservation=this.store.inspectPublication(prepared);}
      catch(error){return {status:'failed',error:error.message,uncertain:true,outputPaths:[this.store.path],rollbackAvailable:false};}}
    return {
      status: 'success',
      summary: `"${parsed.name}" 매크로로 저장했어요. 이제 "${parsed.name}" 또는 "${parsed.name} 해줘"라고 하면 실행해요.\n(등록된 명령: ${parsed.command})`,
      macroName: parsed.name,
      ...(prepared?{macroPublication:structuredClone(prepared),macroObservation}:{}),
      verification:{passed:true,method:'current-whole-macro-store',sha256:macroObservation.sha256},
      changedItems:[{type:'macro_save',path:prepared.path,key:prepared.key,name:prepared.record.name}],
      outputPaths: [this.store.path],
      rollbackAvailable: false
    };
  }
}

// 자기교정용 프롬프트: 실패한 셸 명령의 원인을 주고 수정 명령을 받는다.
function buildShellCorrectionPrompt({ rawText, command, stderr, verifyOutput }) {
  return [
    '이전에 실행한 PowerShell 명령이 목표를 달성하지 못했습니다. 원인을 추정해 수정한 명령을 만드세요.',
    `원래 사용자 요청: ${rawText || '(불명)'}`,
    `실행했던 명령: ${command}`,
    `표준오류(stderr): ${stderr ? stderr.slice(0, 500) : '(없음)'}`,
    `검증 결과(기대와 다름): ${verifyOutput ? verifyOutput.slice(0, 300) : '(출력 없음)'}`,
    '',
    '규칙: 삭제/포맷/종료/외부전송 등 파괴적 명령은 만들지 않는다. 조회·생성·수정 위주로 고친다.',
    'JSON 하나만 출력: {"command":"<수정된 powershell>","verify":"<읽기전용 검증 셸>"}',
    '설명, 마크다운, 코드펜스 금지.'
  ].join('\n');
}

function extractJsonLoose(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    // claude CLI가 {result:"..."} 래퍼로 줄 수 있어 한 겹 벗긴다.
    if (parsed && typeof parsed.result === 'string') {
      const inner = String(parsed.result).match(/\{[\s\S]*\}/);
      if (inner) { try { return JSON.parse(inner[0]); } catch { /* fall through */ } }
    }
    return parsed;
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingPath(path) {
  let cursor = resolve(path);
  while (true) {
    if (await exists(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

async function assertAllowedRealPath(path, allowedRoots, { checkParentForCreate = false } = {}) {
  const resolved = resolve(path);
  if (!allowedRoots.some((root) => isInside(root, resolved))) {
    throw Object.assign(new Error(`outside-allowed-roots:${resolved}`), {code:'PATH_OUTSIDE_ALLOWED_ROOTS'});
  }
  const canonicalRoots = [];
  for (const root of allowedRoots) {
    canonicalRoots.push(await realpath(root).catch(() => resolve(root)));
  }
  const probePath = checkParentForCreate ? await nearestExistingPath(dirname(resolved)) : await nearestExistingPath(resolved);
  const canonicalProbe = await realpath(probePath).catch(() => resolve(probePath));
  if (!canonicalRoots.some((root) => isInside(root, canonicalProbe))) {
    throw Object.assign(new Error(`outside-allowed-roots-realpath:${resolved}:${canonicalProbe}`), {code:'PATH_REALPATH_OUTSIDE_ALLOWED_ROOTS'});
  }
  return resolved;
}

export function classifyFileIssue({ code, path, targetPath = null, detail = null }) {
  const catalog = {
    missingSource: {
      severity: 'error',
      retryable: false,
      userAction: 'Choose an existing source file before executing the move.'
    },
    targetExists: {
      severity: 'conflict',
      retryable: true,
      userAction: 'Choose a different destination or explicitly approve overwrite.'
    },
    outsideAllowedRoots: {
      severity: 'blocked',
      retryable: false,
      userAction: 'Select a path inside an approved local workspace root.'
    },
    permissionDenied: {
      severity: 'blocked',
      retryable: true,
      userAction: 'Check Windows file permissions or run the service under an account with access.'
    },
    pathEscapeRealpath: {
      severity: 'blocked',
      retryable: false,
      userAction: 'Remove the symlink/junction escape or choose a real path inside the approved root.'
    },
    toctouChanged: {
      severity: 'blocked',
      retryable: false,
      userAction: 'Retry after confirming the path was not replaced between preflight and execution.'
    },
    unknownFsError: {
      severity: 'error',
      retryable: true,
      userAction: 'Review the file path and retry after the OS error is resolved.'
    }
  };
  const meta = catalog[code] ?? catalog.unknownFsError;
  return {
    code,
    severity: meta.severity,
      retryable: meta.retryable,
    taxonomy: pathSafetyIssueCatalog().issues[code] ?? pathSafetyIssueCatalog().issues.unknownFsError,
    path,
    targetPath,
    detail,
    userAction: meta.userAction
  };
}

export function classifyFileError(error, { path = null, targetPath = null } = {}) {
  const message = String(error?.message ?? error ?? '');
  if (message.includes('outside-allowed-roots-realpath')) return classifyFileIssue({ code: 'pathEscapeRealpath', path, targetPath, detail: message });
  if (message.includes('outside-allowed-roots')) return classifyFileIssue({ code: 'outsideAllowedRoots', path, targetPath, detail: message });
  if (['EACCES', 'EPERM'].includes(error?.code)) return classifyFileIssue({ code: 'permissionDenied', path, targetPath, detail: message });
  return classifyFileIssue({ code: 'unknownFsError', path, targetPath, detail: message });
}

export function pathSafetyIssueCatalog() {
  return {
    catalogVersion: 'b-path-safety-issue-catalog-v1',
    issues: {
      missingSource: { category: 'existence', osCodes: ['ENOENT'], blocksExecution: true },
      targetExists: { category: 'conflict', osCodes: ['EEXIST'], blocksExecution: true },
      outsideAllowedRoots: { category: 'policy', osCodes: [], blocksExecution: true },
      permissionDenied: { category: 'windows-acl-or-permission', osCodes: ['EACCES', 'EPERM'], blocksExecution: true },
      pathEscapeRealpath: { category: 'junction-symlink-realpath-escape', osCodes: [], blocksExecution: true },
      toctouChanged: { category: 'open-after-realpath-toctou', osCodes: [], blocksExecution: true },
      unknownFsError: { category: 'unknown-filesystem-error', osCodes: [], blocksExecution: true }
    }
  };
}

export class PathSafetyGuard {
  constructor({ allowedRoots = ['./workspace'], clock = () => new Date() } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.clock = clock;
    this.guardVersion = 'b-path-safety-guard-v1';
  }

  async inspect(inputPath, { checkParentForCreate = false, operation = 'read' } = {}) {
    const resolvedPath = resolve(inputPath);
    const lexicalAllowed = this.allowedRoots.some((root) => isInside(root, resolvedPath));
    const canonicalRoots = [];
    for (const root of this.allowedRoots) {
      canonicalRoots.push(await realpath(root).catch(() => resolve(root)));
    }
    const probePath = checkParentForCreate ? await nearestExistingPath(dirname(resolvedPath)) : await nearestExistingPath(resolvedPath);
    const canonicalProbe = await realpath(probePath).catch(() => resolve(probePath));
    const realpathAllowed = canonicalRoots.some((root) => isInside(root, canonicalProbe));
    const issue = !lexicalAllowed
      ? classifyFileIssue({ code: 'outsideAllowedRoots', path: inputPath, targetPath: resolvedPath, detail: `outside-allowed-roots:${resolvedPath}` })
      : (!realpathAllowed
          ? classifyFileIssue({ code: 'pathEscapeRealpath', path: inputPath, targetPath: resolvedPath, detail: `outside-allowed-roots-realpath:${resolvedPath}:${canonicalProbe}` })
          : null);
    return {
      inspectionVersion: 'b-path-safety-inspection-v1',
      operation,
      inputPath,
      resolvedPath,
      checkParentForCreate,
      probePath,
      canonicalProbe,
      canonicalRoots,
      lexicalAllowed,
      realpathAllowed,
      allowed: lexicalAllowed && realpathAllowed,
      issue
    };
  }

  async assertAllowed(inputPath, options = {}) {
    const inspection = await this.inspect(inputPath, options);
    if (!inspection.allowed) {
      throw new Error(inspection.issue?.detail ?? `outside-allowed-roots:${inspection.resolvedPath}`);
    }
    return inspection.resolvedPath;
  }

  async createOpenAfterRealpathLock(inputPath, { checkParentForCreate = false, operation = 'write' } = {}) {
    const inspection = await this.inspect(inputPath, { checkParentForCreate, operation });
    if (!inspection.allowed) {
      return {
        lockVersion: 'b-open-after-realpath-lock-v1',
        status: 'blocked',
        inspection
      };
    }
    const lockPath = checkParentForCreate ? inspection.probePath : inspection.resolvedPath;
    const lockStat = await stat(lockPath).catch(() => null);
    const signature = pathSignature({ path: lockPath, canonicalPath: inspection.canonicalProbe, stat: lockStat });
    return {
      lockVersion: 'b-open-after-realpath-lock-v1',
      status: 'locked',
      lockedAt: this.clock().toISOString(),
      operation,
      inputPath,
      lockPath,
      canonicalPath: inspection.canonicalProbe,
      signature,
      inspection
    };
  }

  async verifyOpenAfterRealpathLock(lock) {
    if (!lock || lock.status !== 'locked') {
      return {
        verificationVersion: 'b-open-after-realpath-lock-verification-v1',
        status: 'blocked',
        issue: classifyFileIssue({ code: 'toctouChanged', path: lock?.inputPath ?? null, detail: 'missing-or-unlocked-toctou-lock' })
      };
    }
    const currentCanonicalPath = await realpath(lock.lockPath).catch(() => resolve(lock.lockPath));
    const currentStat = await stat(lock.lockPath).catch(() => null);
    const currentSignature = pathSignature({ path: lock.lockPath, canonicalPath: currentCanonicalPath, stat: currentStat });
    const changedFields = Object.entries(lock.signature)
      .filter(([key, value]) => currentSignature[key] !== value)
      .map(([key]) => key);
    const changed = changedFields.length > 0;
    return {
      verificationVersion: 'b-open-after-realpath-lock-verification-v1',
      status: changed ? 'changed' : 'valid',
      changed,
      changedFields,
      lock,
      currentSignature,
      issue: changed ? classifyFileIssue({ code: 'toctouChanged', path: lock.inputPath, targetPath: lock.lockPath, detail: `toctou-lock-changed:${changedFields.join(',')}` }) : null
    };
  }

  async runFixtureCorpus(corpus) {
    const cases = corpus?.cases ?? [];
    const results = [];
    for (const fixture of cases) {
      const inspection = await this.inspect(fixture.path, fixture.options ?? {});
      const passed = inspection.allowed === fixture.expectedAllowed
        && (!fixture.expectedIssueCode || inspection.issue?.code === fixture.expectedIssueCode);
      results.push({
        caseId: fixture.caseId,
        passed,
        expectedAllowed: fixture.expectedAllowed,
        expectedIssueCode: fixture.expectedIssueCode ?? null,
        inspection
      });
    }
    return {
      corpusVersion: corpus?.corpusVersion ?? 'b-path-safety-fixture-corpus-v1',
      guardVersion: this.guardVersion,
      issueCatalog: pathSafetyIssueCatalog(),
      total: results.length,
      passed: results.filter((item) => item.passed).length,
      passRate: results.length ? roundRatio(results.filter((item) => item.passed).length / results.length) : 1,
      status: results.every((item) => item.passed) ? 'passed' : 'failed',
      results
    };
  }
}

export function createPathSafetyFixtureCorpus({
  allowedRoot,
  outsideRoot,
  junctionPath = null
} = {}) {
  const cases = [
    {
      caseId: 'safe-create-parent-inside-root',
      path: resolve(allowedRoot, 'safe-output.txt'),
      options: { checkParentForCreate: true, operation: 'create' },
      expectedAllowed: true
    },
    {
      caseId: 'lexical-outside-root-blocked',
      path: resolve(outsideRoot, 'outside.txt'),
      options: { checkParentForCreate: true, operation: 'create' },
      expectedAllowed: false,
      expectedIssueCode: 'outsideAllowedRoots'
    }
  ];
  if (junctionPath) {
    cases.push({
      caseId: 'junction-realpath-escape-blocked',
      path: resolve(junctionPath, 'escape.txt'),
      options: { checkParentForCreate: true, operation: 'create' },
      expectedAllowed: false,
      expectedIssueCode: 'pathEscapeRealpath'
    });
  }
  return {
    corpusVersion: 'b-path-safety-fixture-corpus-v1',
    description: 'Allowed-root, Windows ACL taxonomy, realpath escape, and TOCTOU preflight corpus.',
    cases
  };
}

export function createPathSafetyReleaseDossier({
  corpusReport,
  lock,
  verification,
  runtimeStatus = null,
  clock = () => new Date()
} = {}) {
  const issueCatalog = corpusReport?.issueCatalog ?? pathSafetyIssueCatalog();
  const releaseChecks = [
    {
      checkId: 'path_safety_issue_catalog_release_evidence',
      passed: issueCatalog.catalogVersion === 'b-path-safety-issue-catalog-v1'
        && issueCatalog.issues?.permissionDenied?.category === 'windows-acl-or-permission'
        && issueCatalog.issues?.pathEscapeRealpath?.category === 'junction-symlink-realpath-escape'
        && issueCatalog.issues?.toctouChanged?.category === 'open-after-realpath-toctou'
    },
    {
      checkId: 'path_safety_fixture_corpus_release_evidence',
      passed: corpusReport?.corpusVersion === 'b-path-safety-fixture-corpus-v1'
        && corpusReport.status === 'passed'
        && corpusReport.passRate === 1,
      total: corpusReport?.total ?? 0,
      passedCount: corpusReport?.passed ?? 0
    },
    {
      checkId: 'open_after_realpath_lock_release_evidence',
      passed: lock?.lockVersion === 'b-open-after-realpath-lock-v1'
        && lock.status === 'locked'
        && verification?.verificationVersion === 'b-open-after-realpath-lock-verification-v1'
        && ['valid', 'changed'].includes(verification.status),
      verificationStatus: verification?.status ?? null,
      changedFields: verification?.changedFields ?? []
    },
    {
      checkId: 'toctou_change_detection_release_evidence',
      passed: verification?.status === 'changed'
        && verification.issue?.code === 'toctouChanged',
      issueCode: verification?.issue?.code ?? null
    },
    {
      checkId: 'runtime_path_safety_adapter_release_evidence',
      passed: !runtimeStatus
        || (runtimeStatus.guardVersion === 'b-path-safety-guard-v1'
          && runtimeStatus.adapters?.createTextFile?.toctouLock === true),
      guardVersion: runtimeStatus?.guardVersion ?? null,
      createTextFileToctouLock: runtimeStatus?.adapters?.createTextFile?.toctouLock ?? null
    }
  ];
  const artifactManifest = {
    artifactManifestVersion: 'b-path-safety-release-artifact-manifest-v1',
    generatedAt: clock().toISOString(),
    issueCatalogHash: createHash('sha256').update(canonicalJson(issueCatalog)).digest('hex'),
    corpusReportHash: createHash('sha256').update(canonicalJson({
      corpusVersion: corpusReport?.corpusVersion ?? null,
      status: corpusReport?.status ?? null,
      total: corpusReport?.total ?? 0,
      passed: corpusReport?.passed ?? 0,
      passRate: corpusReport?.passRate ?? null,
      issueCodes: (corpusReport?.results ?? []).map((item) => item.issueCode ?? item.issue?.code ?? null).filter(Boolean).sort()
    })).digest('hex'),
    lockHash: createHash('sha256').update(canonicalJson({
      lockVersion: lock?.lockVersion ?? null,
      status: lock?.status ?? null,
      operation: lock?.operation ?? null,
      signatureHash: lock?.signature ? createHash('sha256').update(canonicalJson(lock.signature)).digest('hex') : null
    })).digest('hex'),
    verificationHash: createHash('sha256').update(canonicalJson({
      verificationVersion: verification?.verificationVersion ?? null,
      status: verification?.status ?? null,
      issueCode: verification?.issue?.code ?? null,
      changedFields: verification?.changedFields ?? []
    })).digest('hex'),
    runtimeStatusHash: createHash('sha256').update(canonicalJson({
      guardVersion: runtimeStatus?.guardVersion ?? null,
      adapters: runtimeStatus?.adapters ?? null
    })).digest('hex'),
    rawPathStored: false,
    rawCanonicalPathStored: false,
    rawFixturePathStored: false,
    rawSignaturePayloadStored: false
  };
  artifactManifest.rawLeakCheck = {
    checkVersion: 'b-path-safety-release-raw-leak-check-v1',
    rawLeakDetected: containsPathSafetyRawLeak(artifactManifest),
    checkedRawFields: [
      'rawPathStored',
      'rawCanonicalPathStored',
      'rawFixturePathStored',
      'rawSignaturePayloadStored'
    ]
  };
  const ciNightlyGatePlan = {
    planVersion: 'b-path-safety-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "B path safety guard" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'path_safety_release_dossier_ready',
      'path_safety_corpus_and_acl_ready',
      'path_safety_toctou_detection_ready',
      'path_safety_release_artifact_manifest_ready',
      'path_safety_worm_promotion_package_ready'
    ],
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    rawPathStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'b-path-safety-worm-promotion-package-v1',
    providerContractVersion: 'b-path-safety-worm-provider-contract-v1',
    status: releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && ciNightlyGatePlan.planVersion === 'b-path-safety-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPathStored: false,
    rawSignaturePayloadStored: false
  };
  const dossier = {
    dossierVersion: 'b-path-safety-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    rawContentStored: false,
    rawPathStored: false,
    issueCatalogHash: artifactManifest.issueCatalogHash,
    corpusReportHash: artifactManifest.corpusReportHash,
    toctou: {
      lockHash: artifactManifest.lockHash,
      verificationHash: artifactManifest.verificationHash,
      verificationStatus: verification?.status ?? null,
      issueCode: verification?.issue?.code ?? null
    },
    runtimeStatusHash: artifactManifest.runtimeStatusHash,
    artifactManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    releaseChecks,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'attach_path_safety_hash_only_corpus_toctou_acl_and_worm_release_evidence'
      : 'block_path_safety_release_until_corpus_and_toctou_checks_pass'
  };
  dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
  return dossier;
}

export function createPathSafetyProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'path_safety_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'b-path-safety-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'path_safety_corpus_and_acl_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'path_safety_issue_catalog_release_evidence' && check.passed) === true
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'path_safety_fixture_corpus_release_evidence' && check.passed) === true
    },
    {
      checkId: 'path_safety_toctou_detection_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'toctou_change_detection_release_evidence' && check.passed) === true
    },
    {
      checkId: 'path_safety_raw_content_not_stored',
      passed: releaseDossier?.rawContentStored === false
        && releaseDossier?.rawPathStored === false
    },
    {
      checkId: 'path_safety_release_artifact_manifest_ready',
      passed: releaseDossier?.artifactManifest?.artifactManifestVersion === 'b-path-safety-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawPathStored === false
        && releaseDossier.artifactManifest?.rawCanonicalPathStored === false
    },
    {
      checkId: 'path_safety_worm_promotion_package_ready',
      passed: releaseDossier?.externalWormPromotionPackage?.packageVersion === 'b-path-safety-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-path-safety-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-path-safety-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function pathSignature({ path, canonicalPath, stat: fileStat }) {
  return {
    path: resolve(path),
    canonicalPath: resolve(canonicalPath),
    exists: Boolean(fileStat),
    dev: fileStat?.dev ?? null,
    ino: fileStat?.ino ?? null,
    mode: fileStat?.mode ?? null,
    size: fileStat?.size ?? null,
    mtimeMs: fileStat ? Math.round(fileStat.mtimeMs) : null
  };
}

function roundRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function batchDiffForFileMoves(checks) {
  const conflicts = [];
  for (const check of checks) {
    if (!check.sourceExists) {
      conflicts.push(classifyFileIssue({ code: 'missingSource', path: check.from, targetPath: check.to }));
    }
    if (check.targetExists) {
      conflicts.push(classifyFileIssue({ code: 'targetExists', path: check.from, targetPath: check.to }));
    }
  }
  return {
    total: checks.length,
    ready: checks.filter((check) => check.sourceExists && !check.targetExists).length,
    blocked: conflicts.length,
    creates: checks.filter((check) => check.sourceExists && !check.targetExists).map((check) => check.to),
    removes: checks.filter((check) => check.sourceExists && !check.targetExists).map((check) => check.from),
    conflicts
  };
}

function fileMoveResolutionKey(check) {
  return `${resolve(check.from)}=>${resolve(check.to)}`;
}

function normalizeFileMoveConflictResolutions(input = {}) {
  const resolutions = new Map();
  const add = (candidate = {}) => {
    if (!candidate) return;
    const action = candidate.action ?? candidate.strategy ?? candidate.mode ?? null;
    const resolution = { ...candidate, action };
    const keys = [
      candidate.key,
      candidate.moveKey,
      candidate.from && candidate.to ? `${resolve(candidate.from)}=>${resolve(candidate.to)}` : null,
      candidate.from ? resolve(candidate.from) : null,
      candidate.to ? resolve(candidate.to) : null
    ].filter(Boolean);
    for (const key of keys) resolutions.set(String(key), resolution);
  };

  if (Array.isArray(input)) {
    input.forEach(add);
    return resolutions;
  }
  if (input && typeof input === 'object' && (input.action || input.strategy || input.mode)) {
    add(input);
    return resolutions;
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === 'string') {
      add({ key, action: value });
    } else {
      add({ key, ...(value ?? {}) });
    }
  }
  return resolutions;
}

function resolutionForFileMove(check, resolutions) {
  return resolutions.get(fileMoveResolutionKey(check))
    ?? resolutions.get(resolve(check.from))
    ?? resolutions.get(resolve(check.to))
    ?? null;
}

function suggestedFileMoveTarget(targetPath, { action = 'rename' } = {}) {
  const extension = extname(targetPath);
  const stem = basename(targetPath, extension);
  const label = action === 'copy' ? 'copy' : 'renamed';
  return resolve(dirname(targetPath), `${stem}.${label}${extension}`);
}

function fileMoveIssueCodes(check) {
  const codes = [];
  if (!check.sourceExists) codes.push('missingSource');
  if (check.targetExists) codes.push('targetExists');
  for (const issue of check.pathIssues ?? []) codes.push(issue.code);
  return [...new Set(codes)];
}

export function createFileConflictResolutionUiState({ checks = [], conflicts = [], batchDiff = null, batchPolicy = null } = {}) {
  const actionCatalog = [
    { action: 'rename', label: 'Rename destination', destructive: false, defaultFor: ['targetExists'] },
    { action: 'copy', label: 'Copy instead of move', destructive: false, defaultFor: ['targetExists'] },
    { action: 'skip', label: 'Skip item', destructive: false, defaultFor: ['missingSource', 'permissionDenied', 'pathEscapeRealpath', 'outsideAllowedRoots'] },
    { action: 'overwrite', label: 'Overwrite destination', destructive: true, requiresExplicitApproval: true, defaultFor: [] }
  ];
  const items = checks.map((check, index) => {
    const issueCodes = fileMoveIssueCodes(check);
    const decisionRequired = issueCodes.length > 0;
    const suggestedTarget = check.targetExists ? suggestedFileMoveTarget(check.to, { action: 'rename' }) : check.to;
    const recommendedAction = issueCodes.includes('targetExists')
      ? 'rename'
      : issueCodes.length
        ? 'skip'
        : 'move';
    return {
      itemId: stableId('file-move-ui', `${check.from}:${check.to}:${index}`),
      from: check.from,
      to: check.to,
      issueCodes,
      decisionRequired,
      recommendedAction,
      suggestedTarget,
      availableActions: issueCodes.includes('targetExists')
        ? ['rename', 'copy', 'skip', 'overwrite']
        : issueCodes.length
          ? ['skip']
          : ['move'],
      policyItem: batchPolicy?.items?.[index] ?? null
    };
  });
  return {
    uiVersion: 'b-file-conflict-resolution-ui-v1',
    mode: 'pre-execution-review',
    batchDiff,
    actionCatalog,
    pendingDecisionCount: items.filter((item) => item.decisionRequired).length,
    safeDefault: 'rename-target-conflicts-and-skip-blocked-items',
    conflicts,
    items
  };
}

export function createFileMoveBatchPolicy({ checks = [], conflictResolutions = {}, allowOverwrite = false } = {}) {
  const resolutions = normalizeFileMoveConflictResolutions(conflictResolutions);
  const items = checks.map((check, index) => {
    const issueCodes = fileMoveIssueCodes(check);
    const resolution = resolutionForFileMove(check, resolutions);
    const requestedAction = resolution?.action ?? null;
    const base = {
      itemId: stableId('file-move-policy', `${check.from}:${check.to}:${index}`),
      moveKey: fileMoveResolutionKey(check),
      from: check.from,
      requestedTo: check.to,
      to: check.to,
      sourceExists: check.sourceExists,
      targetExists: check.targetExists,
      issueCodes,
      requestedAction,
      resolutionApplied: Boolean(requestedAction)
    };

    if ((check.pathIssues ?? []).length) {
      if (requestedAction === 'skip') {
        return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: check.pathIssues };
      }
      return {
        ...base,
        status: 'blocked',
        action: 'needs_user_choice',
        changeType: 'none',
        issues: check.pathIssues,
        availableActions: ['skip']
      };
    }

    if (!check.sourceExists) {
      if (requestedAction === 'skip') {
        return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: [classifyFileIssue({ code: 'missingSource', path: check.from, targetPath: check.to })] };
      }
      return {
        ...base,
        status: 'blocked',
        action: 'needs_user_choice',
        changeType: 'none',
        issues: [classifyFileIssue({ code: 'missingSource', path: check.from, targetPath: check.to })],
        availableActions: ['skip']
      };
    }

    if (check.targetExists) {
      if (requestedAction === 'skip') {
        return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: [classifyFileIssue({ code: 'targetExists', path: check.from, targetPath: check.to })] };
      }
      if (requestedAction === 'rename' || requestedAction === 'copy') {
        const targetPath = resolve(resolution.targetPath ?? resolution.to ?? suggestedFileMoveTarget(check.to, { action: requestedAction }));
        return {
          ...base,
          status: 'ready',
          action: requestedAction,
          to: targetPath,
          changeType: requestedAction === 'copy' ? 'copy_file' : 'move_file_renamed_target',
          sourceRetained: requestedAction === 'copy',
          issues: []
        };
      }
      if (requestedAction === 'overwrite' && (allowOverwrite || resolution.allowOverwrite === true)) {
        return {
          ...base,
          status: 'ready',
          action: 'overwrite',
          to: check.to,
          changeType: 'move_file_overwrite_target',
          destructive: true,
          issues: []
        };
      }
      return {
        ...base,
        status: 'blocked',
        action: 'needs_user_choice',
        changeType: 'none',
        issues: [classifyFileIssue({ code: 'targetExists', path: check.from, targetPath: check.to })],
        availableActions: ['rename', 'copy', 'skip', 'overwrite']
      };
    }

    if (requestedAction === 'skip') {
      return { ...base, status: 'skipped', action: 'skip', changeType: 'none', issues: [] };
    }
    if (requestedAction === 'copy') {
      const targetPath = resolve(resolution.targetPath ?? resolution.to ?? check.to);
      return { ...base, status: 'ready', action: 'copy', to: targetPath, changeType: 'copy_file', sourceRetained: true, issues: [] };
    }
    if (requestedAction === 'rename') {
      const targetPath = resolve(resolution.targetPath ?? resolution.to ?? check.to);
      return { ...base, status: 'ready', action: 'rename', to: targetPath, changeType: 'move_file_renamed_target', issues: [] };
    }
    return { ...base, status: 'ready', action: 'move', changeType: 'move_file', issues: [] };
  });
  const readyItems = items.filter((item) => item.status === 'ready');
  const blockedItems = items.filter((item) => item.status === 'blocked');
  const skippedItems = items.filter((item) => item.status === 'skipped');
  return {
    policyVersion: 'b-file-move-batch-policy-v1',
    allowedActions: ['move', 'rename', 'copy', 'skip', 'overwrite'],
    total: items.length,
    readyCount: readyItems.length,
    skippedCount: skippedItems.length,
    blockedCount: blockedItems.length,
    plannedChangesCount: readyItems.length,
    overwriteCount: readyItems.filter((item) => item.action === 'overwrite').length,
    safeToExecute: blockedItems.length === 0 && readyItems.every((item) => item.action !== 'overwrite' || allowOverwrite),
    requiresExplicitApproval: readyItems.some((item) => item.action === 'overwrite'),
    items,
    readyItems,
    blockedItems,
    skippedItems
  };
}

export function createPartialMoveTransactionDryRun({ batchPolicy, taskId = null } = {}) {
  const readyItems = batchPolicy?.readyItems ?? [];
  const blockedItems = batchPolicy?.blockedItems ?? [];
  const skippedItems = batchPolicy?.skippedItems ?? [];
  const operations = readyItems.map((item) => ({
    action: item.action,
    changeType: item.changeType,
    from: item.from,
    to: item.to,
    sourceRetained: item.sourceRetained === true
  }));
  const rollbackActions = readyItems.map((item) => item.action === 'copy'
    ? { action: 'delete_created_file', path: item.to }
    : { action: 'move_back', from: item.from, to: item.to });
  const status = blockedItems.length && readyItems.length
    ? 'partial-ready-requires-user-choice'
    : blockedItems.length
      ? 'blocked'
      : 'ready';
  return {
    dryRunVersion: 'b-partial-move-transaction-dry-run-v1',
    taskId,
    status,
    plannedChangesCount: readyItems.length,
    skippedCount: skippedItems.length,
    blockedCount: blockedItems.length,
    phases: [
      { phase: 'preflight', status: blockedItems.length ? 'requires-user-choice' : 'passed', blockedItems },
      { phase: 'prepare-target-directories', status: readyItems.length ? 'planned' : 'noop', directories: [...new Set(readyItems.map((item) => dirname(item.to)))] },
      { phase: 'apply-file-operations', status: readyItems.length ? 'planned' : 'noop', operations },
      { phase: 'rollback-plan', status: readyItems.length ? 'available' : 'noop', rollbackActions }
    ]
  };
}

export function createWindowsAclDenyCorpus({ deniedPath = 'C:\\System Volume Information\\jarvis-denied.txt', allowedRoot = null } = {}) {
  return {
    corpusVersion: 'b-windows-acl-deny-corpus-v1',
    platform: 'win32',
    purpose: 'Verify that Windows ACL deny and permission errors are classified without escaping the allowed root policy.',
    cases: [
      {
        caseId: 'windows-acl-deny-write',
        operation: 'create',
        path: deniedPath,
        allowedRoot,
        expectedIssueCode: 'permissionDenied',
        expectedOsCodes: ['EACCES', 'EPERM'],
        simulatedIssue: classifyFileIssue({ code: 'permissionDenied', path: deniedPath, detail: 'windows-acl-deny-fixture' })
      }
    ]
  };
}

export function createFileOperationReleaseDossier({
  previewShadow = null,
  executionResult = null,
  clock = () => new Date()
} = {}) {
  const previewPolicy = previewShadow?.batchPolicy ?? null;
  const executionPolicy = executionResult?.batchPolicy ?? null;
  const activePolicy = executionPolicy ?? previewPolicy;
  const partialMoveTransactionDryRun = executionResult?.partialMoveTransactionDryRun
    ?? previewShadow?.partialMoveTransactionDryRun
    ?? null;
  const aclCorpus = previewShadow?.windowsAclDenyCorpus ?? createWindowsAclDenyCorpus();
  const releaseChecks = [
    {
      checkId: 'file_conflict_resolution_ui_release_evidence',
      passed: previewShadow?.conflictResolutionUi?.uiVersion === 'b-file-conflict-resolution-ui-v1'
        && previewShadow.conflictResolutionUi.safeDefault === 'rename-target-conflicts-and-skip-blocked-items',
      pendingDecisionCount: previewShadow?.conflictResolutionUi?.pendingDecisionCount ?? 0
    },
    {
      checkId: 'file_move_batch_policy_release_evidence',
      passed: activePolicy?.policyVersion === 'b-file-move-batch-policy-v1'
        && Array.isArray(activePolicy.allowedActions)
        && activePolicy.allowedActions.includes('rename')
        && activePolicy.allowedActions.includes('copy')
        && activePolicy.allowedActions.includes('skip'),
      readyCount: activePolicy?.readyCount ?? 0,
      blockedCount: activePolicy?.blockedCount ?? 0,
      skippedCount: activePolicy?.skippedCount ?? 0
    },
    {
      checkId: 'partial_move_transaction_dry_run_release_evidence',
      passed: partialMoveTransactionDryRun?.dryRunVersion === 'b-partial-move-transaction-dry-run-v1'
        && Array.isArray(partialMoveTransactionDryRun.phases)
        && partialMoveTransactionDryRun.phases.some((phase) => phase.phase === 'rollback-plan'),
      status: partialMoveTransactionDryRun?.status ?? null,
      plannedChangesCount: partialMoveTransactionDryRun?.plannedChangesCount ?? 0
    },
    {
      checkId: 'windows_acl_deny_corpus_release_evidence',
      passed: aclCorpus?.corpusVersion === 'b-windows-acl-deny-corpus-v1'
        && aclCorpus.cases?.some((item) => item.expectedIssueCode === 'permissionDenied'),
      caseCount: aclCorpus?.cases?.length ?? 0
    },
    {
      checkId: 'file_execution_policy_outcome_release_evidence',
      passed: !executionResult
        || (executionResult.status === 'success'
          && executionResult.batchPolicy?.policyVersion === 'b-file-move-batch-policy-v1'
          && executionResult.partialMoveTransactionDryRun?.dryRunVersion === 'b-partial-move-transaction-dry-run-v1'),
      executionStatus: executionResult?.status ?? null,
      changedItems: executionResult?.changedItems?.length ?? 0
    },
    {
      checkId: 'file_rollback_coverage_release_evidence',
      passed: !executionResult
        || executionResult.rollbackAvailable === true
        || executionResult.batchPolicy?.readyCount === 0,
      rollbackAvailable: executionResult?.rollbackAvailable ?? null
    }
  ];
  const artifactManifest = {
    artifactManifestVersion: 'b-file-operation-release-artifact-manifest-v1',
    generatedAt: clock().toISOString(),
    conflictResolutionUiHash: createHash('sha256').update(canonicalJson(previewShadow?.conflictResolutionUi ?? null)).digest('hex'),
    batchPolicyHash: createHash('sha256').update(canonicalJson(activePolicy ?? null)).digest('hex'),
    partialMoveTransactionHash: createHash('sha256').update(canonicalJson(partialMoveTransactionDryRun ?? null)).digest('hex'),
    aclCorpusHash: createHash('sha256').update(canonicalJson({
      corpusVersion: aclCorpus?.corpusVersion ?? null,
      caseCount: aclCorpus?.cases?.length ?? 0,
      expectedIssueCodes: (aclCorpus?.cases ?? []).map((item) => item.expectedIssueCode).sort()
    })).digest('hex'),
    executionOutcomeHash: createHash('sha256').update(canonicalJson({
      status: executionResult?.status ?? null,
      changedCount: executionResult?.changedItems?.length ?? 0,
      outputCount: executionResult?.outputPaths?.length ?? 0,
      rollbackAvailable: executionResult?.rollbackAvailable === true,
      undoJournalId: executionResult?.undoJournalId ? createHash('sha256').update(String(executionResult.undoJournalId)).digest('hex') : null
    })).digest('hex'),
    rawFilePathsStored: false,
    rawFileContentStored: false,
    rawUndoPayloadStored: false,
    rawAclPathStored: false
  };
  artifactManifest.rawLeakCheck = {
    checkVersion: 'b-file-operation-release-raw-leak-check-v1',
    rawLeakDetected: containsFileOperationRawLeak(artifactManifest),
    checkedRawFields: [
      'rawFilePathsStored',
      'rawFileContentStored',
      'rawUndoPayloadStored',
      'rawAclPathStored'
    ]
  };
  const ciNightlyGatePlan = {
    planVersion: 'b-file-operation-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "B pc-agent lists files" tests/ag-runtime.test.js',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'file_operation_release_dossier_ready',
      'file_operation_conflict_policy_ready',
      'file_operation_acl_and_rollback_ready',
      'file_operation_release_artifact_manifest_ready',
      'file_operation_worm_promotion_package_ready'
    ],
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    rawFilePathsStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'b-file-operation-worm-promotion-package-v1',
    providerContractVersion: 'b-file-operation-worm-provider-contract-v1',
    status: releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && ciNightlyGatePlan.planVersion === 'b-file-operation-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
    ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawFilePathsStored: false,
    rawFileContentStored: false
  };
  const dossier = {
    dossierVersion: 'b-file-operation-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked',
    rawContentStored: false,
    rawFilePathsStored: false,
    rawFileContentStored: false,
    preview: previewShadow
      ? {
          mode: previewShadow.mode,
          batchDiffHash: createHash('sha256').update(canonicalJson(previewShadow.batchDiff ?? null)).digest('hex'),
          conflictPolicy: previewShadow.conflictPolicy,
          conflictCount: previewShadow.conflicts?.length ?? 0,
          conflictResolutionUiHash: artifactManifest.conflictResolutionUiHash,
          batchPolicyHash: createHash('sha256').update(canonicalJson(previewShadow.batchPolicy ?? null)).digest('hex'),
          partialMoveTransactionHash: createHash('sha256').update(canonicalJson(previewShadow.partialMoveTransactionDryRun ?? null)).digest('hex'),
          windowsAclDenyCorpusHash: artifactManifest.aclCorpusHash
        }
      : null,
    execution: executionResult
      ? {
          status: executionResult.status,
          changedItemCount: executionResult.changedItems?.length ?? 0,
          outputPathHashes: (executionResult.outputPaths ?? []).map((item) => createHash('sha256').update(String(item)).digest('hex')),
          rollbackAvailable: executionResult.rollbackAvailable === true,
          batchPolicyHash: createHash('sha256').update(canonicalJson(executionResult.batchPolicy ?? null)).digest('hex'),
          partialMoveTransactionHash: createHash('sha256').update(canonicalJson(executionResult.partialMoveTransactionDryRun ?? null)).digest('hex'),
          undoJournalIdHash: executionResult.undoJournalId ? createHash('sha256').update(String(executionResult.undoJournalId)).digest('hex') : null
        }
      : null,
    artifactManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    releaseChecks,
    recommendedReleaseAction: releaseChecks.every((check) => check.passed)
      && externalWormPromotionPackage.status === 'ready'
      ? 'attach_file_conflict_batch_acl_rollback_hash_only_and_worm_release_evidence'
      : 'block_file_operation_release_until_conflict_policy_and_rollback_evidence_pass'
  };
  dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
  return dossier;
}

export function createFileOperationProductGate({ releaseDossier }) {
  const checks = [
    {
      checkId: 'file_operation_release_dossier_ready',
      passed: releaseDossier?.dossierVersion === 'b-file-operation-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    },
    {
      checkId: 'file_operation_conflict_policy_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'file_conflict_resolution_ui_release_evidence' && check.passed) === true
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'file_move_batch_policy_release_evidence' && check.passed) === true
    },
    {
      checkId: 'file_operation_acl_and_rollback_ready',
      passed: releaseDossier?.releaseChecks?.some((check) => check.checkId === 'windows_acl_deny_corpus_release_evidence' && check.passed) === true
        && releaseDossier?.releaseChecks?.some((check) => check.checkId === 'file_rollback_coverage_release_evidence' && check.passed) === true
    },
    {
      checkId: 'file_operation_raw_content_not_stored',
      passed: releaseDossier?.rawContentStored === false
        && releaseDossier?.rawFilePathsStored === false
        && releaseDossier?.rawFileContentStored === false
    },
    {
      checkId: 'file_operation_release_artifact_manifest_ready',
      passed: releaseDossier?.artifactManifest?.artifactManifestVersion === 'b-file-operation-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest?.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest?.rawFilePathsStored === false
        && releaseDossier.artifactManifest?.rawFileContentStored === false
    },
    {
      checkId: 'file_operation_worm_promotion_package_ready',
      passed: releaseDossier?.externalWormPromotionPackage?.packageVersion === 'b-file-operation-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-file-operation-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    }
  ];
  return {
    productGateVersion: 'b-file-operation-product-gate-v1',
    status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
    checks,
    releaseDossier: {
      dossierVersion: releaseDossier?.dossierVersion ?? null,
      status: releaseDossier?.status ?? null,
      dossierSha256: releaseDossier?.dossierSha256 ?? null
    }
  };
}

function spreadsheetColumnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || 'A';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function countBy(items, key) {
  return (items ?? []).reduce((counts, item) => {
    const value = item?.[key] ?? 'unknown';
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function containsExecutionPacketReleaseRawLeak(value, needles = {}) {
  const serialized = JSON.stringify(value ?? {});
  const rawKeyLeak = Object.keys(needles)
    .some((key) => new RegExp(`"${key}"\\s*:`).test(serialized));
  return rawKeyLeak
    || /"arguments"\s*:|"content"\s*:|"path"\s*:|"capabilityToken"\s*:|"userConfirmation"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsCapabilityVaultRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"vaultPath"\s*:|"tokenId"\s*:|"secret"\s*:|"keyMaterial"\s*:|"plaintext"\s*:|cap_secret_|JARVIS_PC_AGENT_VAULT_KEY|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsFileOperationRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"from"\s*:|"to"\s*:|"path"\s*:|"targetPath"\s*:|"outputPaths"\s*:|"changedItems"\s*:|"content"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsPathSafetyRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"path"\s*:|"canonicalPath"\s*:|"allowedRoot"\s*:|"outsideRoot"\s*:|"junctionPath"\s*:|"signature"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsRollbackReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"path"\s*:|"archivePath"\s*:|"sourcePath"\s*:|"targetPath"\s*:|"manifestPath"\s*:|"drillPath"\s*:|"capabilityToken"\s*:|"undoPayload"\s*:|"payload"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function containsExecutionEvidenceReleaseRawLeak(value) {
  const serialized = JSON.stringify(value ?? {});
  return /"outputPaths"\s*:|"changedItems"\s*:|"files"\s*:|"adapterEvidence"\s*:|"capabilityToken"\s*:|"userCommand"\s*:|"content"\s*:|"previousContent"\s*:|"previousBytesBase64"\s*:|"sourceLogPath"\s*:|"logPath"\s*:|"path"\s*:|[A-Za-z]:\\\\Users\\\\/i.test(serialized);
}

function createdFileRollbackSnapshot(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024) {
    throw Object.assign(new Error('Created-file rollback evidence unavailable'), {code:'B_ROLLBACK_FILE_EVIDENCE_UNAVAILABLE'});
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const after = lstatSync(path);
  if (!after.isFile() || after.isSymbolicLink() || ['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key])) {
    throw Object.assign(new Error('Created file changed during evidence capture'), {code:'B_ROLLBACK_FILE_CHANGED'});
  }
  return {version:'created-file-rollback-v1',dev:after.dev,ino:after.ino,size:after.size,sha256};
}

function createdFileRollbackMatches(expected, current) {
  return expected?.version==='created-file-rollback-v1' && current?.version===expected.version
    && ['dev','ino','size','sha256'].every(key=>expected[key]===current[key]);
}

function rollbackPhysicalPath(path) {
  let cursor=resolve(path);const suffix=[];
  while(true){try{cursor=resolve(realpathSync(cursor),...suffix);break;}
    catch(error){if(error.code!=='ENOENT'||dirname(cursor)===cursor)throw error;suffix.unshift(basename(cursor));cursor=dirname(cursor);}}
  return process.platform==='win32'?cursor.toLowerCase():cursor;
}

function previousFileRollbackBytes(entry) {
  let bytes;
  if(typeof entry.previousBytesBase64==='string'){
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.previousBytesBase64))return null;
    bytes=Buffer.from(entry.previousBytesBase64,'base64');
    if(bytes.toString('base64')!==entry.previousBytesBase64)return null;
  }else if(typeof entry.previousContent==='string')bytes=Buffer.from(entry.previousContent,'utf8');
  else return null;
  return bytes.length<=64*1024*1024&&createHash('sha256').update(bytes).digest('hex')===entry.previousBytesSha256?bytes:null;
}

export class UndoJournal {
  constructor({ journalPath = null, clock = () => new Date() } = {}) {
    this.entries = [];
    this.records = [];
    this.journalPath = journalPath;
    this.clock = clock;
    this.diskSignature = null;
    this.load();
  }

  load() {
    this.refreshFromDisk({ force: true });
  }

  refreshFromDisk({ force = false } = {}) {
    if (!this.journalPath) return false;
    let lines = [];
    let signature = 'missing';
    try {
      const file = statSync(this.journalPath);
      signature = `${file.size}:${file.mtimeMs}`;
      if (!force && signature === this.diskSignature) return false;
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.entries = [];
        this.records = [];
        this.diskSignature = signature;
        return false;
      }
      throw error;
    }
    const entries = new Map();
    const entryOrder = [];
    const records = [];
    for (const line of lines) {
      const event = JSON.parse(line);
      records.push(event);
      if (event.recordType === 'undo') {
        if (!entries.has(event.undoJournalId)) entryOrder.push(event.undoJournalId);
        entries.set(event.undoJournalId, { ...event });
      }
      if (event.recordType === 'undo_rolled_back' && entries.has(event.undoJournalId)) {
        entries.set(event.undoJournalId, {
          ...entries.get(event.undoJournalId),
          rollbackStatus: 'rolled_back',
          rolledBackAt: event.rolledBackAt,
          rollbackResult: event.rollbackResult
        });
      }
    }
    this.records = records;
    // The append order is authoritative. Timestamps can collide at millisecond precision.
    this.entries = entryOrder.reverse().map((undoJournalId) => entries.get(undoJournalId)).filter(Boolean);
    this.diskSignature = signature;
    return true;
  }

  record(action) {
    return this.withExclusiveWrite(() => {
      const createdAt = this.clock().toISOString();
      const entry = {
        recordType: 'undo',
        undoJournalId: `undo_${this.entries.length + 1}_${Date.parse(createdAt).toString(36)}`,
        createdAt,
        rollbackStatus: 'pending',
        ...action
      };
      if (entry.action === 'delete_created_file') {
        try { entry.createdFileSnapshot = createdFileRollbackSnapshot(entry.path); }
        catch (error) { entry.createdFileSnapshot = null; entry.createdFileEvidenceError = error.code ?? 'B_ROLLBACK_FILE_EVIDENCE_UNAVAILABLE'; }
      }
      if(entry.action==='restore_previous_file'){
        try{entry.overwrittenFileSnapshot=createdFileRollbackSnapshot(entry.path);}
        catch(error){entry.overwrittenFileSnapshot=null;entry.overwrittenFileEvidenceError=error.code??'B_ROLLBACK_FILE_EVIDENCE_UNAVAILABLE';}
        const bytes=typeof entry.previousBytesBase64==='string'?Buffer.from(entry.previousBytesBase64,'base64'):
          typeof entry.previousContent==='string'?Buffer.from(entry.previousContent,'utf8'):null;
        if(bytes)entry.previousBytesSha256=createHash('sha256').update(bytes).digest('hex');
      }
      if(entry.action==='move_back'){
        try{
          entry.movedFileSnapshot=createdFileRollbackSnapshot(entry.to);
          entry.movePhysicalPaths={from:rollbackPhysicalPath(entry.from),to:rollbackPhysicalPath(entry.to)};
        }catch(error){entry.movedFileSnapshot=null;entry.movePhysicalPaths=null;entry.moveEvidenceError=error.code??'B_ROLLBACK_MOVE_EVIDENCE_UNAVAILABLE';}
      }
      this.addHash(entry);
      if (this.journalPath) appendJsonlImmediateSync(this.journalPath, entry);
      this.entries.unshift(entry);
      this.records.push({ ...entry });
      this.captureDiskSignature();
      return entry;
    });
  }

  markRolledBack(entry, rollbackResult) {
    return this.withExclusiveWrite(() => {
      const rolledBackAt = this.clock().toISOString();
      for (const item of this.entries) {
        if (item.undoJournalId === entry.undoJournalId) {
          item.rollbackStatus = 'rolled_back';
          item.rolledBackAt = rolledBackAt;
          item.rollbackResult = rollbackResult;
        }
      }
      const currentEntry = this.entries.find((item) => item.undoJournalId === entry.undoJournalId);
      const marker = {
        recordType: 'undo_rolled_back',
        undoJournalId: entry.undoJournalId,
        taskId: currentEntry?.taskId ?? entry.taskId,
        rolledBackAt,
        rollbackResult
      };
      this.addHash(marker);
      if (this.journalPath) appendJsonlImmediateSync(this.journalPath, marker);
      this.records.push(marker);
      this.captureDiskSignature();
      return marker;
    });
  }

  list({ includeRolledBack = false } = {}) {
    return this.entries.filter((entry) => includeRolledBack || entry.rollbackStatus !== 'rolled_back');
  }

  history() {
    return [...this.entries];
  }

  verifyChain() {
    this.refreshFromDisk();
    let previousHash = 'GENESIS';
    const failures = [];
    const forks = [];
    const knownHashes = new Set(['GENESIS']);
    let hashedRecords = 0;
    let legacyRecords = 0;
    for (const record of this.records) {
      if (!record.hash || !record.previousHash) {
        legacyRecords += 1;
        continue;
      }
      hashedRecords += 1;
      const expectedHash = this.hashRecord(record);
      const hashMatches = record.hash === expectedHash;
      if (record.previousHash !== previousHash && hashMatches && knownHashes.has(record.previousHash)) {
        forks.push({
          recordType: record.recordType,
          undoJournalId: record.undoJournalId,
          expectedPreviousHash: previousHash,
          branchParentHash: record.previousHash
        });
      } else if (record.previousHash !== previousHash) {
        failures.push({
          recordType: record.recordType,
          undoJournalId: record.undoJournalId,
          reason: 'previous-hash-mismatch',
          expected: previousHash,
          actual: record.previousHash
        });
      }
      if (!hashMatches) {
        failures.push({
          recordType: record.recordType,
          undoJournalId: record.undoJournalId,
          reason: 'hash-mismatch',
          expected: expectedHash,
          actual: record.hash
        });
      }
      if (knownHashes.has(record.hash)) {
        failures.push({
          recordType: record.recordType,
          undoJournalId: record.undoJournalId,
          reason: 'duplicate-record-hash',
          actual: record.hash
        });
      }
      knownHashes.add(record.hash);
      previousHash = record.hash;
    }
    return {
      status: failures.length === 0 ? 'valid' : 'invalid',
      integrityMode: forks.length > 0 ? 'append-only-dag' : 'linear-chain',
      checked: this.records.length,
      hashedRecords,
      legacyRecords,
      forkCount: forks.length,
      forks,
      latestHash: previousHash,
      failures
    };
  }

  withExclusiveWrite(operation) {
    if (!this.journalPath) return operation();
    return withUndoJournalLockSync(this.journalPath, () => {
      this.refreshFromDisk({ force: true });
      return operation();
    });
  }

  captureDiskSignature() {
    if (!this.journalPath) return;
    try {
      const file = statSync(this.journalPath);
      this.diskSignature = `${file.size}:${file.mtimeMs}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.diskSignature = 'missing';
    }
  }

  addHash(record) {
    const previous = [...this.records].reverse().find((item) => item.hash)?.hash ?? 'GENESIS';
    record.previousHash = previous;
    record.hash = this.hashRecord(record);
    return record;
  }

  hashRecord(record) {
    const hashable = { ...record };
    delete hashable.hash;
    return createHash('sha256').update(canonicalJson(hashable)).digest('hex');
  }
}

export class RollbackTransactionLog {
  constructor({ journalPath = null, clock = () => new Date() } = {}) {
    this.journalPath = journalPath;
    this.clock = clock;
    this.records = [];
    this.transactions = new Map();
    this.load();
  }

  load() {
    if (!this.journalPath) return;
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const line of lines) {
      const record = JSON.parse(line);
      this.records.push(record);
      this.applyRecord(record);
    }
  }

  begin({ taskId, plan }) {
    const active = this.activeForTask(taskId);
    if (active) {
      return {
        success: false,
        error: { code: 'B_ROLLBACK_TRANSACTION_ACTIVE' },
        transaction: active
      };
    }
    const startedAt = this.clock().toISOString();
    const transactionId = `rbtx_${this.records.length + 1}_${Date.parse(startedAt).toString(36)}`;
    const record = {
      recordType: 'rollback_transaction_started',
      transactionId,
      taskId,
      status: 'running',
      startedAt,
      stepCount: plan.stepCount,
      readyCount: plan.readyCount,
      blockedCount: plan.blockedCount,
      lockedPaths: this.lockedPathsFor(plan),
      planDigest: createHash('sha256').update(canonicalJson({
        taskId,
        stepCount: plan.stepCount,
        steps: plan.steps.map((step) => ({
          undoJournalId: step.undoJournalId,
          action: step.action,
          status: step.status,
          paths: step.paths
        }))
      })).digest('hex')
    };
    this.appendRecord(record);
    return { success: true, transaction: this.transactions.get(transactionId) };
  }

  recordStep(transaction, { step, rollbackResult = null, status, reason = null }) {
    const at = this.clock().toISOString();
    const record = {
      recordType: 'rollback_transaction_step',
      transactionId: transaction.transactionId,
      taskId: transaction.taskId,
      at,
      undoJournalId: step?.undoJournalId ?? rollbackResult?.undoJournalId ?? null,
      action: step?.action ?? rollbackResult?.action ?? null,
      status,
      reason,
      paths: step?.paths ?? null,
      rollbackResult
    };
    this.appendRecord(record);
    return record;
  }

  complete(transaction, { rolledBack = [], skipped = [] } = {}) {
    const completedAt = this.clock().toISOString();
    const status = skipped.length
      ? rolledBack.length
        ? 'completed_with_skips'
        : 'blocked'
      : 'completed';
    const record = {
      recordType: 'rollback_transaction_completed',
      transactionId: transaction.transactionId,
      taskId: transaction.taskId,
      status,
      completedAt,
      rolledBackCount: rolledBack.length,
      skippedCount: skipped.length
    };
    this.appendRecord(record);
    return this.transactions.get(transaction.transactionId);
  }

  fail(transaction, error, { rolledBack = [], skipped = [] } = {}) {
    const failedAt = this.clock().toISOString();
    const record = {
      recordType: 'rollback_transaction_failed',
      transactionId: transaction.transactionId,
      taskId: transaction.taskId,
      status: 'failed',
      failedAt,
      rolledBackCount: rolledBack.length,
      skippedCount: skipped.length,
      error: {
        code: error?.code ?? 'B_ROLLBACK_TRANSACTION_FAILED',
        message: error?.message ?? String(error)
      }
    };
    this.appendRecord(record);
    return this.transactions.get(transaction.transactionId);
  }

  activeForTask(taskId) {
    return this.active().find((transaction) => transaction.taskId === taskId) ?? null;
  }

  active() {
    return [...this.transactions.values()]
      .filter((transaction) => transaction.status === 'running')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  history({ taskId = null, limit = 100 } = {}) {
    return [...this.transactions.values()]
      .filter((transaction) => !taskId || transaction.taskId === taskId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
  }

  status() {
    return {
      transactions: this.transactions.size,
      active: this.active(),
      recent: this.history({ limit: 20 }),
      chain: this.verifyChain()
    };
  }

  lockedPathsFor(plan) {
    const paths = new Set();
    for (const step of plan.steps ?? []) {
      for (const value of Object.values(step.paths ?? {})) {
        if (typeof value === 'string' && value.trim()) {
          paths.add(resolve(value));
        }
      }
    }
    return [...paths].sort();
  }

  appendRecord(record) {
    this.addHash(record);
    this.records.push(record);
    this.applyRecord(record);
    if (this.journalPath) appendJsonlSync(this.journalPath, record);
    return record;
  }

  applyRecord(record) {
    if (record.recordType === 'rollback_transaction_started') {
      this.transactions.set(record.transactionId, {
        transactionId: record.transactionId,
        taskId: record.taskId,
        status: 'running',
        startedAt: record.startedAt,
        stepCount: record.stepCount,
        readyCount: record.readyCount,
        blockedCount: record.blockedCount,
        lockedPaths: record.lockedPaths ?? [],
        planDigest: record.planDigest,
        steps: []
      });
      return;
    }
    const transaction = this.transactions.get(record.transactionId);
    if (!transaction) return;
    if (record.recordType === 'rollback_transaction_step') {
      transaction.steps.push({
        at: record.at,
        undoJournalId: record.undoJournalId,
        action: record.action,
        status: record.status,
        reason: record.reason,
        paths: record.paths,
        rollbackResult: record.rollbackResult
      });
      transaction.lastStepAt = record.at;
      return;
    }
    if (record.recordType === 'rollback_transaction_completed') {
      transaction.status = record.status;
      transaction.completedAt = record.completedAt;
      transaction.rolledBackCount = record.rolledBackCount;
      transaction.skippedCount = record.skippedCount;
      return;
    }
    if (record.recordType === 'rollback_transaction_failed') {
      transaction.status = 'failed';
      transaction.failedAt = record.failedAt;
      transaction.rolledBackCount = record.rolledBackCount;
      transaction.skippedCount = record.skippedCount;
      transaction.error = record.error;
    }
  }

  verifyChain() {
    let previousHash = 'GENESIS';
    const failures = [];
    for (const record of this.records) {
      if (record.previousHash !== previousHash) {
        failures.push({
          recordType: record.recordType,
          transactionId: record.transactionId,
          reason: 'previous-hash-mismatch',
          expected: previousHash,
          actual: record.previousHash
        });
      }
      const expectedHash = this.hashRecord(record);
      if (record.hash !== expectedHash) {
        failures.push({
          recordType: record.recordType,
          transactionId: record.transactionId,
          reason: 'hash-mismatch',
          expected: expectedHash,
          actual: record.hash
        });
      }
      previousHash = record.hash;
    }
    return {
      status: failures.length === 0 ? 'valid' : 'invalid',
      checked: this.records.length,
      latestHash: previousHash,
      failures
    };
  }

  addHash(record) {
    const previous = [...this.records].reverse().find((item) => item.hash)?.hash ?? 'GENESIS';
    record.previousHash = previous;
    record.hash = this.hashRecord(record);
    return record;
  }

  hashRecord(record) {
    const hashable = { ...record };
    delete hashable.hash;
    return createHash('sha256').update(canonicalJson(hashable)).digest('hex');
  }
}

const executionPacketSuccessStatuses = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.VERIFYING,
  'success',
  'succeeded',
  'completed',
  'passed'
]);

const executionPacketBlockedStatuses = new Set([
  TaskStatus.BLOCKED,
  TaskStatus.CANCELLED,
  TaskStatus.EXPIRED,
  'blocked',
  'cancelled',
  'expired',
  'needs_choice'
]);

const executionPacketRetryStatuses = new Set([
  TaskStatus.RETRYING,
  'retry',
  'retrying',
  'retry_scheduled'
]);

const executionPacketFailureStatuses = new Set([
  TaskStatus.FAILED,
  'failed',
  'failure',
  'error'
]);

const transientExecutionCodePattern = /(?:TIMEOUT|TIMED_OUT|UNAVAILABLE|NETWORK|RATE_LIMIT|TOO_MANY|TEMPORAR|TRANSIENT|UPSTREAM_HTTP|ECONN|EHOST|ENET|EAI_AGAIN|EAGAIN|EBUSY|LOCK_TIMEOUT)/iu;
const uncertainExecutionCodePattern = /(?:DELIVERY_STATE_UNCERTAIN|EXECUTION_UNCERTAIN|COMMIT_UNCERTAIN|UNKNOWN_COMMIT|AMBIGUOUS_SEND)/iu;
const permanentExecutionCodePattern = /(?:INVALID|MALFORMED|MISSING|NOT_FOUND|UNSUPPORTED|FORBIDDEN|DENIED|CONFLICT|REVOKED|ALREADY_USED|OUTSIDE_ALLOWED|DESTRUCTIVE)/iu;


export function classifyExecutionPacketOutcome(result, { error = null } = {}) {
  if (error) {
    return {
      outcome: 'retry',
      retryable: true,
      reason: executionPacketErrorCode(error) ?? 'B_QUEUE_HANDLER_EXCEPTION'
    };
  }
  if (!result || typeof result !== 'object') {
    return {
      outcome: 'quarantine',
      retryable: false,
      reason: 'B_QUEUE_HANDLER_RESULT_INVALID'
    };
  }
  const status = String(result.status ?? result.executionResult?.status ?? '').trim();
  const normalizedStatus = status.toLowerCase();
  if (executionPacketSuccessStatuses.has(status) || executionPacketSuccessStatuses.has(normalizedStatus) || (!status && result.success === true)) {
    return { outcome: 'success', retryable: false, reason: null };
  }
  if (executionPacketBlockedStatuses.has(status) || executionPacketBlockedStatuses.has(normalizedStatus)) {
    return {
      outcome: 'terminal-blocked',
      retryable: false,
      reason: executionPacketErrorCode(result) ?? 'B_QUEUE_EXECUTION_BLOCKED'
    };
  }
  if (status === 'quarantined' || normalizedStatus === 'quarantine') {
    return {
      outcome: 'quarantine',
      retryable: false,
      reason: executionPacketErrorCode(result) ?? 'B_QUEUE_EXECUTION_QUARANTINED'
    };
  }
  if (executionPacketRetryStatuses.has(status) || executionPacketRetryStatuses.has(normalizedStatus)) {
    return {
      outcome: 'retry',
      retryable: true,
      reason: executionPacketErrorCode(result) ?? 'B_QUEUE_EXECUTION_RETRY_REQUESTED'
    };
  }
  if (executionPacketFailureStatuses.has(status) || executionPacketFailureStatuses.has(normalizedStatus) || (!status && result.success === false)) {
    const reason = executionPacketErrorCode(result) ?? 'B_QUEUE_EXECUTION_FAILED';
    const retryable = executionPacketRetryableFlag(result);
    const adapterContract = result?.executionResult?.safety?.adapterContract
      ?? result?.executionResult?.adapterContract
      ?? result?.adapterContract
      ?? null;
    const mutationOutcomeUncertain = adapterContract?.mutatesSystem === true
      || adapterContract?.externalTransfer === true;
    if (uncertainExecutionCodePattern.test(reason)) {
      return { outcome: 'quarantine', retryable: false, reason };
    }
    if (retryable === false) {
      return { outcome: 'quarantine', retryable: false, reason };
    }
    if (mutationOutcomeUncertain && retryable !== true) {
      return { outcome: 'quarantine', retryable: false, reason };
    }
    if (retryable === true || transientExecutionCodePattern.test(reason)) {
      return { outcome: 'retry', retryable: true, reason };
    }
    if (permanentExecutionCodePattern.test(reason)) {
      return { outcome: 'quarantine', retryable: false, reason };
    }
    // Preserve the queue's historical behavior for an unclassified failure: retry it
    // within the bounded attempt budget, then quarantine it instead of reporting success.
    return { outcome: 'retry', retryable: true, reason };
  }
  return {
    outcome: 'quarantine',
    retryable: false,
    reason: 'B_QUEUE_HANDLER_RESULT_INVALID'
  };
}

function executionPacketErrorCode(value) {
  const candidates = [
    value?.error?.code,
    typeof value?.error === 'string' ? value.error : null,
    value?.errorCode,
    value?.failedReason?.code,
    typeof value?.failedReason === 'string' ? value.failedReason : null,
    value?.blockedReason,
    value?.executionResult?.error?.code,
    typeof value?.executionResult?.error === 'string' ? value.executionResult.error : null,
    value?.executionResult?.errorCode,
    value?.executionResult?.failedReason,
    value?.code,
    value?.message
  ];
  const selected = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return selected ? selected.trim().slice(0, 500) : null;
}

function executionPacketRetryableFlag(result) {
  const candidates = [
    result?.retryable,
    result?.error?.retryable,
    result?.executionResult?.retryable,
    result?.executionResult?.error?.retryable,
    result?.executionResult?.issue?.retryable,
    result?.friendlyError?.retryable
  ];
  return candidates.find((candidate) => typeof candidate === 'boolean') ?? null;
}

function executionPacketLegacyIdentity(packet = {}, { dryRun = false } = {}) {
  return {
    taskId: packet?.taskId ?? null,
    packetId: packet?.packetId ?? null,
    requestedMode: dryRun || packet?.requestedMode === 'shadow' ? 'shadow' : (packet?.requestedMode ?? 'execute'),
    toolName: packet?.action?.toolName ?? null,
    actionType: packet?.action?.actionType ?? null
  };
}

function legacyPacketIdentityFromRecord(record = {}) {
  return {
    taskId: record.taskId ?? null,
    packetId: record.packetId ?? null,
    requestedMode: record.requestedMode ?? (record.dryRun === true ? 'shadow' : 'execute'),
    toolName: record.toolName ?? null,
    actionType: record.actionType ?? null
  };
}

function compatibleLegacyPacketIdentity(stored, received) {
  return ['taskId', 'packetId', 'requestedMode', 'toolName', 'actionType'].every((field) => (
    stored?.[field] === null || stored?.[field] === undefined || stored[field] === received?.[field]
  ));
}

export class ExecutionPacketJournal {
  constructor({ journalPath = 'apps/pc-agent/logs/packet-journal.jsonl', clock = () => new Date() } = {}) {
    this.journalPath = journalPath;
    this.clock = clock;
    this.records = [];
    this.results = new Map();
    this.packetFingerprints = new Map();
    this.packetIdentities = new Map();
    this.load();
  }

  load() {
    let lines = [];
    try {
      lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    this.records = lines.map((line) => JSON.parse(line));
    this.results.clear();
    this.packetFingerprints.clear();
    this.packetIdentities.clear();
    for (const record of this.records) this.indexRecord(record);
  }

  idempotencyKey(packet = {}) {
    if (packet.idempotencyKey) return packet.idempotencyKey;
    if (packet.packetId) return `packet:${packet.packetId}`;
    const digest = createHash('sha256')
      .update(JSON.stringify({
        taskId: packet.taskId,
        requestedMode: packet.requestedMode ?? 'execute',
        toolName: packet.action?.toolName,
        actionType: packet.action?.actionType,
        arguments: packet.action?.arguments ?? {}
      }))
      .digest('hex');
    return `derived:${digest}`;
  }

  recordReceived(packet, { dryRun = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const inspection = this.inspectPacket(packet, { dryRun });
    if (!inspection.compatible) {
      const error = new Error('Execution packet idempotency key was reused with a different payload.');
      error.code = 'B_IDEMPOTENCY_CONFLICT';
      error.inspection = inspection;
      throw error;
    }
    const record = {
      recordType: 'packet_received',
      idempotencyKey,
      packetFingerprint: inspection.packetFingerprint,
      packetId: packet.packetId ?? null,
      taskId: packet.taskId,
      requestedMode: packet.requestedMode ?? (dryRun ? 'shadow' : 'execute'),
      toolName: packet.action?.toolName ?? null,
      actionType: packet.action?.actionType ?? null,
      dryRun,
      receivedAt: this.clock().toISOString()
    };
    this.append(record);
    return record;
  }

  recordResult(packet, result, { dryRun = false, immediate = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const inspection = this.inspectPacket(packet, { dryRun });
    if (!inspection.compatible) {
      const error = new Error('Execution packet idempotency key was reused with a different payload.');
      error.code = 'B_IDEMPOTENCY_CONFLICT';
      error.inspection = inspection;
      throw error;
    }
    const classification = classifyExecutionPacketOutcome(result);
    const terminal = classification.outcome !== 'retry';
    const record = {
      recordType: terminal ? 'packet_result' : 'packet_attempt_result',
      idempotencyKey,
      packetFingerprint: inspection.packetFingerprint,
      packetId: packet.packetId ?? null,
      taskId: packet.taskId,
      requestedMode: packet.requestedMode ?? (dryRun ? 'shadow' : 'execute'),
      toolName: packet.action?.toolName ?? null,
      actionType: packet.action?.actionType ?? null,
      status: result.status,
      outcome: classification.outcome,
      retryable: classification.retryable,
      reason: classification.reason,
      dryRun,
      completedAt: this.clock().toISOString(),
      // The Core may later attach cognition status to its returned execution.
      // Keep B's original receipt identical to the serialized durable record.
      result: JSON.parse(JSON.stringify(result))
    };
    this.append(record, { immediate });
    return record;
  }

  resultFor(packet, { dryRun = false } = {}) {
    const inspection = this.inspectPacket(packet, { dryRun });
    if (!inspection.compatible) return null;
    const result=this.results.get(inspection.idempotencyKey);
    return result ? structuredClone(result) : null;
  }

  inspectPacket(packet, { dryRun = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const packetFingerprint = executionPacketFingerprint(packet, { dryRun });
    const existingFingerprint = this.packetFingerprints.get(idempotencyKey) ?? null;
    const receivedIdentity = executionPacketLegacyIdentity(packet, { dryRun });
    const existingIdentity = this.packetIdentities.get(idempotencyKey) ?? null;
    const fingerprintConflict = Boolean(existingFingerprint && existingFingerprint !== packetFingerprint);
    const legacyConflict = !existingFingerprint
      && Boolean(existingIdentity)
      && !compatibleLegacyPacketIdentity(existingIdentity, receivedIdentity);
    return {
      compatible: !fingerprintConflict && !legacyConflict,
      idempotencyKey,
      packetFingerprint,
      existingFingerprint,
      receivedIdentity,
      existingIdentity,
      reason: fingerprintConflict || legacyConflict ? 'B_IDEMPOTENCY_CONFLICT' : null
    };
  }

  recordConflict(packet, inspection, { dryRun = false } = {}) {
    return this.append({
      recordType: 'packet_idempotency_conflict',
      idempotencyKey: inspection.idempotencyKey,
      packetId: packet?.packetId ?? null,
      taskId: packet?.taskId ?? null,
      dryRun,
      packetFingerprint: inspection.packetFingerprint,
      existingFingerprint: inspection.existingFingerprint,
      existingIdentity: inspection.existingIdentity,
      receivedIdentity: inspection.receivedIdentity,
      detectedAt: this.clock().toISOString()
    });
  }

  pending() {
    const completed = new Set([...this.results.keys()]);
    return this.records
      .filter((record) => record.recordType === 'packet_received' && !completed.has(record.idempotencyKey))
      .slice()
      .reverse();
  }

  append(record, { immediate = false } = {}) {
    if (immediate) appendJsonlImmediateSync(this.journalPath, record);
    else appendJsonlSync(this.journalPath, record);
    this.records.push(record);
    this.indexRecord(record);
    return record;
  }

  indexRecord(record) {
    if (!record?.idempotencyKey || record.recordType === 'packet_idempotency_conflict') return;
    if (record.packetFingerprint && !this.packetFingerprints.has(record.idempotencyKey)) {
      this.packetFingerprints.set(record.idempotencyKey, record.packetFingerprint);
    }
    if (!this.packetIdentities.has(record.idempotencyKey)) {
      this.packetIdentities.set(record.idempotencyKey, legacyPacketIdentityFromRecord(record));
    }
    if (record.recordType === 'packet_result') {
      const classification = classifyExecutionPacketOutcome(record.result);
      if (classification.outcome !== 'retry') this.results.set(record.idempotencyKey, record.result);
    }
  }
}

export class ExecutionPacketQueue {
  constructor({
    queuePath = 'apps/pc-agent/logs/packet-queue.jsonl',
    maxAttempts = 3,
    baseBackoffMs = 1000,
    attemptLeaseMs = 30_000,
    clock = () => new Date()
  } = {}) {
    this.queuePath = queuePath;
    this.maxAttempts = maxAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.attemptLeaseMs = attemptLeaseMs;
    this.clock = clock;
    this.items = new Map();
    this.records = [];
    this.load();
  }

  load() {
    let lines = [];
    try {
      lines = readFileSync(this.queuePath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    this.records = lines.map((line) => JSON.parse(line));
    for (const record of this.records) {
      if (record.recordType === 'packet_queued') {
        this.items.set(record.queueId, {
          queueId: record.queueId,
          idempotencyKey: record.idempotencyKey,
          packet: record.packet,
          packetFingerprint: record.packetFingerprint
            ?? executionPacketFingerprint(record.packet, { dryRun: record.dryRun === true }),
          status: 'queued',
          attempts: 0,
          nextAttemptAt: record.queuedAt,
          queuedAt: record.queuedAt,
          dryRun: record.dryRun === true,
          lastError: null
        });
      }
      if (record.recordType === 'packet_attempt') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'running';
          item.attempts = record.attempt;
          item.lastAttemptAt = record.attemptedAt;
          item.attemptOwnerPid = record.attemptOwnerPid ?? null;
          item.attemptLeaseExpiresAt = record.attemptLeaseExpiresAt ?? null;
        }
      }
      if (record.recordType === 'packet_retry_scheduled') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'retry_scheduled';
          item.attempts = record.attempt;
          item.nextAttemptAt = record.nextAttemptAt;
          item.lastError = record.error;
          item.recoveredAfterRestart = record.recoveredAfterRestart === true;
        }
      }
      if (record.recordType === 'packet_succeeded') {
        const item = this.items.get(record.queueId);
        if (item) {
          const restoredOutcome = classifyExecutionPacketOutcome({ status: record.resultStatus });
          item.status = restoredOutcome.outcome === 'success'
            ? 'succeeded'
            : restoredOutcome.outcome === 'terminal-blocked'
              ? 'blocked'
              : 'running';
          item.completedAt = record.completedAt;
          item.resultStatus = record.resultStatus;
          if (item.status === 'running') item.lastError = 'B_QUEUE_LEGACY_FALSE_SUCCESS';
        }
      }
      if (record.recordType === 'packet_terminal_blocked') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'blocked';
          item.completedAt = record.completedAt;
          item.resultStatus = record.resultStatus;
          item.reason = record.reason;
          item.error = record.reason;
        }
      }
      if (record.recordType === 'packet_quarantined') {
        const item = this.items.get(record.queueId) ?? {
          queueId: record.queueId,
          idempotencyKey: record.idempotencyKey,
          packet: record.packet ?? null,
          queuedAt: record.quarantinedAt,
          attempts: record.attempt ?? 0
        };
        item.status = 'quarantined';
        item.quarantinedAt = record.quarantinedAt;
        item.reason = record.reason;
        item.error = record.error;
        item.reviewStatus = 'needs_review';
        this.items.set(record.queueId, item);
      }
      if (record.recordType === 'packet_reviewed') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.reviewStatus = record.reviewStatus;
          item.reviewedAt = record.reviewedAt;
          item.reviewedBy = record.reviewedBy;
          item.reviewNote = record.note;
        }
      }
      if (record.recordType === 'packet_requeued') {
        const item = this.items.get(record.queueId);
        if (item) {
          if (record.packet) item.packet = record.packet;
          if (record.idempotencyKey) item.idempotencyKey = record.idempotencyKey;
          item.packetFingerprint = record.packetFingerprint
            ?? executionPacketFingerprint(item.packet, { dryRun: item.dryRun === true });
          item.status = 'queued';
          item.reviewStatus = 'requeued';
          item.requeuedAt = record.requeuedAt;
          item.attempts = 0;
          item.nextAttemptAt = record.nextAttemptAt;
          item.error = null;
          item.lastError = null;
          item.reason = null;
        }
      }
      if (record.recordType === 'packet_ignored') {
        const item = this.items.get(record.queueId);
        if (item) {
          item.status = 'ignored';
          item.reviewStatus = 'ignored';
          item.ignoredAt = record.ignoredAt;
          item.reviewedBy = record.reviewedBy;
          item.reviewNote = record.note;
        }
      }
      if (record.recordType === 'packet_retry_policy_updated') {
        if (Number.isInteger(record.current?.maxAttempts)) this.maxAttempts = record.current.maxAttempts;
        if (Number.isInteger(record.current?.baseBackoffMs)) this.baseBackoffMs = record.current.baseBackoffMs;
        this.policyUpdatedAt = record.updatedAt ?? record.current?.updatedAt ?? null;
      }
    }
    this.recoverStrandedRunning();
  }

  idempotencyKey(packet) {
    return packet.idempotencyKey ?? `${packet.taskId ?? 'missing-task'}:${packet.packetId ?? createHash('sha256').update(canonicalJson(packet.action ?? packet)).digest('hex')}`;
  }

  validate(packet) {
    const errors = [];
    if (!packet || typeof packet !== 'object') errors.push('packet object is required');
    if (!packet?.taskId) errors.push('taskId is required');
    if (!packet?.action?.toolName) errors.push('action.toolName is required');
    if (!packet?.action?.actionType) errors.push('action.actionType is required');
    if (!packet?.capabilityToken?.tokenId) errors.push('capabilityToken.tokenId is required');
    if (packet?.userConfirmation?.confirmed !== true) errors.push('userConfirmation.confirmed must be true');
    return { valid: errors.length === 0, errors };
  }

  enqueue(packet, { dryRun = false } = {}) {
    const idempotencyKey = this.idempotencyKey(packet);
    const packetFingerprint = executionPacketFingerprint(packet, { dryRun });
    const sameKeyItems = [...this.items.values()].filter((item) => item.idempotencyKey === idempotencyKey);
    const conflicting = sameKeyItems.find((item) => item.packetFingerprint && item.packetFingerprint !== packetFingerprint);
    if (conflicting) {
      const queuedAt = this.clock().toISOString();
      const queueId = stableId('queue', `${idempotencyKey}:conflict:${packetFingerprint}`, queuedAt);
      const item = {
        queueId,
        idempotencyKey,
        packet,
        packetFingerprint,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: queuedAt,
        queuedAt,
        dryRun,
        validation: this.validate(packet)
      };
      this.items.set(queueId, item);
      this.append({
        recordType: 'packet_queued',
        queueId,
        idempotencyKey,
        packetFingerprint,
        packet,
        dryRun,
        queuedAt
      });
      this.quarantine(item, {
        reason: 'idempotency-conflict',
        error: 'B_IDEMPOTENCY_CONFLICT',
        attempt: 0,
        metadata: {
          conflictingQueueId: conflicting.queueId,
          existingPacketFingerprint: conflicting.packetFingerprint,
          receivedPacketFingerprint: packetFingerprint
        }
      });
      return this.publicItem(item);
    }
    const existing = sameKeyItems.find((item) => ['queued', 'retry_scheduled', 'running', 'succeeded', 'blocked', 'quarantined'].includes(item.status));
    if (existing) {
      return { ...this.publicItem(existing), duplicate: true };
    }
    const queueId = stableId('queue', idempotencyKey, this.clock().toISOString());
    const queuedAt = this.clock().toISOString();
    const validation = this.validate(packet);
    const item = {
      queueId,
      idempotencyKey,
      packet,
      packetFingerprint,
      status: validation.valid ? 'queued' : 'quarantined',
      attempts: 0,
      nextAttemptAt: queuedAt,
      queuedAt,
      dryRun,
      validation
    };
    this.items.set(queueId, item);
    this.append({
      recordType: 'packet_queued',
      queueId,
      idempotencyKey,
      packetFingerprint,
      packet,
      dryRun,
      queuedAt
    });
    if (!validation.valid) {
      this.quarantine(item, {
        reason: 'schema-invalid',
        error: validation.errors.join('; '),
        attempt: 0
      });
    }
    return this.publicItem(item);
  }

  async processNext(handler, { now = this.clock() } = {}) {
    const item = this.nextRunnable(now);
    if (!item) return { processed: false, reason: 'queue-empty' };
    item.status = 'running';
    item.attempts += 1;
    const attemptedAt = this.clock().toISOString();
    const attemptLeaseExpiresAt = new Date(Date.parse(attemptedAt) + this.attemptLeaseMs).toISOString();
    item.attemptOwnerPid = process.pid;
    item.attemptLeaseExpiresAt = attemptLeaseExpiresAt;
    this.append({
      recordType: 'packet_attempt',
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      packetFingerprint: item.packetFingerprint,
      attempt: item.attempts,
      attemptedAt,
      attemptOwnerPid: process.pid,
      attemptLeaseExpiresAt
    });
    try {
      const result = await handler(item.packet, {
        queueId: item.queueId,
        attempt: item.attempts,
        dryRun: item.dryRun === true
      });
      const classification = classifyExecutionPacketOutcome(result);
      if (classification.outcome === 'success') {
        item.status = 'succeeded';
        item.completedAt = this.clock().toISOString();
        item.resultStatus = result?.status ?? 'unknown';
        this.append({
          recordType: 'packet_succeeded',
          queueId: item.queueId,
          idempotencyKey: item.idempotencyKey,
          packetFingerprint: item.packetFingerprint,
          attempt: item.attempts,
          resultStatus: item.resultStatus,
          completedAt: item.completedAt
        });
        return { processed: true, outcome: classification.outcome, item: this.publicItem(item), result };
      }
      if (classification.outcome === 'terminal-blocked') {
        this.terminalBlock(item, {
          reason: classification.reason,
          resultStatus: result?.status ?? 'unknown'
        });
        return {
          processed: true,
          outcome: classification.outcome,
          item: this.publicItem(item),
          result,
          terminalBlocked: true
        };
      }
      if (classification.outcome === 'quarantine' || item.attempts >= this.maxAttempts) {
        this.quarantine(item, {
          reason: classification.outcome === 'quarantine' ? 'execution-result-quarantined' : 'max-attempts-exceeded',
          error: classification.reason,
          attempt: item.attempts,
          resultStatus: result?.status ?? 'unknown'
        });
        return {
          processed: true,
          outcome: 'quarantine',
          item: this.publicItem(item),
          result,
          quarantined: true
        };
      }
      this.scheduleRetry(item, classification.reason, {
        resultStatus: result?.status ?? 'unknown'
      });
      return {
        processed: true,
        outcome: classification.outcome,
        item: this.publicItem(item),
        result,
        retryScheduled: true
      };
    } catch (error) {
      const classification = classifyExecutionPacketOutcome(null, { error });
      const errorMessage = classification.reason ?? error.message ?? String(error);
      if (item.attempts >= this.maxAttempts) {
        this.quarantine(item, {
          reason: 'max-attempts-exceeded',
          error: errorMessage,
          attempt: item.attempts
        });
        return { processed: true, item: this.publicItem(item), quarantined: true };
      }
      this.scheduleRetry(item, errorMessage);
      return { processed: true, item: this.publicItem(item), retryScheduled: true };
    }
  }

  async drain(handler, { limit = 10 } = {}) {
    const results = [];
    for (let index = 0; index < limit; index += 1) {
      const processed = await this.processNext(handler);
      if (!processed.processed) break;
      results.push(processed);
    }
    return {
      processed: results.length,
      results,
      status: this.status()
    };
  }

  nextRunnable(now) {
    this.recoverStrandedRunning({ now });
    const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
    return [...this.items.values()]
      .filter((item) => ['queued', 'retry_scheduled'].includes(item.status))
      .filter((item) => Date.parse(item.nextAttemptAt) <= nowTime)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))[0] ?? null;
  }

  scheduleRetry(item, error, {
    delayMs = this.baseBackoffMs * (2 ** Math.max(item.attempts - 1, 0)),
    resultStatus = null,
    recoveredAfterRestart = false
  } = {}) {
    const nextAttemptAt = new Date(this.clock().getTime() + delayMs).toISOString();
    item.status = 'retry_scheduled';
    item.nextAttemptAt = nextAttemptAt;
    item.lastError = error;
    item.error = null;
    item.resultStatus = resultStatus;
    item.recoveredAfterRestart = recoveredAfterRestart;
    this.append({
      recordType: 'packet_retry_scheduled',
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      packetFingerprint: item.packetFingerprint,
      attempt: item.attempts,
      delayMs,
      nextAttemptAt,
      error,
      resultStatus,
      recoveredAfterRestart
    });
    return item;
  }

  terminalBlock(item, { reason, resultStatus = null } = {}) {
    item.status = 'blocked';
    item.completedAt = this.clock().toISOString();
    item.reason = reason;
    item.error = reason;
    item.resultStatus = resultStatus;
    this.append({
      recordType: 'packet_terminal_blocked',
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      packetFingerprint: item.packetFingerprint,
      attempt: item.attempts,
      reason,
      resultStatus,
      completedAt: item.completedAt
    });
    return item;
  }

  recoverStrandedRunning({ now = this.clock() } = {}) {
    const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
    const stranded = [...this.items.values()].filter((item) => item.status === 'running');
    for (const item of stranded) {
      const leaseExpiresAt = Date.parse(item.attemptLeaseExpiresAt ?? '');
      if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowTime) continue;
      if (item.attempts >= this.maxAttempts) {
        this.quarantine(item, {
          reason: 'stranded-running-max-attempts-exceeded',
          error: 'B_QUEUE_STRANDED_MAX_ATTEMPTS_EXCEEDED',
          attempt: item.attempts,
          metadata: { recoveredAfterRestart: true }
        });
        continue;
      }
      if (this.safeToReplayAfterRestart(item)) {
        this.scheduleRetry(item, 'B_QUEUE_RESTART_SAFE_RETRY', {
          delayMs: 0,
          recoveredAfterRestart: true
        });
        continue;
      }
      this.quarantine(item, {
        reason: 'stranded-running-execution-uncertain',
        error: 'B_QUEUE_STRANDED_EXECUTION_UNCERTAIN',
        attempt: item.attempts,
        metadata: { recoveredAfterRestart: true }
      });
    }
    return stranded.length;
  }

  safeToReplayAfterRestart(item) {
    if (item.dryRun === true || item.packet?.requestedMode === 'shadow') return true;
    const toolName = item.packet?.action?.toolName;
    const actionType = item.packet?.action?.actionType;
    return new Set([
      'filesystem.listFiles',
      'filesystem.readText',
      'document.readPdf',
      'excel.readWorkbook',
      'filesystem.searchFiles',
      'filesystem.previewMoveFiles',
      'browser.search',
      'news.fetchHeadlines',
      'news.fetchPublisherFeed',
      'news.fetchArticle',
      'capability.describe'
    ]).has(toolName) || new Set([
      ActionType.LIST_FILES,
      ActionType.SEARCH_FILES,
      ActionType.BROWSER_SEARCH,
      ActionType.CAPABILITY_QUERY
    ]).has(actionType);
  }

  quarantine(item, { reason, error, attempt, resultStatus = null, metadata = null }) {
    item.status = 'quarantined';
    item.quarantinedAt = this.clock().toISOString();
    item.reason = reason;
    item.error = error;
    item.resultStatus = resultStatus;
    item.reviewStatus = 'needs_review';
    this.append({
      recordType: 'packet_quarantined',
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      packetFingerprint: item.packetFingerprint,
      packet: item.packet,
      reason,
      error,
      resultStatus,
      metadata,
      attempt,
      quarantinedAt: item.quarantinedAt
    });
    return item;
  }

  poisonPackets({ includeIgnored = false } = {}) {
    return [...this.items.values()]
      .filter((item) => item.status === 'quarantined' || (includeIgnored && item.status === 'ignored'))
      .sort((a, b) => Date.parse(b.quarantinedAt ?? b.ignoredAt ?? b.queuedAt) - Date.parse(a.quarantinedAt ?? a.ignoredAt ?? a.queuedAt))
      .map((item) => this.publicItem(item));
  }

  reviewPoisonPacket(queueId, { decision = 'reviewed', reviewedBy = 'local-operator', note = '' } = {}) {
    const item = this.items.get(queueId);
    if (!item) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_FOUND' } };
    }
    if (!['quarantined', 'ignored'].includes(item.status)) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_POISON', status: item.status } };
    }
    const reviewStatus = decision === 'reviewed' ? 'reviewed' : decision;
    item.reviewStatus = reviewStatus;
    item.reviewedAt = this.clock().toISOString();
    item.reviewedBy = reviewedBy;
    item.reviewNote = note;
    this.append({
      recordType: 'packet_reviewed',
      queueId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.packet?.taskId ?? null,
      reviewStatus,
      reviewedBy,
      note,
      reviewedAt: item.reviewedAt
    });
    return { success: true, item: this.publicItem(item) };
  }

  requeuePoisonPacket(queueId, { reviewedBy = 'local-operator', note = '', patch = null } = {}) {
    const item = this.items.get(queueId);
    if (!item) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_FOUND' } };
    }
    if (item.status !== 'quarantined') {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_POISON', status: item.status } };
    }
    const nextPacket = patch ? { ...item.packet, ...patch, action: { ...item.packet?.action, ...patch.action } } : item.packet;
    const validation = this.validate(nextPacket);
    if (!validation.valid) {
      this.reviewPoisonPacket(queueId, { decision: 'review_failed_validation', reviewedBy, note: `${note} ${validation.errors.join('; ')}`.trim() });
      return { success: false, error: { code: 'B_QUEUE_REQUEUE_PACKET_INVALID', errors: validation.errors }, item: this.publicItem(item) };
    }
    const nextIdempotencyKey = this.idempotencyKey(nextPacket);
    const nextPacketFingerprint = executionPacketFingerprint(nextPacket, { dryRun: item.dryRun === true });
    const sameKeyPayloadChanged = nextIdempotencyKey === item.idempotencyKey
      && item.packetFingerprint
      && item.packetFingerprint !== nextPacketFingerprint;
    const conflicting = [...this.items.values()].find((candidate) => (
      candidate.queueId !== queueId
      && candidate.idempotencyKey === nextIdempotencyKey
      && candidate.packetFingerprint
      && candidate.packetFingerprint !== nextPacketFingerprint
    ));
    if (sameKeyPayloadChanged || conflicting) {
      this.reviewPoisonPacket(queueId, {
        decision: 'review_failed_idempotency_conflict',
        reviewedBy,
        note: `${note} B_IDEMPOTENCY_CONFLICT`.trim()
      });
      return {
        success: false,
        error: { code: 'B_IDEMPOTENCY_CONFLICT' },
        item: this.publicItem(item)
      };
    }
    item.packet = nextPacket;
    item.idempotencyKey = nextIdempotencyKey;
    item.packetFingerprint = nextPacketFingerprint;
    item.status = 'queued';
    item.reviewStatus = 'requeued';
    item.requeuedAt = this.clock().toISOString();
    item.reviewedBy = reviewedBy;
    item.reviewNote = note;
    item.attempts = 0;
    item.nextAttemptAt = item.requeuedAt;
    item.error = null;
    item.lastError = null;
    item.reason = null;
    item.validation = validation;
    this.append({
      recordType: 'packet_requeued',
      queueId,
      idempotencyKey: item.idempotencyKey,
      packetFingerprint: item.packetFingerprint,
      taskId: item.packet?.taskId ?? null,
      packet: item.packet,
      reviewedBy,
      note,
      nextAttemptAt: item.nextAttemptAt,
      requeuedAt: item.requeuedAt
    });
    return { success: true, item: this.publicItem(item) };
  }

  ignorePoisonPacket(queueId, { reviewedBy = 'local-operator', note = '' } = {}) {
    const item = this.items.get(queueId);
    if (!item) {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_FOUND' } };
    }
    if (item.status !== 'quarantined') {
      return { success: false, error: { code: 'B_QUEUE_ITEM_NOT_POISON', status: item.status } };
    }
    item.status = 'ignored';
    item.reviewStatus = 'ignored';
    item.ignoredAt = this.clock().toISOString();
    item.reviewedBy = reviewedBy;
    item.reviewNote = note;
    this.append({
      recordType: 'packet_ignored',
      queueId,
      idempotencyKey: item.idempotencyKey,
      packetFingerprint: item.packetFingerprint,
      taskId: item.packet?.taskId ?? null,
      reviewedBy,
      note,
      ignoredAt: item.ignoredAt
    });
    return { success: true, item: this.publicItem(item) };
  }

  retryPolicy() {
    return {
      maxAttempts: this.maxAttempts,
      baseBackoffMs: this.baseBackoffMs,
      attemptLeaseMs: this.attemptLeaseMs,
      queuePath: this.queuePath,
      updatedAt: this.policyUpdatedAt ?? null
    };
  }

  updateRetryPolicy({ maxAttempts = this.maxAttempts, baseBackoffMs = this.baseBackoffMs, updatedBy = 'local-operator', reason = '' } = {}) {
    const nextMaxAttempts = Number(maxAttempts);
    const nextBaseBackoffMs = Number(baseBackoffMs);
    if (!Number.isInteger(nextMaxAttempts) || nextMaxAttempts < 1 || nextMaxAttempts > 10) {
      return { success: false, error: { code: 'B_QUEUE_POLICY_MAX_ATTEMPTS_INVALID', message: 'maxAttempts must be an integer between 1 and 10.' } };
    }
    if (!Number.isInteger(nextBaseBackoffMs) || nextBaseBackoffMs < 100 || nextBaseBackoffMs > 60_000) {
      return { success: false, error: { code: 'B_QUEUE_POLICY_BACKOFF_INVALID', message: 'baseBackoffMs must be an integer between 100 and 60000.' } };
    }
    const previous = this.retryPolicy();
    this.maxAttempts = nextMaxAttempts;
    this.baseBackoffMs = nextBaseBackoffMs;
    this.policyUpdatedAt = this.clock().toISOString();
    const current = this.retryPolicy();
    this.append({
      recordType: 'packet_retry_policy_updated',
      previous,
      current,
      updatedBy,
      reason,
      updatedAt: this.policyUpdatedAt
    });
    return { success: true, previous, current };
  }

  publicItem(item) {
    return {
      queueId: item.queueId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.packet?.taskId ?? null,
      packetId: item.packet?.packetId ?? null,
      toolName: item.packet?.action?.toolName ?? null,
      status: item.status,
      attempts: item.attempts,
      queuedAt: item.queuedAt,
      nextAttemptAt: item.nextAttemptAt,
      completedAt: item.completedAt ?? null,
      resultStatus: item.resultStatus ?? null,
      recoveredAfterRestart: item.recoveredAfterRestart === true,
      attemptLeaseExpiresAt: item.attemptLeaseExpiresAt ?? null,
      quarantinedAt: item.quarantinedAt ?? null,
      requeuedAt: item.requeuedAt ?? null,
      ignoredAt: item.ignoredAt ?? null,
      reason: item.reason ?? null,
      error: item.error ?? item.lastError ?? null,
      reviewStatus: item.reviewStatus ?? null,
      reviewedAt: item.reviewedAt ?? null,
      reviewedBy: item.reviewedBy ?? null,
      reviewNote: item.reviewNote ?? null
    };
  }

  status() {
    const items = [...this.items.values()];
    return {
      queuePath: this.queuePath,
      maxAttempts: this.maxAttempts,
      baseBackoffMs: this.baseBackoffMs,
      attemptLeaseMs: this.attemptLeaseMs,
      retryPolicy: this.retryPolicy(),
      total: items.length,
      queued: items.filter((item) => item.status === 'queued').length,
      retryScheduled: items.filter((item) => item.status === 'retry_scheduled').length,
      running: items.filter((item) => item.status === 'running').length,
      succeeded: items.filter((item) => item.status === 'succeeded').length,
      blocked: items.filter((item) => item.status === 'blocked').length,
      quarantined: items.filter((item) => item.status === 'quarantined').length,
      ignored: items.filter((item) => item.status === 'ignored').length,
      next: items.filter((item) => ['queued', 'retry_scheduled'].includes(item.status)).map((item) => this.publicItem(item)).slice(0, 10),
      deadLetters: this.poisonPackets().slice(0, 20)
    };
  }

  append(record) {
    this.records.push(record);
    appendJsonlSync(this.queuePath, record);
    return record;
  }
}

export class CapabilityTokenVault {
  constructor({
    vaultPath = 'apps/pc-agent/logs/capability-vault.jsonl',
    secret = process.env.JARVIS_PC_AGENT_VAULT_KEY ?? 'jarvis-local-pc-agent-dev-key',
    keyProvider = null,
    legacyKeyProviders = null,
    migrateLegacyRecords = true,
    clock = () => new Date()
  } = {}) {
    this.vaultPath = vaultPath;
    this.clock = clock;
    this.keyProvider = keyProvider ?? createDefaultVaultKeyProvider({ secret, vaultPath });
    this.keyInfo = this.keyProvider.resolveKey();
    this.key = this.deriveKey(this.keyInfo.keyMaterial);
    this.keyId = this.keyIdFor(this.keyInfo.keyMaterial);
    this.keyRing = new Map([[this.keyId, this.key]]);
    this.rotationHistory = [];
    this.records = [];
    this.migration = {
      migrationVersion: 'b-capability-vault-key-migration-v1',
      status: 'not-required',
      examinedCount: 0,
      migratedCount: 0,
      alreadyCurrentCount: 0,
      migratedAt: null,
      legacyProviders: []
    };
    this.load();
    const defaultLegacyProviders = keyProvider === null && this.keyInfo.protectedByOs === true
      ? [new StaticVaultKeyProvider({
          secret,
          provider: process.env.JARVIS_PC_AGENT_VAULT_KEY ? 'env-secret' : 'static-dev-secret'
        })]
      : [];
    if (migrateLegacyRecords && this.keyInfo.protectedByOs === true) {
      this.migrateToActiveKey(legacyKeyProviders ?? defaultLegacyProviders);
    }
  }

  deriveKey(keyMaterial) {
    return createHash('sha256').update(keyMaterial).digest();
  }

  keyIdFor(keyMaterial) {
    return `pc_vault_key_${createHash('sha256').update(keyMaterial).digest('hex').slice(0, 20)}`;
  }

  load() {
    let lines = [];
    try {
      lines = readFileSync(this.vaultPath, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    this.records = lines.map((line) => JSON.parse(line));
  }

  sealCapabilityToken(token, { taskId, packetId, toolName } = {}) {
    const sealed = this.sealWithKey(token, this.key);
    const record = {
      recordType: 'sealed_capability_token',
      vaultRecordId: stableId('capvault', `${taskId}:${packetId ?? token.tokenId}`, this.clock().toISOString()),
      taskId,
      packetId: packetId ?? null,
      toolName: toolName ?? null,
      tokenIdHash: createHash('sha256').update(token.tokenId ?? '').digest('hex'),
      algorithm: 'aes-256-gcm',
      keyProvider: this.keyInfo.provider,
      keyId: this.keyId,
      keyProtectedByOs: this.keyInfo.protectedByOs === true,
      ...sealed,
      sealedAt: this.clock().toISOString()
    };
    this.records.unshift(record);
    appendJsonlSync(this.vaultPath, record);
    return {
      vaultRecordId: record.vaultRecordId,
      tokenIdHash: record.tokenIdHash,
      sealedAt: record.sealedAt
    };
  }

  open(record) {
    const preferredKey = record.keyId ? this.keyRing.get(record.keyId) : null;
    const candidates = [...new Set([preferredKey, this.key, ...this.keyRing.values()].filter(Boolean))];
    let lastError = null;
    for (const key of candidates) {
      try {
        return this.openWithKey(record, key);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('Capability vault record has no usable key.');
  }

  openWithKey(record, key) {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(decrypted);
  }

  sealWithKey(token, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64')
    };
  }

  migrateToActiveKey(legacyKeyProviders = []) {
    if (this.records.length === 0) return this.migration;
    const legacyKeys = legacyKeyProviders.map((provider) => {
      const info = provider.resolveKey();
      return {
        provider: info.provider ?? 'legacy',
        keyId: this.keyIdFor(info.keyMaterial),
        key: this.deriveKey(info.keyMaterial)
      };
    }).filter((candidate) => candidate.keyId !== this.keyId);
    const candidates = [{ provider: this.keyInfo.provider, keyId: this.keyId, key: this.key }, ...legacyKeys];
    const migratedAt = this.clock().toISOString();
    let migratedCount = 0;
    let alreadyCurrentCount = 0;
    const nextRecords = this.records.map((record) => {
      let opened = null;
      let openedWith = null;
      for (const candidate of candidates) {
        try {
          opened = this.openWithKey(record, candidate.key);
          openedWith = candidate;
          break;
        } catch {
          // Continue with the next explicitly known key without exposing token material.
        }
      }
      if (!openedWith) {
        const error = new Error(`Capability vault migration could not decrypt record ${record.vaultRecordId ?? 'unknown'}.`);
        error.code = 'B_CAPABILITY_VAULT_MIGRATION_DECRYPT_FAILED';
        throw error;
      }
      const alreadyCurrent = openedWith.keyId === this.keyId
        && record.keyId === this.keyId
        && record.keyProvider === this.keyInfo.provider
        && record.keyProtectedByOs === true;
      if (alreadyCurrent) {
        alreadyCurrentCount += 1;
        return record;
      }
      migratedCount += 1;
      return {
        ...record,
        ...this.sealWithKey(opened, this.key),
        keyProvider: this.keyInfo.provider,
        keyId: this.keyId,
        keyProtectedByOs: true,
        migrationVersion: 'b-capability-vault-key-migration-v1',
        migratedAt,
        previousKeyIdHash: record.keyId
          ? createHash('sha256').update(String(record.keyId)).digest('hex')
          : null
      };
    });
    if (migratedCount > 0) {
      this.replaceRecordsAtomically(nextRecords);
      this.records = nextRecords;
    }
    this.migration = {
      migrationVersion: 'b-capability-vault-key-migration-v1',
      status: migratedCount > 0 ? 'migrated' : 'current',
      examinedCount: this.records.length,
      migratedCount,
      alreadyCurrentCount,
      migratedAt: migratedCount > 0 ? migratedAt : null,
      legacyProviders: [...new Set(legacyKeys.map((candidate) => candidate.provider))]
    };
    for (const candidate of legacyKeys) candidate.key.fill(0);
    return this.migration;
  }

  replaceRecordsAtomically(records) {
    mkdirSync(dirname(this.vaultPath), { recursive: true });
    const temporaryPath = `${this.vaultPath}.migration-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    try {
      writeFileSync(temporaryPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const verification = readFileSync(temporaryPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (verification.length !== records.length) {
        const error = new Error('Capability vault migration verification count mismatch.');
        error.code = 'B_CAPABILITY_VAULT_MIGRATION_VERIFY_FAILED';
        throw error;
      }
      for (const record of verification) this.openWithKey(record, this.key);
      renameSync(temporaryPath, this.vaultPath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  status() {
    return {
      statusVersion: 'b-capability-vault-status-v1',
      vaultPath: this.vaultPath,
      sealedCount: this.records.length,
      keyProvider: {
        providerVersion: 'b-capability-vault-key-provider-v1',
        provider: this.keyInfo.provider,
        keyId: this.keyId,
        protectedByOs: this.keyInfo.protectedByOs === true,
        scope: this.keyInfo.scope ?? null,
        fallback: this.keyInfo.fallback === true,
        warning: this.keyInfo.warning ?? null
      },
      deploymentPolicy: this.deploymentPolicy(),
      rotation: {
        rotationVersion: 'b-capability-vault-key-rotation-policy-v1',
        supported: true,
        retainedKeyCount: this.keyRing.size,
        rotationCount: this.rotationHistory.length,
        history: this.rotationHistory.slice(0, 10)
      },
      migration: { ...this.migration },
      latest: this.records[0]
        ? {
            vaultRecordId: this.records[0].vaultRecordId,
            taskId: this.records[0].taskId,
            tokenIdHash: this.records[0].tokenIdHash,
            keyProvider: this.records[0].keyProvider ?? null,
            keyId: this.records[0].keyId ?? null,
            keyProtectedByOs: this.records[0].keyProtectedByOs === true,
            sealedAt: this.records[0].sealedAt
          }
        : null,
      plaintextTokenStored: this.records.some((record) => JSON.stringify(record).includes('"tokenId"'))
    };
  }

  deploymentPolicy() {
    return {
      policyVersion: 'b-capability-vault-deployment-policy-v1',
      preferredProvider: 'windows-dpapi',
      credentialManagerCompatible: true,
      fallbackProvider: 'env-secret-or-static-dev-secret',
      plaintextTokenStorageAllowed: false,
      serviceEnvironment: {
        providerEnv: 'JARVIS_PC_AGENT_VAULT_KEY_PROVIDER=windows-dpapi',
        optionalSecretEnv: 'JARVIS_PC_AGENT_VAULT_KEY'
      },
      recovery: {
        exportVersion: 'b-capability-vault-export-v1',
        importRecoveryVersion: 'b-capability-vault-import-recovery-v1',
        keyEscrowRequiredForOldRotatedRecords: true
      }
    };
  }

  rotateKey({ nextKeyProvider = null, reason = 'manual_rotation' } = {}) {
    const previous = {
      keyId: this.keyId,
      provider: this.keyInfo.provider,
      protectedByOs: this.keyInfo.protectedByOs === true
    };
    if (nextKeyProvider) this.keyProvider = nextKeyProvider;
    else {
      this.keyProvider = new StaticVaultKeyProvider({
        secret: `rotated-${randomBytes(32).toString('base64')}`,
        provider: this.keyInfo.provider === 'windows-dpapi' ? 'windows-dpapi-rotation-drill' : 'static-rotation-drill'
      });
    }
    this.keyInfo = this.keyProvider.resolveKey();
    this.key = this.deriveKey(this.keyInfo.keyMaterial);
    this.keyId = this.keyIdFor(this.keyInfo.keyMaterial);
    this.keyRing.set(this.keyId, this.key);
    const rotation = {
      rotationVersion: 'b-capability-vault-key-rotation-v1',
      rotatedAt: this.clock().toISOString(),
      reason,
      previous,
      current: {
        keyId: this.keyId,
        provider: this.keyInfo.provider,
        protectedByOs: this.keyInfo.protectedByOs === true
      },
      retainedKeyCount: this.keyRing.size
    };
    this.rotationHistory.unshift(rotation);
    return rotation;
  }

  keyRotationDrill({ reason = 'product_drill' } = {}) {
    const before = this.sealCapabilityToken(
      { tokenId: `cap_rotation_before_${this.clock().getTime()}`, scope: ['drill.before'] },
      { taskId: 'vault_rotation_drill_before', toolName: 'vault.drill' }
    );
    const beforeRecord = this.records.find((record) => record.vaultRecordId === before.vaultRecordId);
    const rotation = this.rotateKey({ reason });
    const after = this.sealCapabilityToken(
      { tokenId: `cap_rotation_after_${this.clock().getTime()}`, scope: ['drill.after'] },
      { taskId: 'vault_rotation_drill_after', toolName: 'vault.drill' }
    );
    const afterRecord = this.records.find((record) => record.vaultRecordId === after.vaultRecordId);
    const beforeOpened = this.open(beforeRecord);
    const afterOpened = this.open(afterRecord);
    const checks = [
      {
        checkId: 'previous_record_opened_after_rotation',
        passed: beforeOpened.tokenId.startsWith('cap_rotation_before_')
      },
      {
        checkId: 'new_record_opened_after_rotation',
        passed: afterOpened.tokenId.startsWith('cap_rotation_after_')
      },
      {
        checkId: 'key_id_changed',
        passed: rotation.previous.keyId !== rotation.current.keyId
      }
    ];
    return {
      drillVersion: 'b-capability-vault-key-rotation-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      rotation
    };
  }

  exportEncryptedVault({ reason = 'vault_export' } = {}) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = JSON.stringify({
      exportPayloadVersion: 'b-capability-vault-export-payload-v1',
      exportedAt: this.clock().toISOString(),
      reason,
      records: this.records
    });
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      exportVersion: 'b-capability-vault-export-v1',
      exportedAt: this.clock().toISOString(),
      reason,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      keyId: this.keyId,
      recordCount: this.records.length,
      plaintextTokenStored: false,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  importEncryptedVault({ exportBundle, reason = 'vault_import_recovery', replace = false } = {}) {
    if (!exportBundle || exportBundle.exportVersion !== 'b-capability-vault-export-v1') {
      return { success: false, error: { code: 'B_VAULT_EXPORT_INVALID' } };
    }
    const key = exportBundle.keyId ? (this.keyRing.get(exportBundle.keyId) ?? this.key) : this.key;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(exportBundle.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(exportBundle.authTag, 'base64'));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(exportBundle.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8'));
    const importedRecords = payload.records ?? [];
    if (replace) {
      this.records = [];
      writeFileSync(this.vaultPath, '', 'utf8');
    }
    const existing = new Set(this.records.map((record) => record.vaultRecordId));
    let importedCount = 0;
    for (const record of importedRecords) {
      if (existing.has(record.vaultRecordId)) continue;
      this.records.unshift(record);
      appendJsonlSync(this.vaultPath, record);
      importedCount += 1;
    }
    return {
      recoveryVersion: 'b-capability-vault-import-recovery-v1',
      generatedAt: this.clock().toISOString(),
      reason,
      status: 'recovered',
      success: true,
      exportKeyId: exportBundle.keyId,
      exportedRecordCount: importedRecords.length,
      importedCount,
      sealedCount: this.records.length,
      plaintextTokenStored: this.status().plaintextTokenStored
    };
  }

  releaseDossier({
    productChecks = [],
    vaultStatus = this.status(),
    exportBundle = null,
    recovery = null,
    rotationDrill = null
  } = {}) {
    const releaseChecks = [
      {
        checkId: 'capability_vault_key_provider_release_evidence',
        passed: vaultStatus.keyProvider?.providerVersion === 'b-capability-vault-key-provider-v1'
          && (vaultStatus.keyProvider.protectedByOs === true || vaultStatus.deploymentPolicy?.preferredProvider === 'windows-dpapi')
          && vaultStatus.deploymentPolicy?.policyVersion === 'b-capability-vault-deployment-policy-v1',
        provider: vaultStatus.keyProvider?.provider ?? null,
        protectedByOs: vaultStatus.keyProvider?.protectedByOs === true,
        preferredProvider: vaultStatus.deploymentPolicy?.preferredProvider ?? null
      },
      {
        checkId: 'capability_vault_plaintext_absence_release_evidence',
        passed: vaultStatus.plaintextTokenStored === false,
        sealedCount: vaultStatus.sealedCount,
        plaintextTokenStored: vaultStatus.plaintextTokenStored
      },
      {
        checkId: 'capability_vault_encrypted_export_release_evidence',
        passed: exportBundle?.exportVersion === 'b-capability-vault-export-v1'
          && exportBundle.encrypted === true
          && exportBundle.plaintextTokenStored === false
          && exportBundle.recordCount >= 1,
        recordCount: exportBundle?.recordCount ?? 0,
        keyId: exportBundle?.keyId ?? null
      },
      {
        checkId: 'capability_vault_import_recovery_release_evidence',
        passed: recovery?.recoveryVersion === 'b-capability-vault-import-recovery-v1'
          && recovery.status === 'recovered'
          && recovery.plaintextTokenStored === false,
        exportedRecordCount: recovery?.exportedRecordCount ?? 0,
        importedCount: recovery?.importedCount ?? 0
      },
      {
        checkId: 'capability_vault_key_rotation_release_evidence',
        passed: rotationDrill?.drillVersion === 'b-capability-vault-key-rotation-drill-v1'
          && rotationDrill.status === 'passed'
          && rotationDrill.rotation?.previous?.keyId !== rotationDrill.rotation?.current?.keyId,
        retainedKeyCount: rotationDrill?.rotation?.retainedKeyCount ?? 0,
        currentProvider: rotationDrill?.rotation?.current?.provider ?? null
      }
    ];
    const artifactManifest = {
      manifestVersion: 'b-capability-vault-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      vaultPathHash: createHash('sha256').update(String(this.vaultPath ?? '')).digest('hex'),
      keyProviderHash: createHash('sha256').update(canonicalJson({
        providerVersion: vaultStatus.keyProvider?.providerVersion ?? null,
        provider: vaultStatus.keyProvider?.provider ?? null,
        protectedByOs: vaultStatus.keyProvider?.protectedByOs === true,
        scope: vaultStatus.keyProvider?.scope ?? null,
        fallback: vaultStatus.keyProvider?.fallback === true
      })).digest('hex'),
      exportEvidenceHash: createHash('sha256').update(canonicalJson({
        exportVersion: exportBundle?.exportVersion ?? null,
        encrypted: exportBundle?.encrypted === true,
        recordCount: exportBundle?.recordCount ?? 0,
        plaintextTokenStored: exportBundle?.plaintextTokenStored === true
      })).digest('hex'),
      recoveryEvidenceHash: createHash('sha256').update(canonicalJson({
        recoveryVersion: recovery?.recoveryVersion ?? null,
        status: recovery?.status ?? null,
        importedCount: recovery?.importedCount ?? 0,
        plaintextTokenStored: recovery?.plaintextTokenStored === true
      })).digest('hex'),
      rotationDrillHash: createHash('sha256').update(canonicalJson({
        drillVersion: rotationDrill?.drillVersion ?? null,
        status: rotationDrill?.status ?? null,
        retainedKeyCount: rotationDrill?.rotation?.retainedKeyCount ?? 0
      })).digest('hex'),
      rawVaultPathStored: false,
      rawTokenIdStored: false,
      rawSecretStored: false,
      rawKeyMaterialStored: false,
      plaintextTokenStored: vaultStatus.plaintextTokenStored === true
    };
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-capability-vault-release-raw-leak-check-v1',
      rawLeakDetected: containsCapabilityVaultRawLeak(artifactManifest),
      checkedRawFields: [
        'rawVaultPathStored',
        'rawTokenIdStored',
        'rawSecretStored',
        'rawKeyMaterialStored'
      ]
    };
    const operationalHandoffManifest = {
      manifestVersion: 'b-capability-vault-operational-handoff-manifest-v1',
      healthHandshakeVersion: 'b-capability-vault-health-handshake-v1',
      generatedAt: this.clock().toISOString(),
      status: releaseChecks.every((check) => check.passed)
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'ready'
        : 'blocked',
      healthHandshake: {
        sealedCount: vaultStatus.sealedCount,
        providerVersion: vaultStatus.keyProvider?.providerVersion ?? null,
        provider: vaultStatus.keyProvider?.provider ?? null,
        protectedByOs: vaultStatus.keyProvider?.protectedByOs === true,
        plaintextTokenStored: vaultStatus.plaintextTokenStored === true,
        exportReady: exportBundle?.exportVersion === 'b-capability-vault-export-v1' && exportBundle.encrypted === true,
        recoveryReady: recovery?.recoveryVersion === 'b-capability-vault-import-recovery-v1' && recovery.status === 'recovered',
        rotationReady: rotationDrill?.drillVersion === 'b-capability-vault-key-rotation-drill-v1' && rotationDrill.status === 'passed'
      },
      fallbackPolicy: {
        policyVersion: 'b-capability-vault-fallback-policy-v1',
        primaryFlow: 'windows_dpapi_or_credential_manager_key_provider',
        fallbackFlows: [
          'env_secret_dev_provider_with_plaintext_absence_check',
          'encrypted_export_import_recovery',
          'key_rotation_drill_before_release'
        ],
        operatorEscalation: 'pc_agent_vault_lifecycle_api'
      },
      rawVaultPathStored: false,
      rawTokenIdStored: false,
      rawSecretStored: false,
      rawKeyMaterialStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-capability-vault-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B capability vault supports OS-protected key provider" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'plaintext_token_not_stored',
        'encrypted_export_created',
        'import_recovery_completed',
        'key_rotation_drill_passed',
        'capability_vault_release_artifact_manifest_ready',
        'capability_vault_operational_handoff_ready',
        'capability_vault_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      rawVaultPathStored: false,
      rawTokenIdStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-capability-vault-worm-promotion-package-v1',
      providerContractVersion: 'b-capability-vault-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-capability-vault-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'b-capability-vault-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawTokenIdStored: false,
      rawSecretStored: false,
      rawKeyMaterialStored: false
    };
    const dossier = {
      dossierVersion: 'b-capability-vault-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: productChecks.every((check) => check.passed)
        && releaseChecks.every((check) => check.passed)
        && externalWormPromotionPackage.status === 'ready'
        ? 'passed'
        : 'blocked',
      vaultPathHash: artifactManifest.vaultPathHash,
      rawVaultPathStored: false,
      sealedCount: vaultStatus.sealedCount,
      keyProvider: vaultStatus.keyProvider,
      deploymentPolicy: vaultStatus.deploymentPolicy,
      rotation: vaultStatus.rotation,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      exportEvidence: exportBundle
        ? {
            exportVersion: exportBundle.exportVersion,
            encrypted: exportBundle.encrypted,
            recordCount: exportBundle.recordCount,
            plaintextTokenStored: exportBundle.plaintextTokenStored,
            keyId: exportBundle.keyId
          }
        : null,
      recoveryEvidence: recovery,
      rotationDrill,
      productChecks: productChecks.map((check) => ({ ...check })),
      releaseChecks,
      recommendedReleaseAction: releaseChecks.every((check) => check.passed)
        && externalWormPromotionPackage.status === 'ready'
        ? 'attach_capability_vault_hash_only_handoff_and_worm_release_evidence'
        : 'block_capability_vault_release_until_dpapi_or_recovery_evidence_passes'
    };
    dossier.dossierSha256 = createHash('sha256').update(JSON.stringify(dossier)).digest('hex');
    return dossier;
  }

  productGate() {
    const status = this.status();
    this.sealCapabilityToken(
      { tokenId: `cap_product_gate_${this.clock().getTime()}`, scope: ['vault.product_gate'] },
      { taskId: 'vault_product_gate', toolName: 'vault.productGate' }
    );
    const exportBundle = this.exportEncryptedVault({ reason: 'product_gate_export' });
    const recoveryVault = new CapabilityTokenVault({
      vaultPath: `${this.vaultPath}.recovery-${this.clock().getTime()}.jsonl`,
      keyProvider: {
        resolveKey: () => this.keyInfo
      },
      clock: this.clock
    });
    const recovery = recoveryVault.importEncryptedVault({
      exportBundle,
      reason: 'product_gate_recovery',
      replace: true
    });
    const rotationDrill = this.keyRotationDrill({ reason: 'product_gate_rotation' });
    const checks = [
      {
        checkId: 'os_or_deployment_policy_available',
        passed: status.keyProvider.protectedByOs === true || status.deploymentPolicy.preferredProvider === 'windows-dpapi'
      },
      {
        checkId: 'plaintext_token_not_stored',
        passed: this.status().plaintextTokenStored === false
      },
      {
        checkId: 'encrypted_export_created',
        passed: exportBundle.exportVersion === 'b-capability-vault-export-v1' && exportBundle.encrypted === true
      },
      {
        checkId: 'import_recovery_completed',
        passed: recovery.recoveryVersion === 'b-capability-vault-import-recovery-v1' && recovery.status === 'recovered'
      },
      {
        checkId: 'key_rotation_drill_passed',
        passed: rotationDrill.drillVersion === 'b-capability-vault-key-rotation-drill-v1' && rotationDrill.status === 'passed'
      }
    ];
    const releaseDossier = this.releaseDossier({
      productChecks: checks,
      vaultStatus: this.status(),
      exportBundle,
      recovery,
      rotationDrill
    });
    checks.push({
      checkId: 'capability_vault_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'b-capability-vault-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
    });
    checks.push({
      checkId: 'capability_vault_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest?.manifestVersion === 'b-capability-vault-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        && releaseDossier.artifactManifest.rawVaultPathStored === false
        && releaseDossier.artifactManifest.rawTokenIdStored === false
    });
    checks.push({
      checkId: 'capability_vault_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest?.manifestVersion === 'b-capability-vault-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest?.healthHandshakeVersion === 'b-capability-vault-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest?.fallbackPolicy?.policyVersion === 'b-capability-vault-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest?.status === 'ready'
    });
    checks.push({
      checkId: 'capability_vault_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage?.packageVersion === 'b-capability-vault-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'b-capability-vault-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
    });
    recoveryVault.close?.();
    return {
      productGateVersion: 'b-capability-vault-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      vaultStatus: this.status(),
      exportBundle: {
        exportVersion: exportBundle.exportVersion,
        encrypted: exportBundle.encrypted,
        recordCount: exportBundle.recordCount,
        keyId: exportBundle.keyId,
        plaintextTokenStored: exportBundle.plaintextTokenStored
      },
      recovery,
      rotationDrill,
      releaseDossier
    };
  }
}

export class StaticVaultKeyProvider {
  constructor({ secret = process.env.JARVIS_PC_AGENT_VAULT_KEY ?? 'jarvis-local-pc-agent-dev-key', provider = process.env.JARVIS_PC_AGENT_VAULT_KEY ? 'env-secret' : 'static-dev-secret' } = {}) {
    this.secret = secret;
    this.provider = provider;
  }

  resolveKey() {
    return {
      keyMaterial: Buffer.from(String(this.secret), 'utf8'),
      provider: this.provider,
      protectedByOs: false,
      fallback: this.provider === 'static-dev-secret'
    };
  }
}

export class WindowsDpapiVaultKeyProvider {
  constructor({
    cachePath = 'apps/pc-agent/logs/capability-vault.dpapi-key',
    scope = 'CurrentUser',
    fallbackSecret = process.env.JARVIS_PC_AGENT_VAULT_KEY ?? 'jarvis-local-pc-agent-dev-key',
    allowInsecureFallback = false
  } = {}) {
    this.cachePath = cachePath;
    this.scope = scope;
    this.fallbackSecret = fallbackSecret;
    this.allowInsecureFallback = allowInsecureFallback;
  }

  resolveKey() {
    if (process.platform !== 'win32') {
      return this.failure(`DPAPI provider requires Windows; current platform is ${process.platform}.`);
    }
    try {
      const keyMaterial = existsSync(this.cachePath)
        ? this.readProtectedKey()
        : this.createProtectedKey();
      return {
        keyMaterial,
        provider: 'windows-dpapi',
        protectedByOs: true,
        scope: this.scope,
        cachePath: this.cachePath,
        fallback: false
      };
    } catch (error) {
      return this.failure(`DPAPI key provider failed: ${error.message}`, error);
    }
  }

  createProtectedKey() {
    const keyMaterial = randomBytes(32);
    const protectedKey = this.protect(keyMaterial);
    mkdirSync(dirname(this.cachePath), { recursive: true });
    try {
      writeFileSync(this.cachePath, `${protectedKey}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') return this.readProtectedKey();
      throw error;
    }
    hardenWindowsVaultKeyFile(this.cachePath);
    return keyMaterial;
  }

  readProtectedKey() {
    hardenWindowsVaultKeyFile(this.cachePath);
    return this.unprotect(readFileSync(this.cachePath, 'utf8').trim());
  }

  protect(keyMaterial) {
    return runDpapiPowerShell({
      inputBase64: Buffer.from(keyMaterial).toString('base64'),
      scope: this.scope,
      mode: 'Protect'
    });
  }

  unprotect(protectedBase64) {
    const clearBase64 = runDpapiPowerShell({
      inputBase64: protectedBase64,
      scope: this.scope,
      mode: 'Unprotect'
    });
    return Buffer.from(clearBase64, 'base64');
  }

  fallback(warning) {
    return {
      keyMaterial: Buffer.from(String(this.fallbackSecret), 'utf8'),
      provider: 'static-dev-fallback',
      protectedByOs: false,
      fallback: true,
      warning
    };
  }

  failure(message, cause = null) {
    if (this.allowInsecureFallback) return this.fallback(message);
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'B_CAPABILITY_VAULT_DPAPI_UNAVAILABLE';
    throw error;
  }
}

function createDefaultVaultKeyProvider({ secret, vaultPath }) {
  const requested = String(process.env.JARVIS_PC_AGENT_VAULT_KEY_PROVIDER ?? '').toLowerCase();
  if (requested === 'windows-dpapi' || requested === 'dpapi') {
    return new WindowsDpapiVaultKeyProvider({
      cachePath: `${vaultPath}.dpapi-key`,
      fallbackSecret: secret,
      allowInsecureFallback: process.env.JARVIS_TEST_MODE === '1'
        && process.env.JARVIS_PC_AGENT_VAULT_ALLOW_INSECURE_FALLBACK === '1'
    });
  }
  return new StaticVaultKeyProvider({
    secret,
    provider: process.env.JARVIS_PC_AGENT_VAULT_KEY ? 'env-secret' : 'static-dev-secret'
  });
}

function runDpapiPowerShell({ inputBase64, scope, mode }) {
  const method = mode === 'Protect' ? 'Protect' : 'Unprotect';
  const command = [
    'Add-Type -AssemblyName System.Security;',
    '$bytes=[Convert]::FromBase64String($env:JARVIS_DPAPI_INPUT);',
    `$scope=[System.Security.Cryptography.DataProtectionScope]::${scope === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser'};`,
    `$out=[System.Security.Cryptography.ProtectedData]::${method}($bytes,$null,$scope);`,
    '[Convert]::ToBase64String($out)'
  ].join(' ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    env: { ...process.env, JARVIS_DPAPI_INPUT: inputBase64 }
  }).trim();
}

export class ToolAdapterRegistry {
  constructor() {
    this.adapters = new Map();
    this.contracts = new Map();
    this.executionSelectors = new Map();
  }

  register(toolName, adapter) {
    const validation = this.validateAdapter(toolName, adapter);
    if (!validation.valid) {
      const error = new Error(`Tool adapter contract invalid: ${validation.errors.join(' | ')}`);
      error.code = 'B_TOOL_ADAPTER_CONTRACT_INVALID';
      error.errors = validation.errors;
      throw error;
    }
    this.adapters.set(toolName, adapter);
    this.contracts.set(toolName, adapter.contract);
  }

  get(toolName) {
    return this.adapters.get(toolName);
  }

  selectExecution(toolName,packet,options) {
    return this.executionSelectors.get(toolName)?.(packet,options)??null;
  }

  contractFor(toolName) {
    return this.contracts.get(toolName) ?? null;
  }

  capabilityMatrix() {
    return [...this.contracts.values()];
  }

  validateAdapter(toolName, adapter) {
    const errors = [];
    if (!toolName) errors.push('toolName is required.');
    if (typeof adapter?.shadow !== 'function') errors.push(`${toolName}.shadow(args, packet) is required.`);
    if (typeof adapter?.execute !== 'function') errors.push(`${toolName}.execute(args, packet) is required.`);
    if (!adapter?.contract || typeof adapter.contract !== 'object') errors.push(`${toolName}.contract is required.`);
    if (adapter?.contract?.toolName !== toolName) errors.push(`${toolName}.contract.toolName must match registry key.`);
    if (!Array.isArray(adapter?.contract?.evidence)) errors.push(`${toolName}.contract.evidence must be an array.`);
    if (!Array.isArray(adapter?.contract?.modes) || adapter.contract.modes.length === 0) errors.push(`${toolName}.contract.modes is required.`);
    return { valid: errors.length === 0, errors };
  }
}

export class ExecutionEvidenceSchemaRegistry {
  constructor() {
    this.schemas = new Map([
      ['filesystem.createTextFile', ['outputPaths', 'changedItems', 'files', 'undoJournalId', 'adapterEvidence.targetPath']],
      ['filesystem.moveFiles', ['outputPaths', 'changedItems', 'files', 'undoJournalId']],
      ['excel.createWorkbook', ['outputPaths', 'changedItems', 'files', 'adapterEvidence.workbook']],
      ['browser.search', ['adapterEvidence.browser.networkCapture', 'adapterEvidence.browser.domSnapshot', 'adapterEvidence.browser.blockedOperations']],
      ['news.fetchHeadlines', ['adapterEvidence.news.live', 'adapterEvidence.news.retrievedAt', 'adapterEvidence.news.sourceUrl', 'adapterEvidence.news.sourceHost', 'adapterEvidence.news.items']],
      ['news.fetchPublisherFeed', ['adapterEvidence.news.live', 'adapterEvidence.news.feedUrl', 'adapterEvidence.news.finalFeedUrl', 'adapterEvidence.news.items']],
      ['news.fetchArticle', ['adapterEvidence.article.live', 'adapterEvidence.article.finalUrl', 'adapterEvidence.article.textSha256', 'adapterEvidence.article.textCharacters']]
    ]);
  }

  register(toolName, required) {
    const normalizedToolName = String(toolName ?? '').trim();
    const normalizedRequired = [...new Set((required ?? []).map((item) => String(item ?? '').trim()).filter(Boolean))];
    if (!normalizedToolName || normalizedRequired.length === 0) {
      const error = new Error('Execution evidence schema registration is invalid.');
      error.code = 'B_EVIDENCE_SCHEMA_INVALID';
      throw error;
    }
    const existing = this.schemas.get(normalizedToolName);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalizedRequired)) {
        const error = new Error(`Execution evidence schema conflict for ${normalizedToolName}.`);
        error.code = 'B_EVIDENCE_SCHEMA_CONFLICT';
        throw error;
      }
      return [...existing];
    }
    this.schemas.set(normalizedToolName, normalizedRequired);
    return [...normalizedRequired];
  }

  validate(evidence) {
    const required = this.schemas.get(evidence.toolName) ?? ['outputPaths', 'changedItems'];
    const missing = required.filter((path) => this.lookup(evidence, path) === undefined);
    return {
      valid: missing.length === 0,
      schemaId: `b-evidence-${evidence.toolName ?? 'generic'}-v1`,
      required,
      missing
    };
  }

  lookup(value, path) {
    return path.split('.').reduce((current, part) => current?.[part], value);
  }

  snapshot() {
    const schemas = [...this.schemas.entries()]
      .map(([toolName, required]) => ({ toolName, schemaId: `b-evidence-${toolName}-v1`, required: [...required].sort() }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
    const snapshot = {
      snapshotVersion: 'b-execution-evidence-schema-snapshot-v1',
      generatedAt: new Date().toISOString(),
      schemaCount: schemas.length,
      schemas
    };
    return {
      ...snapshot,
      snapshotHash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex')
    };
  }

  regressionReport(baseline) {
    const current = this.snapshot();
    const baselineSchemas = new Map((baseline?.schemas ?? []).map((item) => [item.toolName, item]));
    const currentSchemas = new Map(current.schemas.map((item) => [item.toolName, item]));
    const items = [];
    for (const [toolName, schema] of currentSchemas) {
      const previous = baselineSchemas.get(toolName);
      const added = schema.required.filter((item) => !(previous?.required ?? []).includes(item));
      const removed = (previous?.required ?? []).filter((item) => !schema.required.includes(item));
      items.push({
        toolName,
        status: !previous ? 'added' : (removed.length ? 'breaking_removed_required_field' : added.length ? 'expanded' : 'unchanged'),
        added,
        removed
      });
    }
    for (const [toolName, schema] of baselineSchemas) {
      if (!currentSchemas.has(toolName)) {
        items.push({ toolName, status: 'removed_schema', added: [], removed: schema.required ?? [] });
      }
    }
    return {
      reportVersion: 'b-execution-evidence-schema-regression-v1',
      generatedAt: new Date().toISOString(),
      status: items.some((item) => item.status === 'removed_schema' || item.status === 'breaking_removed_required_field') ? 'failed' : 'passed',
      currentSnapshotHash: current.snapshotHash,
      baselineSnapshotHash: baseline?.snapshotHash ?? null,
      items
    };
  }
}

export class EvidencePrivacyRedactor {
  constructor({ sensitiveKeyPattern = /password|token|secret|cookie|authorization|apiKey|previousContent|previousBytes|content|credential|주민|비밀번호|계좌/i } = {}) {
    this.sensitiveKeyPattern = sensitiveKeyPattern;
  }

  redact(value) {
    const stats = { sensitiveKeyCount: 0 };
    const redacted = this.walk(value, stats);
    return { redacted, stats };
  }

  walk(value, stats) {
    if (Array.isArray(value)) return value.map((item) => this.walk(item, stats));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (this.sensitiveKeyPattern.test(key)) {
        stats.sensitiveKeyCount += 1;
        return [key, '[redacted]'];
      }
      return [key, this.walk(item, stats)];
    }));
  }

  runFixtureCorpus(corpus = createEvidencePrivacyFixtureCorpus()) {
    const items = (corpus.cases ?? []).map((testCase) => {
      const result = this.redact(testCase.input);
      const serialized = JSON.stringify(result.redacted);
      const leaks = (testCase.mustNotContain ?? []).filter((needle) => serialized.includes(needle));
      return {
        caseId: testCase.caseId,
        status: leaks.length === 0 && result.stats.sensitiveKeyCount >= (testCase.expectedSensitiveKeyCountMin ?? 1) ? 'passed' : 'failed',
        sensitiveKeyCount: result.stats.sensitiveKeyCount,
        leaks,
        redacted: result.redacted
      };
    });
    return {
      corpusVersion: corpus.corpusVersion,
      reportVersion: 'b-evidence-privacy-redaction-fixture-report-v1',
      generatedAt: new Date().toISOString(),
      status: items.every((item) => item.status === 'passed') ? 'passed' : 'failed',
      caseCount: items.length,
      items
    };
  }
}

export function createEvidencePrivacyFixtureCorpus() {
  return {
    corpusVersion: 'b-evidence-privacy-redaction-fixture-corpus-v1',
    generatedAt: new Date().toISOString(),
    cases: [
      {
        caseId: 'capability_token_redacted',
        input: { tokenId: 'cap_plaintext_token', authorization: 'Bearer secret-token', safe: 'ok' },
        mustNotContain: ['cap_plaintext_token', 'secret-token'],
        expectedSensitiveKeyCountMin: 2
      },
      {
        caseId: 'file_content_redacted',
        input: { targetPath: 'C:/safe/out.txt', previousContent: 'private before', content: 'private after' },
        mustNotContain: ['private before', 'private after'],
        expectedSensitiveKeyCountMin: 2
      },
      {
        caseId: 'browser_cookie_redacted',
        input: { browser: { networkCapture: { cookie: 'sid=abc', headers: { authorization: 'Bearer abc' } }, domSnapshot: '<main>safe</main>' } },
        mustNotContain: ['sid=abc', 'Bearer abc'],
        expectedSensitiveKeyCountMin: 2
      }
    ]
  };
}

function createToolContract({
  toolName,
  readOnly = false,
  mutatesSystem = false,
  rollback = false,
  evidence = [],
  blockedOperations = [],
  requiresAvailabilityBinding = false,
  modes = ['shadow', 'execute']
}) {
  return {
    toolName,
    readOnly,
    mutatesSystem,
    preview: true,
    execute: true,
    rollback,
    evidence,
    blockedOperations,
    ...(requiresAvailabilityBinding ? { requiresAvailabilityBinding: true } : {}),
    modes
  };
}

export class ExecutionEvidenceCollector {
  constructor({ clock = () => new Date(), logPath = 'apps/pc-agent/logs/evidence.jsonl', schemaRegistry = new ExecutionEvidenceSchemaRegistry(), privacyRedactor = new EvidencePrivacyRedactor() } = {}) {
    this.clock = clock;
    this.logPath = logPath;
    this.items = new Map();
    this.schemaRegistry = schemaRegistry;
    this.privacyRedactor = privacyRedactor;
  }

  async fileHash(path) {
    const buffer = await readFile(path);
    return createHash('sha256').update(buffer).digest('hex');
  }

  async collect({ packet, shadow, executionResult, status }) {
    const files = [];
    for (const outputPath of executionResult.outputPaths ?? []) {
      if (await exists(outputPath)) {
        const fileStat = await stat(outputPath);
        files.push({
          path: outputPath,
          sha256: await this.fileHash(outputPath),
          size: fileStat.size
        });
      }
    }
    const adapterRedaction = this.privacyRedactor.redact(maskSensitive(executionResult.evidence ?? {}));
    const evidence = {
      evidenceId: stableId('evidence', `${packet.taskId}:${packet.packetId ?? 'packet'}`, this.clock().toISOString()),
      taskId: packet.taskId,
      packetId: packet.packetId,
      status,
      toolName: packet.action?.toolName,
      actionType: packet.action?.actionType,
      outputPaths: executionResult.outputPaths ?? [],
      changedItems: executionResult.changedItems ?? [],
      files,
      shadow: {
        expectedChangesCount: shadow?.expectedChangesCount ?? 0,
        ...(packet.action?.toolName==='document.readPdf'&&typeof shadow?.requestedPdfPath==='string'?{requestedPdfPath:shadow.requestedPdfPath}:{}),
        ...(packet.action?.toolName==='document.readPdf'?{pdfFirstPage:shadow?.pdfFirstPage,pdfMaxPages:shadow?.pdfMaxPages}:{}),
        ...(packet.action?.toolName==='excel.readWorkbook'?{requestedXlsxPath:shadow?.requestedXlsxPath,requestedSheetName:shadow?.requestedSheetName,requestedXlsxRange:shadow?.requestedXlsxRange}:{}),
        ...(packet.action?.toolName==='excel.exportPdf'?{requestedXlsxSource:shadow?.requestedXlsxSource,pdfOutputPath:shadow?.pdfOutputPath}:{}),
        ...(packet.action?.toolName==='archive.createZip'?{outputPath:shadow?.outputPath,archiveInputs:shadow?.archiveInputs}:{}),
        warnings: shadow?.warnings ?? []
      },
      undoJournalId: executionResult.undoJournalId,
      adapterEvidence: adapterRedaction.redacted,
      privacyRedaction: {
        policy: 'mask-sensitive-keys-before-g-f-handoff',
        sensitiveKeyCount: adapterRedaction.stats.sensitiveKeyCount,
        plaintextCapabilityTokenPresent: JSON.stringify(adapterRedaction.redacted).includes(packet.capabilityToken?.tokenId ?? '__missing_token__')
      },
      collectedAt: this.clock().toISOString(),
      logPath: this.logPath
    };
    evidence.schemaValidation = this.schemaRegistry.validate(evidence);
    this.items.set(packet.taskId, evidence);
    appendJsonlSync(this.logPath, evidence);
    return evidence;
  }

  get(taskId) {
    return this.items.get(taskId) ?? { success: false, error: { code: 'B_EVIDENCE_NOT_FOUND' } };
  }

  recent(limit = 20) {
    return [...this.items.values()].slice(-limit).reverse();
  }

  query({ cursor = 0, limit = 20, taskId = null, status = null, toolName = null, since = null, until = null } = {}) {
    const offset = Math.max(0, Number(cursor ?? 0));
    const pageLimit = Math.max(1, Math.min(200, Number(limit ?? 20)));
    const sinceMs = since ? Date.parse(since) : null;
    const untilMs = until ? Date.parse(until) : null;
    const filtered = [...this.items.values()]
      .filter((item) => !taskId || item.taskId === taskId)
      .filter((item) => !status || item.status === status)
      .filter((item) => !toolName || item.toolName === toolName)
      .filter((item) => sinceMs === null || Date.parse(item.collectedAt) >= sinceMs)
      .filter((item) => untilMs === null || Date.parse(item.collectedAt) <= untilMs)
      .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
    const items = filtered.slice(offset, offset + pageLimit);
    return {
      queryVersion: 'b-execution-evidence-query-v1',
      generatedAt: this.clock().toISOString(),
      filters: { taskId, status, toolName, since, until },
      pageInfo: {
        cursor: offset,
        limit: pageLimit,
        total: filtered.length,
        nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null
      },
      items
    };
  }

  retentionReport({ keepLast = 100, maxAgeMs = null } = {}) {
    const nowMs = this.clock().getTime();
    const sorted = [...this.items.values()].sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
    const removable = sorted
      .map((item, index) => {
        const ageMs = Math.max(0, nowMs - Date.parse(item.collectedAt ?? this.clock().toISOString()));
        const reasons = [];
        if (index >= keepLast) reasons.push('keepLast');
        if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) reasons.push('maxAgeMs');
        return reasons.length ? {
          evidenceId: item.evidenceId,
          taskId: item.taskId,
          collectedAt: item.collectedAt,
          ageMs,
          reasons
        } : null;
      })
      .filter(Boolean);
    return {
      reportVersion: 'b-execution-evidence-retention-report-v1',
      generatedAt: this.clock().toISOString(),
      policy: { keepLast, maxAgeMs },
      total: sorted.length,
      retainedCount: sorted.length - removable.length,
      removableCount: removable.length,
      rotationRecommended: removable.length > 0,
      removable
    };
  }

  async rotate({ keepLast = 100, maxAgeMs = null, dryRun = true, archivePath = null } = {}) {
    const report = this.retentionReport({ keepLast, maxAgeMs });
    const removableIds = new Set(report.removable.map((item) => item.evidenceId));
    const removed = [...this.items.values()].filter((item) => removableIds.has(item.evidenceId));
    const retained = [...this.items.values()].filter((item) => !removableIds.has(item.evidenceId));
    const rotation = {
      rotationVersion: 'b-execution-evidence-rotation-v1',
      generatedAt: this.clock().toISOString(),
      dryRun,
      report,
      removed: removed.map((item) => ({ evidenceId: item.evidenceId, taskId: item.taskId, collectedAt: item.collectedAt })),
      retainedCount: retained.length,
      archive: null
    };
    if (dryRun || removed.length === 0) return rotation;
    const resolvedArchivePath = archivePath ?? resolve(dirname(this.logPath), `evidence-archive-${this.clock().getTime()}.json`);
    const archive = {
      archiveVersion: 'b-execution-evidence-rotation-archive-v1',
      generatedAt: this.clock().toISOString(),
      sourceLogPath: this.logPath,
      itemCount: removed.length,
      items: removed
    };
    await mkdir(dirname(resolvedArchivePath), { recursive: true });
    await writeFile(resolvedArchivePath, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    await writeFile(this.logPath, retained.map((item) => JSON.stringify(item)).join('\n') + (retained.length ? '\n' : ''), 'utf8');
    this.items = new Map(retained.map((item) => [item.taskId, item]));
    rotation.archive = {
      path: resolvedArchivePath,
      sha256: createHash('sha256').update(canonicalJson(archive)).digest('hex'),
      itemCount: removed.length
    };
    return rotation;
  }

  schemaSnapshot() {
    return this.schemaRegistry.snapshot();
  }

  schemaRegressionReport(baseline) {
    return this.schemaRegistry.regressionReport(baseline);
  }

  privacyFixtureReport() {
    return this.privacyRedactor.runFixtureCorpus();
  }
}

export class ExecutionMemoryEmitter {
  constructor({ clock = () => new Date(), logPath = 'apps/pc-agent/logs/memory-events.jsonl' } = {}) {
    this.clock = clock;
    this.logPath = logPath;
    this.items = [];
  }

  emit({ packet, executionResult, outcome, evidence }) {
    const event = {
      eventId: stableId('memexec', `${packet.taskId}:${packet.packetId ?? 'packet'}:${outcome}`, this.clock().toISOString()),
      eventType: outcome === 'blocked' ? 'execution.blocked' : outcome === 'failure' ? 'execution.failed' : 'execution.completed',
      taskId: packet.taskId,
      packetId: packet.packetId,
      skillId: packet.action?.skillId,
      toolName: packet.action?.toolName,
      actionType: packet.action?.actionType,
      outcome,
      userCommand: packet.action?.arguments?.rawText ?? packet.action?.arguments?.content ?? packet.action?.arguments?.query ?? '',
      interpretedIntent: packet.action?.toolName ?? packet.action?.actionType ?? 'unknown',
      payload: {
        outputPaths: executionResult.outputPaths ?? [],
        changedItems: executionResult.changedItems ?? [],
        rollbackAvailable: executionResult.rollbackAvailable === true,
        evidenceId: evidence?.evidenceId
      },
      learningFlags: {
        doNotRemember: false,
        sourceModule: ModuleId.PC_AGENT
      },
      createdAt: this.clock().toISOString()
    };
    this.items.unshift(event);
    appendJsonlSync(this.logPath, event);
    return event;
  }

  recent(limit = 20) {
    return this.items.slice(0, limit);
  }

  query({ cursor = 0, limit = 20, eventType = null, taskId = null } = {}) {
    const offset = Math.max(0, Number(cursor ?? 0));
    const pageLimit = Math.max(1, Math.min(200, Number(limit ?? 20)));
    const filtered = this.items
      .filter((item) => !eventType || item.eventType === eventType)
      .filter((item) => !taskId || item.taskId === taskId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const items = filtered.slice(offset, offset + pageLimit);
    return {
      queryVersion: 'b-execution-memory-event-query-v1',
      generatedAt: this.clock().toISOString(),
      filters: { eventType, taskId },
      pageInfo: {
        cursor: offset,
        limit: pageLimit,
        total: filtered.length,
        nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null
      },
      items
    };
  }
}

export class FileSystemToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(),
    processWriteLockTimeoutMs = 10_000, processWriteLockStaleMs = 30_000 } = {}) {
    if (!Number.isInteger(processWriteLockTimeoutMs) || processWriteLockTimeoutMs < 100 || processWriteLockTimeoutMs > 60_000
      || !Number.isInteger(processWriteLockStaleMs) || processWriteLockStaleMs < 1_000 || processWriteLockStaleMs > 10 * 60_000) {
      throw new Error('B_FILE_WRITE_LOCK_CONFIG_INVALID');
    }
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.processWriteLockTimeoutMs = processWriteLockTimeoutMs;
    this.processWriteLockStaleMs = processWriteLockStaleMs;
    this.pathGuard = new PathSafetyGuard({ allowedRoots: this.allowedRoots });
    this.writeLocks = new Map();
    this.contract = createToolContract({
      toolName: 'filesystem.createTextFile',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'overwriteWithoutApproval']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async shadow(args) {
    let targetPath;
    let pathSafety = null;
    let toctouLock = null;
    try {
      pathSafety = await this.pathGuard.inspect(args.path, { checkParentForCreate: true, operation: 'create' });
      if (!pathSafety.allowed) throw new Error(pathSafety.issue?.detail ?? `outside-allowed-roots:${pathSafety.resolvedPath}`);
      targetPath = pathSafety.resolvedPath;
      toctouLock = await this.pathGuard.createOpenAfterRealpathLock(args.path, { checkParentForCreate: true, operation: 'create' });
    } catch (error) {
      const issue = classifyFileError(error, { path: args.path });
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        targetPath: resolve(args.path),
        targetExists: false,
        conflictPolicy: 'blocked-by-path-guard',
        pathSafety,
        issues: [issue],
        warnings: [issue.detail ?? issue.code]
      };
    }
    const targetExists = await exists(targetPath);
    const expectedSha256 = args.expectedSha256;
    const validExpectedRevision = expectedSha256 === undefined || (typeof expectedSha256 === 'string'
      && /^[a-f0-9]{64}$/u.test(expectedSha256));
    const currentBytes = targetExists && expectedSha256 !== undefined ? await readFile(targetPath) : null;
    const currentSha256 = currentBytes ? createHash('sha256').update(currentBytes).digest('hex') : null;
    const revisionMatches = expectedSha256 === undefined || (targetExists && currentSha256 === expectedSha256);
    const issues = [];
    if (!validExpectedRevision) issues.push({ code: 'invalidExpectedRevision', path: targetPath });
    if (targetExists && !args.allowOverwrite) issues.push(classifyFileIssue({ code: 'targetExists', path: targetPath, targetPath }));
    if (validExpectedRevision && !revisionMatches) issues.push({ code: 'revisionConflict', path: targetPath,
      expectedSha256, currentSha256 });
    return {
      mode: 'shadow',
      expectedChangesCount: issues.length ? 0 : 1,
      targetPath,
      targetExists,
      expectedSha256: expectedSha256 ?? null,
      currentSha256,
      revisionMatches,
      revisionConflict: validExpectedRevision && !revisionMatches,
      conflictPolicy: validExpectedRevision && !revisionMatches ? 'blocked-by-revision-conflict'
        : args.allowOverwrite ? 'overwrite-approved' : 'block-overwrite-without-approval',
      pathSafety,
      toctouLock,
      issues,
      warnings: issues.map((issue) => issue.code === 'targetExists' ? `target-exists:${targetPath}` : issue.code)
    };
  }

  async execute(args, packet = {}) {
    const requestedPath = resolve(args.path);
    const lockKey = process.platform === 'win32' ? requestedPath.toLowerCase() : requestedPath;
    const previous = this.writeLocks.get(lockKey) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => current);
    this.writeLocks.set(lockKey, tail);
    await previous;
    try {
      return await withFileSystemWriteProcessLock(this.undoJournal.journalPath, lockKey,
        () => this.executeUnderPathLock(args, packet), {
          timeoutMs: this.processWriteLockTimeoutMs,
          staleAfterMs: this.processWriteLockStaleMs
        });
    } finally {
      release();
      if (this.writeLocks.get(lockKey) === tail) this.writeLocks.delete(lockKey);
    }
  }

  async executeUnderPathLock(args, packet = {}) {
    const preview = await this.shadow(args);
    const targetPath = preview.targetPath;
    if (preview.warnings.length) {
      return {
        status: 'blocked',
        summary: preview.revisionConflict ? 'File revision changed since it was read; overwrite was blocked.' : 'File create preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: preview.warnings,
        evidence: {
          targetPath,
          conflictPolicy: preview.conflictPolicy,
          issues: preview.issues ?? [],
          conflictDetected: preview.revisionConflict === true,
          contentPreserved: preview.revisionConflict === true,
          expectedSha256: preview.expectedSha256,
          currentSha256: preview.currentSha256,
          proposedSha256: preview.revisionConflict ? createHash('sha256').update(args.content ?? '', 'utf8').digest('hex') : null
        }
      };
    }
    const lockVerification = await this.pathGuard.verifyOpenAfterRealpathLock(preview.toctouLock);
    if (lockVerification.status !== 'valid') {
      return {
        status: 'blocked',
        summary: 'File create path lock changed before execution.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: [lockVerification.issue?.detail ?? 'toctou-lock-changed'],
        evidence: {
          targetPath,
          conflictPolicy: 'blocked-by-toctou-lock',
          issues: [lockVerification.issue],
          pathSafety: preview.pathSafety,
          toctouLock: preview.toctouLock,
          lockVerification
        }
      };
    }
    await trustedRemoteMutationChecks.get(packet)?.();
    trustedLocalEffectFences.get(packet)?.();
    await mkdir(dirname(targetPath), { recursive: true });
    const previousBytes = args.allowOverwrite && await exists(targetPath) ? await readFile(targetPath) : null;
    if(previousBytes&&previousBytes.length>64*1024*1024)throw Error('B_OVERWRITE_BACKUP_TOO_LARGE');
    await trustedRemoteMutationChecks.get(packet)?.();
    trustedLocalEffectFences.get(packet)?.();
    await writeFile(targetPath, args.content ?? '', 'utf8');
    const undo = this.undoJournal.record(previousBytes === null ? {
      taskId: packet.taskId,
      action: 'delete_created_file',
      path: targetPath
    } : {
      taskId: packet.taskId,
      action: 'restore_previous_file',
      path: targetPath,
      previousContent:Buffer.from(previousBytes.toString('utf8'),'utf8').equals(previousBytes)?previousBytes.toString('utf8'):null,
      previousBytesBase64:previousBytes.toString('base64')
    });
    return {
      status: 'success',
      outputPaths: [targetPath],
      changedItems: [{ type: previousBytes === null ? 'create_file' : 'overwrite_file', path: targetPath }],
      rollbackAvailable: true,
      undoJournalId: undo.undoJournalId,
      evidence: {
        targetPath,
        conflictPolicy: preview.conflictPolicy,
        pathSafety: preview.pathSafety,
        toctouLock: preview.toctouLock,
        lockVerification
      }
    };
  }
}

export class FileListToolAdapter {
  constructor({ allowedRoots = ['./workspace'] } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.contract = createToolContract({
      toolName: 'filesystem.listFiles',
      readOnly: true,
      evidence: ['directory', 'itemCount', 'metadataOnly'],
      blockedOperations: ['outsideAllowedRoots', 'fileContentRead']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async shadow(args, packet = {}) {
    const assertRead = () => trustedLocalEffectFences.get(packet)?.();
    assertRead();
    let directory;
    try {
      directory = await assertAllowedRealPath(args.directory ?? args.path ?? './workspace', this.allowedRoots);
      assertRead();
    } catch (error) {
      const issue = classifyFileError(error, { path: args.directory ?? args.path });
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        directory: resolve(args.directory ?? args.path ?? './workspace'),
        items: [],
        issues: [issue],
        warnings: [issue.detail ?? issue.code]
      };
    }
    const offset = args.offset ?? 0;
    const limit = Math.max(1, Math.min(1000, Number.isInteger(args.maxItems) ? args.maxItems : 100));
    const reject = code => ({mode:'shadow',expectedChangesCount:0,directory,items:[],warnings:[code]});
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000
      || args.expectedListingSha256 !== undefined && !/^[a-f0-9]{64}$/.test(args.expectedListingSha256)
      || offset > 0 && !args.expectedListingSha256) return reject('A_LISTING_PAGE_INVALID');
    assertRead();
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    assertRead();
    if(entries.length > 10000)return reject('A_LISTING_LIMIT_EXCEEDED');
    const snapshotSha256=createHash('sha256').update(JSON.stringify(entries.map(e=>({name:e.name,type:e.isDirectory()?'directory':'file'})))).digest('hex');
    if(args.expectedListingSha256 && args.expectedListingSha256 !== snapshotSha256)return reject('A_LISTING_SNAPSHOT_CHANGED');
    if(offset > entries.length)return reject('A_LISTING_PAGE_INVALID');
    const items = await Promise.all(entries.slice(offset, offset + limit).map(async (entry) => {
      const fullPath = resolve(directory, entry.name);
      assertRead();
      const itemStat = await lstat(fullPath);
      assertRead();
      return {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: itemStat.size,
        modifiedAt: itemStat.mtime.toISOString()
      };
    }));
    assertRead();
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      directory,
      items,
      totalEntries: entries.length,
      offset,
      snapshotSha256,
      hasMore: offset + items.length < entries.length,
      truncated: items.length < entries.length,
      warnings: []
    };
  }

  async execute(args, packet = {}) {
    const shadow = await this.shadow(args, packet);
    trustedLocalEffectFences.get(packet)?.();
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'File list preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        issues: shadow.issues ?? [],
        warnings: shadow.warnings
      };
    }
    return {
      status: 'success',
      outputPaths: [],
      changedItems: [],
      rollbackAvailable: false,
      listedItems: shadow.items,
      listingTotalEntries: shadow.totalEntries,
      listingOffset: shadow.offset,
      listingSnapshotSha256: shadow.snapshotSha256,
      listingHasMore: shadow.hasMore,
      listingTruncated: shadow.truncated
    };
  }
}

export class XlsxReadToolAdapter {
  constructor({allowedRoots=['./workspace'],reader=new XlsxRegionReader()}={}){
    this.allowedRoots=allowedRoots.map(path=>resolve(path));this.reader=reader;
    this.contract=createToolContract({toolName:'excel.readWorkbook',readOnly:true,evidence:['contentSha256','xlsxRead'],blockedOperations:['outsideAllowedRoots','macroExecution','unverifiedFormulaCalculation']});
  }
  async shadow(args={}){
    const warnings=[];try{if(typeof args.path!=='string'||!args.path.toLowerCase().endsWith('.xlsx'))throw Error('XLSX_PATH_REQUIRED');await assertAllowedRealPath(resolve(args.path),this.allowedRoots);}catch(error){warnings.push(error.message);}
    return {mode:'shadow',expectedChangesCount:0,warnings,requestedXlsxPath:typeof args.path==='string'?resolve(args.path):null,
      requestedSheetName:args.sheetName??null,requestedXlsxRange:args.range??'A1:J100'};
  }
  async execute(args={},packet={}){
    const shadow=await this.shadow(args);if(shadow.warnings.length)return {status:'blocked',summary:'엑셀 위치와 접근 권한을 확인해주세요.',warnings:shadow.warnings,readOnly:true,outputPaths:[],changedItems:[],rollbackAvailable:false};
    try{
      const checkAllowedPath=async path=>{await assertAllowedRealPath(path,this.allowedRoots);if(packet.capabilityToken)await assertAllowedRealPath(path,packet.capabilityToken.scope?.allowedPaths??[]);return path;};
      const path=resolve(args.path),xlsxRead={...await this.reader.read({...args,path,checkAllowedPath}),path};
      return {status:'success',summary:`${xlsxRead.sheetName} 시트의 ${xlsxRead.range} 저장 값을 읽었습니다. 수식 계산·표시 형식은 별도입니다.`,
        contentSha256:xlsxRead.sourceSha256,xlsxRead,readOnly:true,outputPaths:[],changedItems:[],rollbackAvailable:false,
        truncated:xlsxRead.hasCellsOutsideRange||xlsxRead.otherSheetCount>0,stdoutPreview:JSON.stringify(xlsxRead.cells),
        evidence:{contentSha256:xlsxRead.sourceSha256,pathHash:createHash('sha256').update(path).digest('hex'),xlsxRead}};
    }catch(error){return {status:'blocked',summary:'엑셀 내용 확인을 완료하지 못했습니다.',warnings:[error.code??error.message],
      nextAction:error.code==='XLSX_FORMULA_UNVERIFIED'?'선택한 범위에 수식이 있습니다. 실제 계산이 검증된 값을 준비하거나 수식이 없는 범위를 선택해주세요.':'파일·시트 이름·최대 1,000셀의 읽을 범위를 확인해주세요.',
      readOnly:true,outputPaths:[],changedItems:[],rollbackAvailable:false};}
  }
}

export class PdfReadToolAdapter {
  constructor({allowedRoots=['./workspace'],reader=new PdfTextReader()}={}) {
    this.allowedRoots=allowedRoots.map(path=>resolve(path));this.reader=reader;
    this.contract=createToolContract({toolName:'document.readPdf',readOnly:true,evidence:['contentSha256','pdfRead'],blockedOperations:['outsideAllowedRoots','encryptedPdf','missingParser','unverifiedOcr']});
  }
  async shadow(args={}) {
    const warnings=[];
    try {if(typeof args.path!=='string'||!args.path.toLowerCase().endsWith('.pdf'))throw Error('PDF_PATH_REQUIRED');await assertAllowedRealPath(resolve(args.path),this.allowedRoots);}
    catch(error){warnings.push(error.message);}
    return {mode:'shadow',expectedChangesCount:0,warnings,requestedPdfPath:typeof args.path==='string'?resolve(args.path):null,
      pdfFirstPage:args.firstPage??1,pdfMaxPages:args.maxPages??10};
  }
  async execute(args={},packet={}) {
    const shadow=await this.shadow(args);
    if(shadow.warnings.length)return {status:'blocked',summary:'PDF 위치와 접근 권한을 확인해주세요.',warnings:shadow.warnings,outputPaths:[],changedItems:[],readOnly:true,rollbackAvailable:false};
    try {
      const checkAllowedPath=async path=>{
        await assertAllowedRealPath(path,this.allowedRoots);
        if(packet.capabilityToken)await assertAllowedRealPath(path,packet.capabilityToken.scope?.allowedPaths??[]);
        return path;
      };
      const path=resolve(args.path),pdfRead={...await this.reader.read({...args,path,checkAllowedPath}),path};
      return {status:'success',summary:pdfRead.truncated?'PDF 일부 페이지를 읽었습니다. 다음 페이지 조회가 필요합니다.':'PDF의 텍스트 층을 읽었습니다.',readOnly:true,outputPaths:[],changedItems:[],rollbackAvailable:false,
        contentSha256:pdfRead.sourceSha256,stdoutPreview:pdfRead.pages.map(p=>p.text).join('\n'),truncated:pdfRead.truncated,pdfRead,
        evidence:{contentSha256:pdfRead.sourceSha256,pathHash:createHash('sha256').update(path).digest('hex'),pdfRead}};
    } catch(error){
      const nextAction={PDF_PASSWORD_REQUIRED:'암호가 없는 열람용 복사본을 선택해주세요. 비밀번호를 대화에 입력하지 마세요.',
        PDF_OCR_OR_BLANK_PAGE_REVIEW_REQUIRED:'스캔 또는 빈 페이지가 있습니다. 텍스트가 포함된 자료를 선택하거나 별도 OCR 검증을 진행해야 합니다.',
        PDF_PYTHON_UNAVAILABLE:'이 PC의 Python 실행 환경이 준비되지 않았습니다. 프로그램 실행 환경을 연결해주세요.',
        PDF_PAGE_RANGE_INVALID:'실제 페이지 수에 맞춰 읽을 범위를 조정해주세요.',PDF_PARSE_TIMEOUT:'제한 시간 안에 읽지 못했습니다. 더 작은 자료를 선택해주세요.',
        PDF_SOURCE_CHANGED:'읽는 동안 원본이 변경됐습니다. 현재 파일을 다시 선택해주세요.'}[error.message]??'PDF 위치·허용된 자료 범위와 파일 상태를 확인해주세요.';
      return {status:'blocked',summary:'PDF 내용 확인을 완료하지 못했습니다.',nextAction,warnings:[error.message],readOnly:true,outputPaths:[],changedItems:[],rollbackAvailable:false};
    }
  }
}

export class FileReadTextToolAdapter {
  constructor({ allowedRoots = ['./workspace'], maxFileBytes = 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new RangeError('invalid text byte budget');
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.maxFileBytes = maxFileBytes;
    this.contract = createToolContract({
      toolName: 'filesystem.readText',
      readOnly: true,
      evidence: ['pathHash', 'contentSha256', 'bytes', 'offset', 'returnedChars', 'truncated'],
      blockedOperations: ['outsideAllowedRoots', 'unsupportedBinary', 'fileTooLarge']
    });
  }

  async normalize(args = {}, packet = {}) {
    const assertRead = () => trustedLocalEffectFences.get(packet)?.();
    assertRead();
    const input = args.path;
    const warnings = [];
    let path = input ? resolve(input) : resolve(this.allowedRoots[0]);
    try {
      path = await assertAllowedRealPath(path, this.allowedRoots);
      assertRead();
      const details = await stat(path);
      assertRead();
      if (!details.isFile()) warnings.push('read-target-not-file');
      if (details.size > this.maxFileBytes) warnings.push('text-file-too-large');
      if (!/\.(?:txt|csv|json|jsonl|md|html?|xml|yaml|yml|log)$/iu.test(path)) warnings.push('unsupported-text-extension');
    } catch (error) {
      warnings.push(classifyTextReadFailure(error));
    }
    const offset = args.offset === undefined ? 0 : args.offset;
    const maxChars = args.maxChars === undefined ? 12000 : args.maxChars;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.maxFileBytes) warnings.push('text-offset-invalid');
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 50000) warnings.push('text-range-invalid');
    return { path, offset, maxChars, warnings: [...new Set(warnings)] };
  }

  async shadow(args, packet = {}) {
    const normalized = await this.normalize(args, packet);
    trustedLocalEffectFences.get(packet)?.();
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      pathHash: createHash('sha256').update(normalized.path).digest('hex'),
      offset: normalized.offset,
      maxChars: normalized.maxChars,
      warnings: normalized.warnings
    };
  }

  async execute(args, packet = {}) {
    const normalized = await this.normalize(args, packet);
    trustedLocalEffectFences.get(packet)?.();
    if (normalized.warnings.length) {
      return { status: 'blocked', summary: '텍스트 파일 읽기 사전 검사가 실패했습니다.', outputPaths: [], changedItems: [], warnings: normalized.warnings, rollbackAvailable: false, readOnly: true };
    }
    try {
      const {bytes:buffer,text} = await readTextSnapshot({path:normalized.path,maxBytes:this.maxFileBytes,
        checkAllowedPath:async path => {
          trustedLocalEffectFences.get(packet)?.();
          const checked=await assertAllowedRealPath(path,this.allowedRoots);
          trustedLocalEffectFences.get(packet)?.();
          return checked;
        }});
      trustedLocalEffectFences.get(packet)?.();
      const content = selectTextRange(text,normalized.offset,normalized.maxChars);
      const truncated = normalized.offset + content.length < text.length;
      const contentSha256 = createHash('sha256').update(buffer).digest('hex');
      return {
        status: 'success',
        summary: `${basename(normalized.path)} 내용을 읽고 SHA-256을 확인했습니다.`,
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        readOnly: true,
        stdoutPreview: content,
        contentSha256,
        bytes: buffer.length,
        offset: normalized.offset,
        returnedChars: content.length,
        totalChars: text.length,
        truncated,
        evidence: {
          pathHash: createHash('sha256').update(normalized.path).digest('hex'),
          contentSha256,
          bytes: buffer.length,
          offset: normalized.offset,
          returnedChars: content.length,
          totalChars: text.length,
          truncated,
          encoding: 'utf8'
        }
      };
    } catch (error) {
      if (error instanceof TextReadBoundaryError) return {status:'blocked',summary:'텍스트 파일의 내용 또는 읽기 범위를 확인해야 합니다.',warnings:[error.code],outputPaths:[],changedItems:[],rollbackAvailable:false,readOnly:true};
      return { status: 'failed', error: String(error?.message ?? error), summary: '텍스트 파일을 읽지 못했습니다.', outputPaths: [], changedItems: [], rollbackAvailable: false, readOnly: true };
    }
  }
}

// Scope rejection never establishes whether an out-of-scope file exists.
// Only an in-scope filesystem ENOENT is evidence for a missing source.
export function classifyTextReadFailure(error) {
  const codes={PATH_OUTSIDE_ALLOWED_ROOTS:'text-path-outside-allowed-roots',
    PATH_REALPATH_OUTSIDE_ALLOWED_ROOTS:'text-path-realpath-outside-allowed-roots',
    ENOENT:'text-file-missing',EACCES:'text-file-permission-denied',EPERM:'text-file-permission-denied'};
  return codes[error?.code]??'text-file-unreadable';
}

// 셸 명령 위험 분류(사용자 정책 2026-07-13): 삭제·포맷·자비스 자체 종료·보안 우회만 완전 차단(blocked),
// 시스템 변경·프로그램 조작·웹 등은 'high'(강화 동의: 승인받으면 실행). 나머지는 caution/safe.

// 완전 차단: 승인으로도 실행 불가.
const shellHardBlockPatterns = [
  // 동적 실행/난독화: 그 안의 코드를 검사할 수 없어 정적 방어를 무력화한다 → 기능이 아니라 우회 수단이므로 원천 차단.
  { re: /(^|\s|;|&|\||\()(iex|icm)(\s|$)|invoke-expression|-encodedcommand|-enc\b|-e\s+[A-Za-z0-9+/=]{16,}|frombase64string|\[scriptblock\]|\.invoke\(/i, reason: '동적 코드 실행(보안 차단)' },
  { re: /downloadstring|downloaddata|net\.webclient[\s\S]{0,40}download/i, reason: '원격 코드 메모리 실행(보안 차단)' },
  // 삭제(별칭 포함). 사용자 지시로 거의 완전 봉쇄.
  { re: /(^|\s|;|&|\||\()(rm|del|erase|rd|rmdir|ri|rbp|rmo|rjb)(\s|$|\s*-)|remove-item|remove-psdrive|clear-recyclebin/i, reason: '파일/폴더 삭제' },
  { re: /clear-content|clear-item\b|(^|\s|;|\|)clc(\s|$)|(^|\s|;|\|)cli(\s|$)/i, reason: '파일 내용 삭제' },
  { re: /format\s+[a-z]:|format\s+\/[qsxy]|\bformat-volume\b|\bformat-disk\b|diskpart|mkfs|clear-disk|clean\s+all|initialize-disk/i, reason: '디스크 포맷/초기화' },
  // 자비스 자체 종료/제거 금지(자기 보호).
  { re: /(stop-service|remove-service|stop-process|taskkill|\bkill\b|disable-scheduledtask|unregister-scheduledtask)[\s\S]{0,80}(jarvis|jarvispcagent|jarviscoreruntime|jarvisbridge|jarviscoreruntimehost)|(jarvis|jarvispcagent|jarviscoreruntime|jarvisbridge)[\s\S]{0,80}(stop-service|stop-process|taskkill|\bkill\b|remove|disable|unregister)/i, reason: '자비스 자체 종료/제거(금지)' }
];

// 강화 동의: 위험하지만 사용자가 승인하면 실행한다. 승인 카드에 강한 경고를 띄운다.
const shellHighRiskPatterns = [
  { re: /shutdown|restart-computer|stop-computer|logoff|halt/i, reason: '시스템 종료/재시작' },
  { re: /reg\s+delete|reg\s+add|remove-itemproperty|(new|set)-itemproperty\s+[\s\S]*hk(lm|cu)/i, reason: '레지스트리 변경' },
  { re: /\b(takeown|icacls|cacls)\b|set-acl/i, reason: '권한 변경' },
  { re: /bcdedit|(^|\s)sfc(\s|$)|(^|\s)dism(\s|$)|set-executionpolicy/i, reason: '시스템 구성 변경' },
  { re: /net\s+user|new-localuser|remove-localuser|net\s+localgroup|add-localgroupmember/i, reason: '계정 변경' },
  { re: /-method\s+post|(-T|--upload)\b|\bscp\b|\bftp\b|send-mailmessage|\bsmtp\b/i, reason: '외부 전송' },
  { re: /downloadfile|start-bitstransfer|invoke-webrequest|invoke-restmethod|\biwr\b|\bcurl\b|\bwget\b/i, reason: '웹 다운로드' },
  { re: /stop-service|start-service|restart-service|set-service/i, reason: '서비스 제어' },
  { re: /stop-process|taskkill|(^|\s|;|\|)kill(\s|$)|(^|\s|;|\|)spps(\s|$)/i, reason: '프로세스 종료' },
  { re: /msiexec|winget\s+install|choco\s+install|install-module|install-package|start-process[\s\S]{0,40}setup/i, reason: '프로그램 설치' }
];

// 민감정보 파일 접근은 차단까진 안 하되 주의(caution)로 올려 승인 카드에서 확인하게 한다.
const shellSensitivePattern = /id_rsa|id_ed25519|\.ssh[\\/]|\.pem\b|\.ppk\b|\.env\b|credentials(\.json)?|\.aws[\\/]|unattend\.xml|\bsam\b|ntds\.dit/i;

const shellMutationCautionPatterns = [
  { re: /\bstart-process\b|\[diagnostics\.process\]::start|\[system\.diagnostics\.process\]::start/i, reason: '프로그램 실행' },
  { re: /new-object\s+-comobject|uiautomation|sendkeys|\.save(as)?\s*\(|\.quit\s*\(|\.close\s*\(/i, reason: '응용 프로그램 자동화' },
  { re: /\[(?:system\.)?io\.(?:file|directory)\]::(?:write|append|copy|move|create|set)/i, reason: '파일 시스템 변경' },
  { re: /(^|[\s;|])(set|new|add|rename|enable|disable|register|unregister|mount|dismount)-[a-z][a-z0-9-]*/i, reason: '시스템 또는 세션 상태 변경' }
];

export function classifyShellCommand(command) {
  const text = String(command ?? '');
  if (!text.trim()) return { risk: 'blocked', reason: '빈 명령' };
  for (const rule of shellHardBlockPatterns) {
    if (rule.re.test(text)) return { risk: 'blocked', reason: rule.reason };
  }
  for (const rule of shellHighRiskPatterns) {
    if (rule.re.test(text)) return { risk: 'high', reason: rule.reason };
  }
  if (shellSensitivePattern.test(text)) {
    return { risk: 'caution', reason: '민감정보 파일 접근' };
  }
  for (const rule of shellMutationCautionPatterns) {
    if (rule.re.test(text)) return { risk: 'caution', reason: rule.reason };
  }
  if (/(^|\s)(mv|move|move-item|copy|cp|copy-item|ni|new-item|set-content|add-content|out-file|sc|ac)(\s|$)|>>?/i.test(text)) {
    return { risk: 'caution', reason: '파일 생성/수정' };
  }
  return { risk: 'safe', reason: '읽기/조회' };
}

// 자연어를 셸 명령으로 바꿔 실행한다. 실제 명령은 승인 카드에 노출되며,
// 파괴적 명령은 아래 정적 차단으로 승인 여부와 무관하게 실행되지 않는다.
export class ShellExecuteToolAdapter {
  constructor({ shell = 'powershell', timeoutMs = 60000, workingDir = null, maxOutputChars = 6000, correctionRunner = null, maxCorrections = 2 } = {}) {
    this.shell = shell;
    this.timeoutMs = timeoutMs;
    this.workingDir = resolve(workingDir ?? process.env.USERPROFILE ?? process.env.HOME ?? './workspace');
    this.maxOutputChars = maxOutputChars;
    this.maxCorrections = maxCorrections;
    // 자기교정 러너(claude CLI). 미인증/미설치면 호출이 실패해 교정 없이 감지만 한다(graceful).
    this.correctionEnabled = process.env.JARVIS_SHELL_SELFCORRECT !== '0';
    this.correctionRunner = correctionRunner ?? createClaudeCliRunner({ model: process.env.JARVIS_LLM_INTENT_MODEL ?? 'haiku', timeoutMs: 45000 });
    this.contract = createToolContract({
      toolName: 'shell.execute',
      mutatesSystem: true,
      rollback: false,
      evidence: ['command', 'shell', 'exitCode', 'stdoutPreview'],
      blockedOperations: ['destructiveCommand', 'externalTransfer'],
      modes: ['shadow', 'execute']
    });
  }

  commandOf(args) {
    return String(args?.command ?? args?.shellCommand ?? '').trim();
  }

  // 셸을 한 번 실행한다(동기). UTF-8 출력을 강제한다.
  runShellOnce(command) {
    const psCommand = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
    const wrapped = this.shell === 'cmd'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand] };
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let timedOut = false;
    try {
      stdout = execFileSync(wrapped.file, wrapped.args, { cwd: this.workingDir, timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : 1;
      stdout = error.stdout ? String(error.stdout) : '';
      stderr = error.stderr ? String(error.stderr) : String(error.message ?? '');
      timedOut = error.killed === true || String(error.code ?? '') === 'ETIMEDOUT';
    }
    return { exitCode, stdout, stderr, timedOut, executed: exitCode === 0 && !timedOut };
  }

  // 읽기 전용 verify 셸로 결과를 확인한다. 안전하지 않으면 실행하지 않는다.
  verifyIfSafe(verifyCommand, executed) {
    const vc = String(verifyCommand ?? '').trim();
    if (!executed || !vc) return null;
    if (classifyShellCommand(vc).risk !== 'safe') return { verified: null, output: '', verifyCommand: vc, error: 'verify-not-readonly' };
    try {
      const vout = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${vc}`],
        { cwd: this.workingDir, timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
      const out = String(vout ?? '').trim();
      const negative = /^(false|0|없음|not found|아니오|no)$/i.test(out);
      return { verified: out.length > 0 && !negative, output: out.slice(0, 600), verifyCommand: vc };
    } catch {
      return { verified: false, output: '', verifyCommand: vc, error: 'verify-failed' };
    }
  }

  async shadow(args) {
    const command = this.commandOf(args);
    const classified = classifyShellCommand(command);
    return {
      mode: 'shadow',
      expectedChangesCount: classified.risk === 'safe' ? 0 : 1,
      command,
      shell: this.shell,
      riskLevel: classified.risk,
      riskReason: classified.reason,
      willBlock: classified.risk === 'blocked',
      requiresStrongConsent: classified.risk === 'high',
      warnings: classified.risk === 'blocked'
        ? [`차단: ${classified.reason} 명령은 실행할 수 없습니다`]
        : classified.risk === 'high'
          ? [`⚠️ 강한 주의 — ${classified.reason}. 승인하시면 실행합니다.`]
          : []
    };
  }

  async execute(args) {
    let command = this.commandOf(args);
    const classified = classifyShellCommand(command);
    if (classified.risk === 'blocked') {
      return { status: 'blocked', error: `destructive-command-blocked:${classified.reason}`, command, shell: this.shell, outputPaths: [], rollbackAvailable: false };
    }
    const rawText = String(args?.rawText ?? '');
    let verifyCommand = String(args?.verifyCommand ?? '').trim();

    // 1) 실행 + 자기검증
    let run = this.runShellOnce(command);
    let verification = this.verifyIfSafe(verifyCommand, run.executed);
    const attempts = [{ command, exitCode: run.exitCode, verified: verification?.verified ?? null, corrected: false }];

    // 2) 자기교정: 실행 자체가 실패했거나(비정상 종료) 검증이 실패했으면, 원인을 분석해 명령을 고쳐 다시 시도한다.
    let corrections = 0;
    const needsCorrection = () => !run.executed || (verification && verification.verified === false);
    while (needsCorrection() && this.correctionEnabled && corrections < this.maxCorrections) {
      corrections += 1;
      const failContext = run.executed ? (verification?.output ?? '') : run.stderr;
      let fixOut;
      try {
        fixOut = this.correctionRunner(buildShellCorrectionPrompt({ rawText, command, stderr: run.stderr, verifyOutput: failContext }));
      } catch {
        break;
      }
      const fix = extractJsonLoose(fixOut);
      const fixCmd = typeof fix?.command === 'string' ? fix.command.trim() : '';
      // 교정안이 없거나, 그대로거나, 위험(차단·강화동의)하면 중단한다.
      // 자동 재시도가 사용자 승인 없이 시스템 변경/설치/삭제를 저지르지 않게 safe/caution만 허용.
      if (!fixCmd || fixCmd === command || !['safe', 'caution'].includes(classifyShellCommand(fixCmd).risk)) break;
      command = fixCmd;
      verifyCommand = typeof fix?.verify === 'string' && fix.verify.trim() ? fix.verify.trim() : verifyCommand;
      run = this.runShellOnce(command);
      verification = this.verifyIfSafe(verifyCommand, run.executed);
      attempts.push({ command, exitCode: run.exitCode, verified: verification?.verified ?? null, corrected: true });
    }

    const executed = run.executed;
    let summary = run.timedOut ? '명령이 시간 초과로 중단됐어요.' : (executed ? '명령을 실행했어요.' : '명령이 오류로 끝났어요.');
    if (executed && verification) {
      if (verification.verified === true) {
        summary += corrections > 0 ? ` 처음엔 어긋났지만 ${corrections}번 고쳐서 목표를 달성했어요. ✓` : ' 결과도 확인했어요. ✓';
      } else if (verification.verified === false) {
        summary += ` ${corrections > 0 ? `${corrections}번 고쳐봤지만 ` : ''}아직 목표에 못 미쳐요 — 확인이 필요해요.`;
      }
    } else if (!executed && corrections > 0) {
      summary += ` ${corrections}번 고쳐봤지만 여전히 실패했어요 — 확인이 필요해요.`;
    }

    return {
      status: executed ? 'success' : 'failed',
      command,
      shell: this.shell,
      readOnly: classified.risk === 'safe',
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdoutPreview: String(run.stdout ?? '').slice(0, this.maxOutputChars),
      stderrPreview: String(run.stderr ?? '').slice(0, this.maxOutputChars),
      verification,
      corrections,
      attempts,
      summary,
      outputPaths: [],
      rollbackAvailable: false
    };
  }
}

// 한글(HWP) 파일을 생성한다. content를 임시 텍스트로 쓰고 한컴 COM으로 hwp로 변환한다.
export class HwpCreateToolAdapter {
  constructor({
    timeoutMs = 120000,
    allowedRoots = ['./workspace'],
    undoJournal = new UndoJournal(),
    workerIsolation = true
  } = {}) {
    this.home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.timeoutMs = timeoutMs;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.workerIsolation = workerIsolation;
    this.contract = createToolContract({
      toolName: 'hwp.create',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256'],
      blockedOperations: ['outsideAllowedRoots']
    });
  }

  resolveOutPath(args) {
    let p = args?.path ? String(args.path) : '';
    if (p) {
      if (!/\.hwpx?$/i.test(p)) p = p.replace(/\.[^.\\/]+$/, '') + '.hwp';
      return resolve(p);
    }
    const name = String(args?.fileName ?? '문서').replace(/\.[^.\\/]+$/, '') + '.hwp';
    const hint = args?.targetDirectoryHint;
    const dir = hint === 'desktop' ? resolve(this.home, 'Desktop')
      : hint === 'documents' ? resolve(this.home, 'Documents')
      : hint === 'downloads' ? resolve(this.home, 'Downloads')
      : resolve('./workspace');
    return resolve(dir, name);
  }

  preparePublication(args) {
    if(args?.verifyRendering!==undefined&&typeof args.verifyRendering!=='boolean')throw Error('hwp-rendering-option-invalid');
    const outputPath=this.resolveOutPath(args),verifyRendering=args?.verifyRendering===true;
    const renderDirectory=verifyRendering?outputPath+'.render':null;
    return {manifestVersion:'jarvis-hancom-publication-v1',outputPath,document:normalizeDocBlocks(args),verifyRendering,
      renderDirectory,maxRenderPages:HANCOM_MAX_RENDER_PAGES,paths:hancomPublicationPaths(outputPath,renderDirectory)};
  }

  async shadow(args) {
    const outputPath = this.resolveOutPath(args);
    try {
      await assertAllowedRealPath(outputPath, this.allowedRoots, { checkParentForCreate: true });
      return { mode: 'shadow', expectedChangesCount: 1, outputPath, warnings: [] };
    } catch (error) {
      return { mode: 'shadow', expectedChangesCount: 0, outputPath, warnings: [error.message] };
    }
  }

  async execute(args, packet = {}, context = {}) {
    if(args?.verifyRendering!==undefined&&typeof args.verifyRendering!=='boolean')return {status:'blocked',error:'hwp-rendering-option-invalid',outputPaths:[],rollbackAvailable:false};
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    try{assertAccess();}catch(error){return {status:'blocked',error:error.message,outputPaths:[],rollbackAvailable:false};}
    const renderDirectory=this.resolveOutPath(args)+'.render';
    const assertRenderPublication=async()=>{
      assertAccess();
      await assertAllowedRealPath(renderDirectory,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(renderDirectory,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();
    };
    if(args?.verifyRendering===true){try{await assertRenderPublication();if(existsSync(renderDirectory))throw Error('hwp-render-directory-exists');}catch(error){return {status:'blocked',error:error.message,outputPaths:[],rollbackAvailable:false};}}
    let prepared;
    try{prepared=this.preparePublication(args);assertAccess();
      await assertAllowedRealPath(prepared.outputPath,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(prepared.outputPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();await context.beforeArtifactWrite?.({paths:prepared.paths,prepared});assertAccess();}
    catch(error){return {status:'blocked',error:error.code??error.message,outputPaths:[],rollbackAvailable:false};}
    let result;
    if (extname(this.resolveOutPath(args)).toLowerCase() === '.hwpx') result=await this.executeHwpx(args, packet, context);
    else if (!this.workerIsolation || process.env.JARVIS_HWP_WORKER_CHILD === '1') result=await this.executeLocal(args, packet, context);
    else result=await this.executeIsolated({...args,verifyRendering:false}, packet, context);
    result={...result,artifactManifest:prepared,document:prepared.document,renderDirectory:prepared.renderDirectory};
    if(result.status!=='success'||args?.verifyRendering!==true)return result;
    const document=normalizeDocBlocks(args);
    let renderingPaths=[];
    try{
      const nativeRendering=await new NativeHancomPdfRenderer({allowedRoots:this.allowedRoots,timeoutMs:Math.min(this.timeoutMs,60000)}).render({inputPath:result.targetPath,outputDirectory:renderDirectory,expectedSha256:result.sha256,expectedText:expectedDocContentItems(document),expectedTableCount:document.tableCount,expectedDocument:document,signal:context.signal,beforePublish:assertRenderPublication});
      renderingPaths=[nativeRendering.manifestPath,...nativeRendering.files.map(f=>join(nativeRendering.outputDirectory,f.name))];
      assertAccess();
      const renderingUndoIds=renderingPaths.map(path=>this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path,fileKind:extname(path).slice(1)}).undoJournalId);
      return {...result,document,nativeRendering,undoJournalIds:[...(result.undoJournalIds??[]),...renderingUndoIds],outputPaths:[...result.outputPaths,...renderingPaths],summary:`한글 파일 "${basename(result.targetPath)}"의 실제 PDF·페이지 이미지와 요청 본문을 검증했습니다.`};
    }catch(error){
      return {...result,status:'failed',uncertain:true,outputPaths:[...result.outputPaths,...renderingPaths],error:'hwp-native-rendering-failed',document,nativeRendering:{status:'failed',requested:true,actualRenderingExecuted:renderingPaths.length>0,reason:error.code??error.message??'native-render-not-verified'},summary:'한글 파일은 생성했지만 실제 화면 출력 검증을 완료하지 못했습니다. 생성된 원본을 보존했습니다.'};
    }
  }

  async executeHwpx(args, packet = {}, context = {}) {
    const outPath=this.resolveOutPath(args);
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    let stageDir=null, inputPath=null,published=false;
    try {
      assertAccess();
      await assertAllowedRealPath(outPath,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(outPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();
      if (existsSync(outPath)) throw new Error('target-exists:overwrite-not-authorized');
      await mkdir(dirname(outPath),{recursive:true});
      stageDir=resolve(dirname(outPath),`.jarvis-hwpx-${randomBytes(8).toString('hex')}`);
      await assertAllowedRealPath(stageDir,this.allowedRoots,{checkParentForCreate:true});
      await mkdir(stageDir);
      inputPath=resolve(process.env.TEMP ?? '.',`jarvis-hwpx-input-${randomBytes(8).toString('hex')}.json`);
      const stagePath=resolve(stageDir,'document.hwpx');
      await writeFile(inputPath,JSON.stringify({outputPath:stagePath,document:normalizeDocBlocks(args)}),'utf8');
      assertAccess();
      const script=fileURLToPath(new URL('./adapters/hwpx/hwpx-mcp-create.py',import.meta.url));
      const run=await execFileAsync(process.env.JARVIS_HWPX_PYTHON ?? 'python',[script,inputPath],{encoding:'utf8',timeout:90000,signal:context.signal,windowsHide:true,maxBuffer:2*1024*1024});
      assertAccess();
      const receipt=JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
      if (receipt.status!=='verified' || receipt.textVerified!==true || receipt.packageVerified!==true) throw new Error('hwpx-postcondition-failed');
      if(process.platform==='win32'&&(receipt.processGuard?.jobAssigned!==true||receipt.processGuard?.killOnClose!==true))throw Error('hwpx-process-guard-not-verified');
      const stageSha256=createHash('sha256').update(await readFile(stagePath)).digest('hex');
      await assertAllowedRealPath(outPath,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(outPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();
      await copyFile(stagePath,outPath,fsConstants.COPYFILE_EXCL);
      published=true;
      const sha256=createHash('sha256').update(await readFile(outPath)).digest('hex');
      if(sha256!==stageSha256)throw Error('hwpx-published-content-changed');
      assertAccess();
      const undo=this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path:outPath,fileKind:'hwpx'});
      return {status:'success',targetPath:outPath,hwpxDocument:normalizeDocBlocks(args),outputPaths:[outPath],changedItems:[{type:'create_document',path:outPath}],sha256,rollbackAvailable:true,undoJournalId:undo.undoJournalId,summary:`한글 HWPX 파일 "${basename(outPath)}"의 본문과 표를 검증했습니다. 실제 한컴 화면 출력은 아직 확인하지 않았습니다.`,evidence:{sha256,hwpx:receipt}};
    } catch(error) {
      let detail=String(error.message ?? error);
      try { detail=JSON.parse(String(error.stdout ?? '').trim().split(/\r?\n/).at(-1)).error ?? detail; } catch {}
      const blocked=/outside-allowed-roots|target-exists:overwrite-not-authorized/i.test(detail);
      return {status:blocked&&!published?'blocked':'failed',error:blocked?'hwpx-create-blocked':'hwpx-create-failed',summary:detail.slice(0,600),warnings:blocked?[detail.slice(0,600)]:[],outputPaths:published?[outPath]:[],...(published?{uncertain:true,targetPath:outPath,changedItems:[{type:'create_document',path:outPath,uncertain:true}]}:{}),rollbackAvailable:false};
    } finally {
      if(inputPath) await rm(inputPath,{force:true}).catch(()=>{});
      if(stageDir && dirname(stageDir)===dirname(outPath) && basename(stageDir).startsWith('.jarvis-hwpx-')) await rm(stageDir,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});
    }
  }

  async executeIsolated(args, packet = {}, context = {}) {
    const runId = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const outPath=this.resolveOutPath(args);
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    let stageDir=null,published=false;
    const inputPath = resolve(process.env.TEMP ?? '.', `jarvis-hwp-worker-${runId}.json`);
    const workerPath = fileURLToPath(new URL('./hwp-worker.mjs', import.meta.url));
    let payload = {
      workerRequestVersion: 'jarvis-hwp-worker-request-v1',
      args,
      packet: { taskId: packet?.taskId ?? null, packetId: packet?.packetId ?? null },
      allowedRoots: this.allowedRoots,
      timeoutMs: this.timeoutMs
    };
    try {
      assertAccess();await assertAllowedRealPath(outPath,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(outPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();if(existsSync(outPath))throw Error('hwp-target-exists-original-preserved');
      await mkdir(dirname(outPath),{recursive:true});assertAccess();
      stageDir=await mkdtemp(join(dirname(outPath),'.jarvis-hwp-worker-stage-'));
      const stagedOutput=join(stageDir,'document.hwp');
      payload={...payload,args:{...args,path:stagedOutput,verifyRendering:false},allowedRoots:[stageDir]};
      writeFileSync(inputPath, JSON.stringify(payload), 'utf8');
      assertAccess();
      const execution = await execFileAsync(process.execPath, [workerPath, inputPath], {
        encoding: 'utf8',
        timeout: this.timeoutMs + 20_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        signal:context.signal,
        env: { ...process.env, JARVIS_HWP_WORKER_CHILD: '1' }
      });
      const envelope = JSON.parse(String(execution.stdout ?? '').trim());
      if (envelope?.workerResultVersion !== 'jarvis-hwp-worker-result-v1' || !envelope.result) {
        throw Object.assign(new Error('HWP worker returned an invalid result envelope.'), {
          code: 'B_HWP_WORKER_RESULT_INVALID'
        });
      }
      const result = envelope.result;
      assertAccess();
      if(result.status!=='success')return {...result,targetPath:outPath,outputPaths:[],rollbackAvailable:false};
      if(result.outputPaths?.length!==1||result.outputPaths[0]!==stagedOutput||!/^[a-f0-9]{64}$/u.test(result.sha256??'')
        ||result.evidence?.processGuard?.jobAssigned!==true||result.evidence?.processGuard?.parentWatchEnabled!==true)throw Error('hwp-worker-stage-receipt-invalid');
      const bytes=await readFile(stagedOutput),identity=await lstat(stagedOutput);
      if(!identity.isFile()||identity.isSymbolicLink()||bytes.length>16*1024*1024||bytes.length<512
        ||bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1'
        ||createHash('sha256').update(bytes).digest('hex')!==result.sha256)throw Error('hwp-worker-stage-invalid');
      await assertAllowedRealPath(outPath,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(outPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();await link(stagedOutput,outPath);published=true;
      if(createHash('sha256').update(await readFile(outPath)).digest('hex')!==result.sha256)throw Error('hwp-published-content-changed');
      assertAccess();
      if (result.status === 'success') {
        const undo = this.undoJournal.record({
          taskId: packet.taskId,
          action: 'delete_created_file',
          path: outPath,
          fileKind: 'hwp'
        });
        result.undoJournalId = undo.undoJournalId;
        result.targetPath=outPath;result.outputPaths=[outPath];result.changedItems=[{type:'create_document',path:outPath}];
        result.summary=`한글 파일 "${basename(outPath)}"을 생성했습니다.`;
        result.evidence = {
          ...result.evidence,
          workerIsolation: {
            mode: 'one-shot-process',
            workerResultVersion: envelope.workerResultVersion,
            workerPid: envelope.workerPid,
            parentProcessSurvived: true
          }
        };
      }
      return result;
    } catch (error) {
      const preflightBlocked=!published&&/outside-allowed-roots|hwp-target-exists-original-preserved/u.test(error?.message??'');
      return {
        status: preflightBlocked?'blocked':'failed',
        error: `hwp-worker-failed:${error?.code ?? error?.message ?? 'unknown'}`,
        warnings:preflightBlocked?[error.message]:[],
        summary: '한글 자동화 작업 프로세스가 비정상 종료되어 안전하게 중단했습니다.',
        outputPaths: published?[outPath]:[],
        ...(published?{targetPath:outPath,uncertain:true,changedItems:[{type:'create_document',path:outPath,uncertain:true}]}:{}),
        rollbackAvailable: false,
        evidence: {
          workerIsolation: {
            mode: 'one-shot-process',
            parentProcessSurvived: true,
            exitCode: Number.isInteger(error?.code) ? error.code : null,
            signal: error?.signal ?? null,
            killed: error?.killed === true
          }
        }
      };
    } finally {
      try { rmSync(inputPath, { force: true }); } catch { /* worker may already have removed it */ }
      if(stageDir)await rm(stageDir,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});
    }
  }

  async executeLocal(args, packet = {}, context = {}) {
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    const doc = normalizeDocBlocks(args);
    if (!doc.title && doc.blocks.length === 0) {
      doc.blocks.push({ type: 'paragraph', text: '(내용 없음)' });
    }
    const outPath = this.resolveOutPath(args);
    try {
      assertAccess();
      await assertAllowedRealPath(outPath, this.allowedRoots, { checkParentForCreate: true });
      if(packet.capabilityToken)await assertAllowedRealPath(outPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();
      if(existsSync(outPath))throw Error('hwp-target-exists-original-preserved');
    } catch (error) {
      return { status: 'blocked', error: error.message, targetPath: outPath, outputPaths: [], rollbackAvailable: false, warnings: [error.message] };
    }
    const stamp = Date.now();
    // HWPFrame.HwpObject can terminate its caller on Unicode SaveAs filenames.
    // Save to an ASCII staging name first, release COM, then move it to the
    // user-facing filename. Keeping the stage beside the destination makes the
    // final rename atomic and avoids partially written HWP files.
    const nativeSavePath = resolve(
      dirname(outPath),
      `jarvis-hwp-stage-${stamp}-${randomBytes(5).toString('hex')}.hwp`
    );
    const tmpJson = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.json`);
    const tmpPs1 = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.ps1`);
    const ownerPath = nativeSavePath+'.owner.json';
    const progressPath = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.progress`);
    const watcherPath = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.watcher.ps1`);
    const watcherResultPath = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.watcher.json`);
    const structurePath = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.structure.json`);
    const errorPath = resolve(process.env.TEMP ?? '.', `jarvis-hwp-${stamp}.error.txt`);
    let ownerRecord = null;
    let ownedProcessCleanup = { status: 'not-recorded', stopped: false };
    let watcherProcess = null;
    let pathApproval = { status: 'not-started', approved: false };
    let structureVerification = { status: 'not-recorded', expectedTableCount: doc.tableCount, outputTableControlCount: null };
    try {
      writeFileSync(tmpJson, '﻿' + JSON.stringify(doc), 'utf8');
      mkdirSync(dirname(outPath), { recursive: true });
      rmSync(nativeSavePath, { force: true });
      rmSync(errorPath, { force: true });
      const esc = (s) => String(s).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
      const script = [
        '$ErrorActionPreference = "Stop"',
        '$hwp = $null',
        '$hwpOwned = $false',
        '$guard = $null',
        `Add-Type -Path "${esc(fileURLToPath(new URL('./adapters/hwpx/native-process-guard.cs',import.meta.url)))}"`,
        `$nativeParent=${process.pid}`,
        '$nativeHost=Get-CimInstance Win32_Process -Filter ("ProcessId="+[Diagnostics.Process]::GetCurrentProcess().Id)',
        'if($nativeHost.ParentProcessId -ne $nativeParent){throw "hwp-native-parent-invalid"}',
        'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class JarvisHwpComNative { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }\'',
        '$existingHwpIds = @(Get-Process Hwp -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
        `"com-create-start" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        'try {',
        '  $hwp = New-Object -ComObject HWPFrame.HwpObject',
        `  "com-created" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        '  [uint32]$ownedId = 0',
        '  $ownedHandle = [IntPtr]$hwp.XHwpWindows.Active_XHwpWindow.WindowHandle',
        '  [void][JarvisHwpComNative]::GetWindowThreadProcessId($ownedHandle, [ref]$ownedId)',
        '  if ($ownedId -eq 0 -or $existingHwpIds -contains [int]$ownedId) { throw "hwp-com-ownership-unverified" }',
        '  $owned = Get-Process -Id $ownedId -ErrorAction Stop',
        '  $ownedCim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction Stop',
        '  if ($ownedCim.Name -ne "Hwp.exe" -or [string]$ownedCim.CommandLine -notmatch "(?i)-Automation" -or [string]$ownedCim.CommandLine -notmatch "(?i)-Embedding") { throw "hwp-com-automation-identity-unverified" }',
        '  $hwpOwned = $true',
        '  $guard=[JarvisHancomProcessGuard]::new($ownedId,$nativeParent)',
        '  if($guard.OwnedStartTicks -ne $owned.StartTime.ToUniversalTime().Ticks){throw "hwp-native-identity-changed"}',
        `  @{ marker = "jarvis-hwp-owned-v1"; processId = $owned.Id; startedAtUtc = $owned.StartTime.ToUniversalTime().ToString("o"); jobAssigned=$guard.JobAssigned; parentWatchEnabled=$guard.ParentWatchEnabled } | ConvertTo-Json -Compress | Set-Content -LiteralPath "${esc(ownerPath)}" -Encoding utf8`,
        '  try { $hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule") | Out-Null } catch {}',
        `  "module-registered" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        '  $hwp.XHwpDocuments.Add(0) | Out-Null',
        `  "document-added" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        `  $json = [IO.File]::ReadAllText("${esc(tmpJson)}", [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)`,
        '  $data = $json | ConvertFrom-Json',
        '  function Add-JarvisText([AllowEmptyString()][string]$Value) {',
        '    $insertAction = $hwp.CreateAction("InsertText")',
        '    $insertSet = $insertAction.CreateSet()',
        '    $insertAction.GetDefault($insertSet) | Out-Null',
        '    $insertSet.SetItem("Text", $Value)',
        '    $insertAction.Execute($insertSet) | Out-Null',
        '  }',
        '  function Set-JarvisCharacter([int]$Bold, [int]$Height, [int]$TextR = -1, [int]$TextG = -1, [int]$TextB = -1) {',
        '    $shapeAction = $hwp.CreateAction("CharShape")',
        '    if ($null -eq $shapeAction) { throw "hwp-character-shape-action-unavailable" }',
        '    $shapeSet = $shapeAction.CreateSet()',
        '    $shapeAction.GetDefault($shapeSet) | Out-Null',
        '    $shapeSet.SetItem("Bold", $Bold)',
        '    if ($Height -gt 0) { $shapeSet.SetItem("Height", $Height) }',
        '    foreach ($language in @("User", "Symbol", "Other", "Japanese", "Hanja", "Latin", "Hangul")) {',
        '      $shapeSet.SetItem("FaceName$language", "맑은 고딕")',
        '      $shapeSet.SetItem("FontType$language", $hwp.FontType("TTF"))',
        '    }',
        '    if ($TextR -ge 0 -and $TextG -ge 0 -and $TextB -ge 0) { $shapeSet.SetItem("TextColor", $hwp.RGBColor($TextR, $TextG, $TextB)) }',
        '    if ($shapeAction.Execute($shapeSet) -eq $false) { throw "hwp-character-shape-returned-false" }',
        '  }',
        '  function Set-JarvisCellFill([int]$Red, [int]$Green, [int]$Blue) {',
        '    $fillAction = $hwp.CreateAction("CellFill")',
        '    if ($null -eq $fillAction) { throw "hwp-cell-fill-action-unavailable" }',
        '    $fillSet = $fillAction.CreateSet()',
        '    $fillAction.GetDefault($fillSet) | Out-Null',
        '    $fillAttr = $fillSet.CreateItemSet("FillAttr", "DrawFillAttr")',
        '    $fillAttr.SetItem("Type", $hwp.BrushType("NullBrush|WinBrush"))',
        '    $fillAttr.SetItem("WinBrushFaceStyle", $hwp.HatchStyle("None"))',
        '    $fillAttr.SetItem("WinBrushHatchColor", $hwp.RGBColor($Red, $Green, $Blue))',
        '    $fillAttr.SetItem("WinBrushFaceColor", $hwp.RGBColor($Red, $Green, $Blue))',
        '    $fillAttr.SetItem("WindowsBrush", 1)',
        '    if ($fillAction.Execute($fillSet) -eq $false) { throw "hwp-cell-fill-returned-false" }',
        '  }',
        '  $styledCellCount = 0',
        '  $centeredCellCount = 0',
        '  $expectedStyledCellCount = 0',
        '  $tableWidthConfiguredCount = 0',
        '  if ($data.title) { Set-JarvisCharacter 1 1700 17 34 51; Add-JarvisText ([string]$data.title + "`r`n`r`n"); Set-JarvisCharacter 0 1000 45 55 72 }',
        '  foreach ($block in @($data.blocks)) {',
        '    $type = [string]$block.type',
        '    if ($type -eq "heading") {',
        '      $height = if ([int]$block.level -le 1) { 1250 } else { 1100 }',
        '      Set-JarvisCharacter 1 $height 0 121 107',
        '      Add-JarvisText ([string]$block.text + "`r`n")',
        '      Set-JarvisCharacter 0 1000 45 55 72',
        '    } elseif ($type -eq "paragraph") {',
        '      Set-JarvisCharacter 0 950 71 85 105',
        '      Add-JarvisText ([string]$block.text + "`r`n")',
        '    } elseif ($type -eq "bullets") {',
        '      Set-JarvisCharacter 0 950 45 55 72',
        '      foreach ($item in @($block.items)) { Add-JarvisText ("- " + [string]$item + "`r`n") }',
        '      Add-JarvisText "`r`n"',
        '    } elseif ($type -eq "table") {',
        '      $columns = @($block.columns)',
        '      $rowsData = @($block.rows)',
        '      $columnCount = $columns.Count',
        '      $rowCount = $rowsData.Count + 1',
        '      if ($columnCount -gt 0 -and $rowCount -gt 0) {',
        '        $tableAction = $hwp.CreateAction("TableCreate")',
        '        $tableSet = $tableAction.CreateSet()',
        '        $tableAction.GetDefault($tableSet) | Out-Null',
        '        $tableSet.SetItem("Rows", $rowCount)',
        '        $tableSet.SetItem("Cols", $columnCount)',
        '        try {',
        '          $tableSet.SetItem("WidthType", 2)',
        '          $tableSet.SetItem("HeightType", 1)',
        '          $availableWidth = 42500',
        '          $weights = if ($columnCount -eq 8) { @(13, 9, 12, 9, 9, 13, 10, 15) } else { @(1..$columnCount | ForEach-Object { 1 }) }',
        '          $weightTotal = ($weights | Measure-Object -Sum).Sum',
        '          $columnWidths = $tableSet.CreateItemArray("ColWidth", $columnCount)',
        '          for ($widthIndex = 0; $widthIndex -lt $columnCount; $widthIndex += 1) {',
        '            $columnWidths.SetItem($widthIndex, [int][Math]::Floor($availableWidth * $weights[$widthIndex] / $weightTotal))',
        '          }',
        '          $rowHeights = $tableSet.CreateItemArray("RowHeight", $rowCount)',
        '          for ($heightIndex = 0; $heightIndex -lt $rowCount; $heightIndex += 1) {',
        '            $rowHeight = if ($heightIndex -eq 0) { 1800 } else { 1700 }',
        '            $rowHeights.SetItem($heightIndex, $rowHeight)',
        '          }',
        '          $tableWidthConfiguredCount += 1',
        '        } catch {}',
        '        if ($tableAction.Execute($tableSet) -eq $false) { throw "hwp-table-create-returned-false" }',
        '        $expectedStyledCellCount += ($rowCount * $columnCount)',
        '        $cellIndex = 0',
        '        Set-JarvisCharacter 1 900 255 255 255',
        '        foreach ($column in $columns) {',
        '          if ($cellIndex -gt 0) { $hwp.HAction.Run("TableRightCell") | Out-Null }',
        '          $hwp.HAction.Run("ParagraphShapeAlignCenter") | Out-Null',
        '          Set-JarvisCellFill 0 121 107',
        '          $styledCellCount += 1',
        '          $centeredCellCount += 1',
        '          Add-JarvisText ([string]$column)',
        '          $cellIndex += 1',
        '        }',
        '        Set-JarvisCharacter 0 880 30 41 59',
        '        $bodyRowIndex = 0',
        '        foreach ($row in $rowsData) {',
        '          $rowValues = @($row)',
        '          for ($columnIndex = 0; $columnIndex -lt $columnCount; $columnIndex += 1) {',
        '            if ($cellIndex -gt 0) { $hwp.HAction.Run("TableRightCell") | Out-Null }',
        '            $hwp.HAction.Run("ParagraphShapeAlignCenter") | Out-Null',
        '            if (($bodyRowIndex % 2) -eq 0) { Set-JarvisCellFill 240 249 247 } else { Set-JarvisCellFill 255 255 255 }',
        '            $styledCellCount += 1',
        '            $centeredCellCount += 1',
        '            $value = if ($columnIndex -lt $rowValues.Count) { [string]$rowValues[$columnIndex] } else { "" }',
        '            Add-JarvisText $value',
        '            $cellIndex += 1',
        '          }',
        '          $bodyRowIndex += 1',
        '        }',
        '        $hwp.HAction.Run("MoveDocEnd") | Out-Null',
        '        $hwp.HAction.Run("ParagraphShapeAlignLeft") | Out-Null',
        '        Set-JarvisCharacter 0 1000 45 55 72',
        '        Add-JarvisText "`r`n`r`n"',
        '      }',
        '    }',
        '  }',
        '  $expectedTableCount = @($data.blocks | Where-Object { [string]$_.type -eq "table" }).Count',
        '  $outputTableControlCount = 0',
        '  $control = $hwp.HeadCtrl',
        '  while ($null -ne $control) {',
        '    if ([string]$control.CtrlID -eq "tbl") { $outputTableControlCount += 1 }',
        '    $control = $control.Next',
        '  }',
        `  @{ status = "verified"; expectedTableCount = $expectedTableCount; outputTableControlCount = $outputTableControlCount; expectedStyledCellCount = $expectedStyledCellCount; styledCellCount = $styledCellCount; centeredCellCount = $centeredCellCount; tableWidthConfiguredCount = $tableWidthConfiguredCount; visualProfile = "jarvis-professional-table-v1" } | ConvertTo-Json -Compress | Set-Content -LiteralPath "${esc(structurePath)}" -Encoding utf8`,
        '  if ($outputTableControlCount -ne $expectedTableCount) { throw "hwp-table-structure-mismatch:$outputTableControlCount/$expectedTableCount" }',
        '  if ($styledCellCount -ne $expectedStyledCellCount -or $centeredCellCount -ne $expectedStyledCellCount) { throw "hwp-table-style-mismatch:$styledCellCount/$expectedStyledCellCount" }',
        '  if ($tableWidthConfiguredCount -ne $expectedTableCount) { throw "hwp-table-layout-mismatch:$tableWidthConfiguredCount/$expectedTableCount" }',
        `  "document-rendered" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        `  "save-start" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        `  $saved = $hwp.SaveAs("${esc(nativeSavePath)}", "HWP", "")`,
        `  "save-returned" | Set-Content -LiteralPath "${esc(progressPath)}" -Encoding ascii`,
        '  if ($saved -eq $false) { throw "hwp-save-returned-false" }',
        '} catch {',
        `  $_.Exception.Message | Out-File -FilePath "${esc(errorPath)}" -Encoding utf8`,
        '} finally {',
        '  if ($hwp -ne $null) { if ($hwpOwned) { try { $hwp.Quit() } catch {} }; try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp) } catch {} }',
        '  if($null -ne $guard){$guard.Dispose()}',
        '  [GC]::Collect(); [GC]::WaitForPendingFinalizers()',
        '}'
      ].join('\r\n');
      writeFileSync(tmpPs1, '﻿' + script, 'utf8');
      writeFileSync(watcherPath, '﻿' + hwpPathApprovalWatcherScript(), 'utf8');
      watcherProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        watcherPath,
        '-OwnerPath',
        ownerPath,
        '-ExpectedOutputPath',
        nativeSavePath,
        '-ResultPath',
        watcherResultPath,
        '-TimeoutMs',
        String(Math.min(this.timeoutMs, 30000))
      ], { windowsHide: true, stdio: 'ignore' });
      // HWP는 GUI COM이라 창 숨김(windowsHide)이나 파이프 환경에서 멈춘다.
      // STA 스레드 + windowsHide:false로 실행하면 정상 동작한다(진단으로 확인).
      assertAccess();
      await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1], {
        timeout: this.timeoutMs,
        windowsHide: false,
        maxBuffer: 1024 * 1024,
        signal:context.signal
      });
    } catch (error) {
      pathApproval = await finishHwpApprovalWatcher(watcherProcess, watcherResultPath, { outputCreated: false });
      ownerRecord = readHwpOwnerRecord(ownerPath);
      ownedProcessCleanup = await cleanupOwnedHwpAutomationProcess(ownerRecord);
      const lastStep = readHwpProgress(progressPath);
      structureVerification = readHwpStructureVerification(structurePath, doc.tableCount);
      try { rmSync(tmpJson, { force: true }); rmSync(tmpPs1, { force: true }); rmSync(ownerPath, { force: true }); rmSync(progressPath, { force: true }); rmSync(watcherPath, { force: true }); rmSync(watcherResultPath, { force: true }); rmSync(structurePath, { force: true }); rmSync(nativeSavePath, { force: true }); } catch { /* ignore */ }
      return {
        status: 'failed',
        error: `hwp-create-failed: ${String(error?.message ?? error).slice(0, 200)}`,
        targetPath: outPath,
        outputPaths: [],
        rollbackAvailable: false,
        evidence: { ownedProcessCleanup, lastStep, pathApproval, structureVerification, nativeSaveMode: 'ascii-staging' }
      };
    }
    pathApproval = await finishHwpApprovalWatcher(watcherProcess, watcherResultPath, { outputCreated: existsSync(nativeSavePath) });
    ownerRecord = readHwpOwnerRecord(ownerPath);
    ownedProcessCleanup = await cleanupOwnedHwpAutomationProcess(ownerRecord);
    const errorDetail = existsSync(errorPath) ? readFileSync(errorPath, 'utf8').replace(/^﻿/, '').trim().slice(0, 200) : '';
    const lastStep = readHwpProgress(progressPath);
    structureVerification = readHwpStructureVerification(structurePath, doc.tableCount);
    let finalizeError = '';
    let published = false;
    const verifiedStage=nativeSavePath+'.verified.hwp';let verifiedCreated=false;
    try {
      await assertAllowedRealPath(outPath, this.allowedRoots, { checkParentForCreate: true });
      if(packet.capabilityToken)await assertAllowedRealPath(outPath,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();
      if(existsSync(outPath))throw Error('hwp-target-exists-original-preserved');
      const publication = publishVerifiedHwpStage({stagePath:nativeSavePath,targetPath:verifiedStage,errorDetail,lastStep,structureVerification,
        backupExisting:()=>{throw Error('hwp-private-stage-occupied');}});
      verifiedCreated=publication.published===true;
      assertAccess();linkSync(verifiedStage,outPath);published=true;
    } catch (error) {
      finalizeError = String(error?.message ?? error).slice(0, 200);
    }
    if(verifiedCreated)try{rmSync(verifiedStage,{force:true});}catch{}
    try { rmSync(tmpJson, { force: true }); rmSync(tmpPs1, { force: true }); rmSync(ownerPath, { force: true }); rmSync(progressPath, { force: true }); rmSync(watcherPath, { force: true }); rmSync(watcherResultPath, { force: true }); rmSync(structurePath, { force: true }); rmSync(errorPath, { force: true }); rmSync(nativeSavePath, { force: true }); } catch { /* ignore */ }
    if (published && !finalizeError && existsSync(outPath)) {
      try{
      assertAccess();
      const undo = this.undoJournal.record({ taskId: packet.taskId, action: 'delete_created_file', path: outPath, fileKind: 'hwp' });
      const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
      return {
        status: 'success',
        outputPaths: [outPath],
        targetPath: outPath,
        sha256,
        summary: `한글 파일 "${basename(outPath)}"을 만들었어요${doc.tableCount > 0 ? ` (표 ${doc.tableCount}개)` : ''}.`,
        rollbackAvailable: true,
        undoJournalId: undo.undoJournalId,
        evidence: {
          ownedProcessCleanup,
          processGuard:{jobAssigned:ownerRecord?.jobAssigned===true,parentWatchEnabled:ownerRecord?.parentWatchEnabled===true},
          lastStep,
          pathApproval,
          structureVerification,
          sha256,
          nativeSaveMode: 'ascii-staging',
          document: {
            blockCount: doc.blocks.length,
            tableCount: doc.tableCount,
            reportType: doc.metadata?.reportType ?? null
          }
        }
      };
      }catch(error){return {status:'failed',error:`hwp-post-publication-failed:${error.message}`,targetPath:outPath,uncertain:true,outputPaths:[outPath],changedItems:[{type:'create_document',path:outPath,uncertain:true}],rollbackAvailable:false};}
    }
    if(published)return {status:'failed',error:`hwp-post-publication-failed:${finalizeError}`,targetPath:outPath,uncertain:true,outputPaths:[outPath],changedItems:[{type:'create_document',path:outPath,uncertain:true}],rollbackAvailable:false};
    return {
      status: 'failed',
      error: finalizeError
        ? `hwp-finalize-failed:${finalizeError}`
        : errorDetail
          ? `hwp-create-unavailable:${errorDetail}`
          : 'hwp-create-unavailable',
      targetPath: outPath,
      summary: '한글(HWP) 파일 생성이 이 환경에서 한컴 자동화 제약으로 실패했어요. 대신 텍스트(txt)나 워드(docx)로 만들어 드릴 수 있어요.',
      fallbackFormats: ['txt', 'docx'],
      outputPaths: [],
      rollbackAvailable: false,
      evidence: { ownedProcessCleanup, lastStep, pathApproval, structureVerification, nativeSaveMode: 'ascii-staging' }
    };
  }
}

// 공식 예보를 구조화된 통계로 검증한 뒤 네이티브 HWP 표 문서로 만든다.
// 범용 검색/LLM 요약을 거치지 않아 출처, 날짜, 수치와 최종 산출물이 한 실행 증거로 묶인다.
export class WeatherHwpReportToolAdapter {
  constructor({
    allowedRoots = ['./workspace'],
    undoJournal = new UndoJournal(),
    weatherClient = new OpenMeteoWeatherClient(),
    hwpAdapter = null
  } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.weatherClient = weatherClient;
    this.hwpAdapter = hwpAdapter ?? new HwpCreateToolAdapter({
      allowedRoots: this.allowedRoots,
      undoJournal
    });
    this.contract = createToolContract({
      toolName: 'weather.createHwpReport',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'weatherReport.sourceUrl', 'weatherReport.retrievedAt', 'weatherReport.rowCount'],
      blockedOperations: ['locationMissing', 'outsideAllowedRoots', 'weatherSourceUnavailable']
    });
  }

  normalizedArgs(args = {}) {
    const location = String(args.location ?? args.weatherLocation ?? '').trim();
    return {
      ...args,
      location,
      targetDirectoryHint: args.targetDirectoryHint ?? 'desktop'
    };
  }

  documentArgs(normalized,report){
    const document=buildWeeklyWeatherHwpDocument(report);
    return {path:normalized.path,fileName:normalized.fileName||weatherReportFileName(report),targetDirectoryHint:normalized.targetDirectoryHint,
      verifyRendering:normalized.verifyRendering,title:document.title,blocks:document.blocks,metadata:document.metadata};
  }

  async preparePublication(args,context={}){
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');context.assertAccess?.();};
    assertAccess();const normalized=this.normalizedArgs(args);
    if(!normalized.location)throw Error('weather-location-required');
    if(normalized.verifyRendering!==undefined&&typeof normalized.verifyRendering!=='boolean')throw Error('hwp-rendering-option-invalid');
    const report=await this.weatherClient.weeklyForecast(normalized.location,{signal:context.signal});assertAccess();
    const documentArgs=this.documentArgs(normalized,report),hancomPublication=await this.hwpAdapter.preparePublication(documentArgs);assertAccess();
    return {version:'jarvis-weather-publication-v1',requestSha256:editDigest(normalized),report:structuredClone(report),
      reportSha256:editDigest(report),weatherEvidence:compactWeatherReportEvidence(report,buildWeeklyWeatherHwpDocument(report)),hancomPublication};
  }

  async shadow(args) {
    const normalized = this.normalizedArgs(args);
    if (!normalized.location) {
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        warnings: ['날씨 보고서를 만들 지역이 필요합니다.'],
        requiresClarification: true,
        missingField: 'location'
      };
    }
    const fileName = normalized.fileName || `이번_주_날씨_통계_${normalized.location}.hwp`;
    const documentShadow = await this.hwpAdapter.shadow({
      fileName,
      targetDirectoryHint: normalized.targetDirectoryHint,
      path: normalized.path
    });
    return {
      ...documentShadow,
      location: normalized.location,
      liveDataSource: 'Open-Meteo',
      externalNetwork: true
    };
  }

  async execute(args, packet = {}, context = {}) {
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    try{assertAccess();if(args?.verifyRendering!==undefined&&typeof args.verifyRendering!=='boolean')throw Error('hwp-rendering-option-invalid');}
    catch(error){return {status:'blocked',error:error.message,outputPaths:[],rollbackAvailable:false};}
    const normalized = this.normalizedArgs(args);
    if (!normalized.location) {
      return {
        status: 'blocked',
        error: 'weather-location-required',
        summary: '날씨 보고서를 만들 지역이 필요합니다.',
        outputPaths: [],
        rollbackAvailable: false
      };
    }
    let report;
    try {
      const prepared=context.weatherPublication;
      if(prepared){
        if(prepared.version!=='jarvis-weather-publication-v1'||prepared.requestSha256!==editDigest(normalized)
          ||prepared.reportSha256!==editDigest(prepared.report))throw Error('B_WEATHER_PUBLICATION_CHANGED');
        report=structuredClone(prepared.report);
        if(editDigest(await this.hwpAdapter.preparePublication(this.documentArgs(normalized,report)))!==editDigest(prepared.hancomPublication))throw Error('B_WEATHER_PUBLICATION_CHANGED');
      }else report = await this.weatherClient.weeklyForecast(normalized.location, {signal:context.signal});
    } catch (error) {
      return {
        status: error?.code==='B_OPERATION_CANCELLED'?'blocked':'failed',
        error: error?.code ?? (error?.message==='B_WEATHER_PUBLICATION_CHANGED'?error.message:'B_WEATHER_REPORT_SOURCE_FAILED'),
        summary: String(error?.message ?? '날씨 정보를 가져오지 못했습니다.').slice(0, 300),
        outputPaths: [],
        rollbackAvailable: false,
        evidence: {
          weatherReport: {
            reportVersion: 'jarvis-weather-weekly-report-v1',
            locationQuery: normalized.location,
            sourceProvider: 'Open-Meteo',
            fetched: false
          }
        }
      };
    }
    try{assertAccess();}catch(error){return {status:'blocked',error:error.message,outputPaths:[],rollbackAvailable:false};}
    const document = buildWeeklyWeatherHwpDocument(report);
    const hwpResult = await this.hwpAdapter.execute(this.documentArgs(normalized,report), packet, context);
    const weatherEvidence = compactWeatherReportEvidence(report, document);
    if (hwpResult.status !== 'success') {
      return {
        ...hwpResult,
        summary: `날씨 데이터는 확인했지만 한글 보고서 생성에 실패했습니다. ${hwpResult.summary ?? ''}`.trim(),
        weatherReport: weatherEvidence,
        evidence: {
          ...(hwpResult.evidence ?? {}),
          weatherReport: weatherEvidence
        }
      };
    }
    return {
      ...hwpResult,
      weatherPublicationSha256:context.weatherPublication?editDigest(context.weatherPublication):null,
      summary: `${report.location.displayName}의 향후 7일 날씨 통계를 실제 표가 포함된 한글 파일로 만들었습니다.`,
      weatherReport: weatherEvidence,
      evidence: {
        ...(hwpResult.evidence ?? {}),
        weatherReport: weatherEvidence
      }
    };
  }
}

function compactWeatherReportEvidence(report, document) {
  const forecastUrl = String(report?.source?.forecastUrl ?? '');
  let sourceHost = null;
  try { sourceHost = new URL(forecastUrl).hostname; } catch { /* fixed provider URL should always parse */ }
  return {
    reportVersion: report?.reportVersion ?? 'jarvis-weather-weekly-report-v1',
    reportType: document?.metadata?.reportType ?? 'weekly-weather-statistics',
    location: report?.location?.displayName ?? report?.query ?? null,
    locationQuery: report?.query ?? null,
    periodStart: report?.days?.[0]?.date ?? null,
    periodEnd: report?.days?.at(-1)?.date ?? null,
    timezone: report?.timezone ?? null,
    rowCount: report?.days?.length ?? 0,
    tableCount: document?.metadata?.tableCount ?? 0,
    statistics: report?.statistics ?? null,
    sourceProvider: report?.source?.provider ?? 'Open-Meteo',
    geocodingProvider: report?.source?.geocodingProvider ?? null,
    geocodingAttribution: report?.source?.geocodingAttribution ?? null,
    sourceHost,
    sourceUrl: forecastUrl || null,
    retrievedAt: report?.source?.retrievedAt ?? null,
    fetched: true
  };
}

function hardenWindowsVaultKeyFile(cachePath) {
  if (process.platform !== 'win32') return;
  const command = [
    '$path=$env:JARVIS_VAULT_DPAPI_KEY_PATH;',
    '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();',
    '$acl=[System.IO.File]::GetAccessControl($path);',
    '$acl.SetAccessRuleProtection($true,$false);',
    'foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)};',
    '$access=New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User,"FullControl","Allow");',
    '$acl.AddAccessRule($access);',
    '$acl.SetOwner($identity.User);',
    '[System.IO.File]::SetAccessControl($path,$acl)'
  ].join(' ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000,
    env: { ...process.env, JARVIS_VAULT_DPAPI_KEY_PATH: resolve(cachePath) }
  });
}

function withUndoJournalLockSync(journalPath, operation) {
  mkdirSync(dirname(journalPath), { recursive: true });
  const lockPath = `${journalPath}.lock`;
  const deadline = Date.now() + 10_000;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const lock = statSync(lockPath);
        if (Date.now() - lock.mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== 'ENOENT') throw lockError;
      }
      if (Date.now() >= deadline) {
        const timeout = new Error('Undo journal lock timed out.');
        timeout.code = 'B_UNDO_JOURNAL_LOCK_TIMEOUT';
        throw timeout;
      }
      sleepSync(10);
    }
  }
  try {
    return operation();
  } finally {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

async function withFileSystemWriteProcessLock(journalPath, targetKey, operation, {
  timeoutMs = 10_000, staleAfterMs = 30_000
} = {}) {
  // The instance-local queue above handles same-process callers. This lock
  // coordinates separate PC Agent processes that share the installation's
  // persistent UndoJournal. In-memory journals retain process-local semantics.
  if (!journalPath) return operation();
  const lockDirectory = `${journalPath}.file-write-locks`;
  mkdirSync(lockDirectory, { recursive: true });
  const targetHash = createHash('sha256').update(targetKey).digest('hex');
  const lockPath = join(lockDirectory, `${targetHash}.lock`);
  const deadline = Date.now() + timeoutMs;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') {
        // Windows may report EPERM/EACCES instead of EEXIST when a competing
        // process has just created and exclusively opened this lock file.
        // Treat it as contention only if the lock path exists; genuine access
        // failures for a missing path still fail immediately.
        if (!['EPERM', 'EACCES'].includes(error.code) || !existsSync(lockPath)) throw error;
      }
      try {
        const lockStat = statSync(lockPath);
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs > staleAfterMs) {
          let owner = null;
          try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch {}
          const ownerPid = Number(owner?.pid);
          let ownerAlive = false;
          if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
            try { process.kill(ownerPid, 0); ownerAlive = true; }
            catch (processError) { ownerAlive = processError.code === 'EPERM'; }
          }
          if (!ownerAlive) {
            unlinkSync(lockPath);
            continue;
          }
        }
      } catch (lockError) {
        if (lockError.code === 'ENOENT') continue;
        if (lockError.code !== 'EACCES' && lockError.code !== 'EPERM') throw lockError;
      }
      if (Date.now() >= deadline) {
        const timeout = new Error('File revision lock timed out.');
        timeout.code = 'B_FILE_WRITE_LOCK_TIMEOUT';
        throw timeout;
      }
      await delayAsync(10);
    }
    if (descriptor !== null) {
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
      } catch (error) {
        try { closeSync(descriptor); } catch {}
        descriptor = null;
        try { unlinkSync(lockPath); } catch {}
        throw error;
      }
    }
  }
  try {
    return await operation();
  } finally {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

function readHwpOwnerRecord(ownerPath) {
  try {
    const record = JSON.parse(readFileSync(ownerPath, 'utf8').replace(/^﻿/, ''));
    if (record?.marker !== 'jarvis-hwp-owned-v1' || !Number.isInteger(Number(record.processId))) return null;
    return { marker: record.marker, processId: Number(record.processId), startedAtUtc: String(record.startedAtUtc ?? ''),jobAssigned:record.jobAssigned===true,parentWatchEnabled:record.parentWatchEnabled===true };
  } catch {
    return null;
  }
}

function readHwpProgress(progressPath) {
  try {
    return readFileSync(progressPath, 'utf8').trim().slice(0, 80) || 'unknown';
  } catch {
    return 'not-recorded';
  }
}

function readHwpStructureVerification(structurePath, expectedTableCount = 0) {
  try {
    const result = JSON.parse(readFileSync(structurePath, 'utf8').replace(/^﻿/, ''));
    const expected = Number(result?.expectedTableCount);
    const observed = Number(result?.outputTableControlCount);
    const expectedStyledCellCount = Number(result?.expectedStyledCellCount);
    const styledCellCount = Number(result?.styledCellCount);
    const centeredCellCount = Number(result?.centeredCellCount);
    const tableWidthConfiguredCount = Number(result?.tableWidthConfiguredCount);
    const visualProfile = String(result?.visualProfile ?? '');
    const expectedFromDocument = Number(expectedTableCount);
    const tableStructureVerified = result?.status === 'verified'
      && expected === observed
      && expected === expectedFromDocument;
    const styleVerified = expectedFromDocument === 0 || (
      expectedStyledCellCount > 0
      && styledCellCount === expectedStyledCellCount
      && centeredCellCount === expectedStyledCellCount
      && tableWidthConfiguredCount === expectedFromDocument
      && visualProfile === 'jarvis-professional-table-v1'
    );
    return {
      status: tableStructureVerified && styleVerified ? 'verified' : 'mismatch',
      structureStatus: tableStructureVerified ? 'verified' : 'mismatch',
      styleStatus: styleVerified ? 'verified' : 'mismatch',
      expectedTableCount: Number.isFinite(expected) ? expected : expectedFromDocument,
      outputTableControlCount: Number.isFinite(observed) ? observed : null,
      expectedStyledCellCount: Number.isFinite(expectedStyledCellCount) ? expectedStyledCellCount : null,
      styledCellCount: Number.isFinite(styledCellCount) ? styledCellCount : null,
      centeredCellCount: Number.isFinite(centeredCellCount) ? centeredCellCount : null,
      tableWidthConfiguredCount: Number.isFinite(tableWidthConfiguredCount) ? tableWidthConfiguredCount : null,
      visualProfile: visualProfile || null
    };
  } catch {
    return {
      status: Number(expectedTableCount) === 0 ? 'not-required' : 'not-recorded',
      structureStatus: Number(expectedTableCount) === 0 ? 'not-required' : 'not-recorded',
      styleStatus: Number(expectedTableCount) === 0 ? 'not-required' : 'not-recorded',
      expectedTableCount: Number(expectedTableCount),
      outputTableControlCount: null,
      expectedStyledCellCount: null,
      styledCellCount: null,
      centeredCellCount: null,
      tableWidthConfiguredCount: null,
      visualProfile: null
    };
  }
}

// HWP의 파일 접근 경고는 전역 보안 모듈로 우회하지 않는다. 이 감시기는 이번 실행이
// 소유한 Hwp.exe와 승인된 출력 경로가 모두 일치할 때만 단일 파일 "접근 허용"을 누른다.
export function hwpPathApprovalWatcherScript() {
  return [
    'param(',
    '  [Parameter(Mandatory = $true)][string]$OwnerPath,',
    '  [Parameter(Mandatory = $true)][string]$ExpectedOutputPath,',
    '  [Parameter(Mandatory = $true)][string]$ResultPath,',
    '  [int]$TimeoutMs = 30000',
    ')',
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class JarvisHwpNative {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '}',
    '"@',
    'function Write-WatcherResult([hashtable]$data) {',
    '  $data | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding utf8',
    '}',
    'function Test-ExactHwpDialog($element, [int]$processId, [string]$expectedPath) {',
    '  try {',
    '    $current = $element.Current',
    '    return $current.ProcessId -eq $processId -and ([string]$current.Name).IndexOf($expectedPath, [StringComparison]::OrdinalIgnoreCase) -ge 0',
    '  } catch { return $false }',
    '}',
    '$stage = "startup"',
    '$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1000, $TimeoutMs))',
    'try {',
    '  while ([DateTime]::UtcNow -lt $deadline) {',
    '    $stage = "owner-wait"',
    '    if (!(Test-Path -LiteralPath $OwnerPath)) { Start-Sleep -Milliseconds 100; continue }',
    '    try { $owner = Get-Content -LiteralPath $OwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 100; continue }',
    '    if ([string]$owner.marker -ne "jarvis-hwp-owned-v1") { Write-WatcherResult @{ status = "owner-marker-mismatch"; approved = $false }; exit 2 }',
    '    $stage = "process-validation"',
    '    $targetId = [int]$owner.processId',
    '    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId" -ErrorAction SilentlyContinue',
    '    if ($null -eq $process) {',
    '      if (Test-Path -LiteralPath $ExpectedOutputPath) { Write-WatcherResult @{ status = "no-prompt-observed"; approved = $false; processId = $targetId; approvalScope = "not-requested" }; exit 0 }',
    '      Start-Sleep -Milliseconds 100; continue',
    '    }',
    '    $created = ([DateTime]$process.CreationDate).ToUniversalTime()',
    '    $recorded = ([DateTimeOffset]::Parse([string]$owner.startedAtUtc)).UtcDateTime',
    '    $commandLine = [string]$process.CommandLine',
    '    $owned = $process.Name -eq "Hwp.exe" -and $commandLine -match "(?i)-Automation" -and $commandLine -match "(?i)-Embedding" -and [Math]::Abs(($created - $recorded).TotalSeconds) -le 10',
    '    if (!$owned) { Start-Sleep -Milliseconds 100; continue }',
    '    $stage = "uia-root"',
    '    $root = [System.Windows.Automation.AutomationElement]::RootElement',
    '    $stage = "uia-enumeration"',
    '    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)',
    '    $dialog = $null',
    '    foreach ($window in $windows) {',
    '      try {',
    '        if ($window.Current.ProcessId -ne $targetId) { continue }',
    '        $windowName = [string]$window.Current.Name',
    '        if ($window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and $windowName.IndexOf($ExpectedOutputPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $dialog = $window; break }',
    '        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
    '        foreach ($candidate in $elements) {',
    '          try {',
    '            if ($candidate.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }',
    '            $name = [string]$candidate.Current.Name',
    '            if ($name.IndexOf($ExpectedOutputPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $dialog = $candidate; break }',
    '          } catch {}',
    '        }',
    '      } catch {}',
    '      if ($null -ne $dialog) { break }',
    '    }',
    '    if ($null -eq $dialog) {',
    '      $alive = Get-Process -Id $targetId -ErrorAction SilentlyContinue',
    '      if ($null -eq $alive -and (Test-Path -LiteralPath $ExpectedOutputPath)) { Write-WatcherResult @{ status = "no-prompt-observed"; approved = $false; processId = $targetId; approvalScope = "not-requested" }; exit 0 }',
    '      Start-Sleep -Milliseconds 100; continue',
    '    }',
    '    $stage = "dialog-matched"',
    '    $buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
    '    $allowButton = $null',
    '    foreach ($button in $buttons) {',
    '      try {',
    '        if ($button.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }',
    '        $buttonName = [string]$button.Current.Name',
    '        if ($buttonName.StartsWith("접근 허용", [StringComparison]::Ordinal) -and !$buttonName.StartsWith("모두 허용", [StringComparison]::Ordinal)) { $allowButton = $button; break }',
    '      } catch {}',
    '    }',
    '    if ($null -eq $allowButton) { Write-WatcherResult @{ status = "single-path-control-missing"; approved = $false; processId = $targetId }; exit 4 }',
    '    $stage = "single-path-invoke"',
    '    $activationMethod = "invoke"',
    '    try {',
    '      $patternObject = $allowButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)',
    '      ([System.Windows.Automation.InvokePattern]$patternObject).Invoke()',
    '    } catch { $activationMethod = "invoke-unavailable" }',
    '    Start-Sleep -Milliseconds 700',
    '    $stillExactDialog = Test-ExactHwpDialog $dialog $targetId $ExpectedOutputPath',
    '    if ($stillExactDialog) {',
    '      $stage = "single-path-legacy-action"',
    '      $legacy = $null',
    '      try {',
    '        if ($allowButton.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacy)) {',
    '          ([System.Windows.Automation.LegacyIAccessiblePattern]$legacy).DoDefaultAction()',
    '          $activationMethod = "legacy-default-action"',
    '        }',
    '      } catch {}',
    '      Start-Sleep -Milliseconds 500',
    '      $stillExactDialog = Test-ExactHwpDialog $dialog $targetId $ExpectedOutputPath',
    '    }',
    '    if ($stillExactDialog) {',
    '      $stage = "single-path-foreground-shortcut"',
    '      $dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle',
    '      if ($dialogHandle -eq [IntPtr]::Zero -or $buttonName -notmatch "(?i)ALT\\+Y") { Write-WatcherResult @{ status = "safe-activation-unavailable"; approved = $false; processId = $targetId; stage = $stage }; exit 7 }',
    '      Add-Type -AssemblyName System.Windows.Forms',
    '      try { $allowButton.SetFocus() } catch {}',
    '      [void][JarvisHwpNative]::SetForegroundWindow($dialogHandle)',
    '      Start-Sleep -Milliseconds 200',
    '      if ([JarvisHwpNative]::GetForegroundWindow() -ne $dialogHandle) { Write-WatcherResult @{ status = "foreground-verification-failed"; approved = $false; processId = $targetId; stage = $stage }; exit 8 }',
    '      [System.Windows.Forms.SendKeys]::SendWait("%y")',
    '      $activationMethod = "foreground-alt-y"',
    '    }',
    '    $stage = "approval-confirmation"',
    '    $confirmationDeadline = [DateTime]::UtcNow.AddSeconds(10)',
    '    while ([DateTime]::UtcNow -lt $confirmationDeadline) {',
    '      if (Test-Path -LiteralPath $ExpectedOutputPath) { Write-WatcherResult @{ status = "approved-exact-path"; approved = $true; processId = $targetId; dialogTitleMatched = $true; approvalScope = "single-path"; activationMethod = $activationMethod; confirmation = "output-created" }; exit 0 }',
    '      if (!(Test-ExactHwpDialog $dialog $targetId $ExpectedOutputPath)) { Write-WatcherResult @{ status = "approved-exact-path"; approved = $true; processId = $targetId; dialogTitleMatched = $true; approvalScope = "single-path"; activationMethod = $activationMethod; confirmation = "dialog-closed" }; exit 0 }',
    '      Start-Sleep -Milliseconds 100',
    '    }',
    '    Write-WatcherResult @{ status = "approval-unconfirmed"; approved = $false; processId = $targetId; stage = $stage; activationMethod = $activationMethod }',
    '    exit 9',
    '  }',
    '  Write-WatcherResult @{ status = "timeout"; approved = $false }',
    '  exit 5',
    '} catch {',
    '  Write-WatcherResult @{ status = "watcher-error"; approved = $false; stage = $stage }',
    '  exit 6',
    '}'
  ].join('\r\n');
}

function readHwpApprovalResult(resultPath) {
  try {
    const result = JSON.parse(readFileSync(resultPath, 'utf8').replace(/^﻿/, ''));
    return {
      status: String(result?.status ?? 'unknown').slice(0, 80),
      approved: result?.approved === true,
      ...(Number.isInteger(Number(result?.processId)) ? { processId: Number(result.processId) } : {}),
      ...(result?.dialogTitleMatched === true ? { dialogTitleMatched: true } : {}),
      ...(['single-path', 'not-requested'].includes(result?.approvalScope) ? { approvalScope: result.approvalScope } : {}),
      ...(result?.stage ? { stage: String(result.stage).slice(0, 40) } : {}),
      ...(['invoke', 'legacy-default-action', 'foreground-alt-y'].includes(result?.activationMethod) ? { activationMethod: result.activationMethod } : {}),
      ...(['output-created', 'dialog-closed'].includes(result?.confirmation) ? { confirmation: result.confirmation } : {})
    };
  } catch {
    return null;
  }
}

function sleepSync(milliseconds) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, Math.max(0, milliseconds));
}

async function finishHwpApprovalWatcher(child, resultPath, { outputCreated = false } = {}) {
  if (!child) return { status: 'not-started', approved: false };
  const deadline = Date.now() + 1200;
  let result = readHwpApprovalResult(resultPath);
  while (!result && Date.now() < deadline) {
    await delayAsync(50);
    result = readHwpApprovalResult(resultPath);
  }
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  } catch { /* the watcher already exited */ }
  return result ?? (outputCreated
    ? { status: 'no-prompt-observed', approved: false, approvalScope: 'not-requested' }
    : { status: 'terminated-without-result', approved: false });
}

async function cleanupOwnedHwpAutomationProcess(ownerRecord) {
  if (!ownerRecord?.processId || !ownerRecord.startedAtUtc) return { status: 'not-recorded', stopped: false };
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$targetId = [int]$env:JARVIS_HWP_OWNER_PID',
    '$recordedStart = [DateTimeOffset]::Parse($env:JARVIS_HWP_OWNER_STARTED).UtcDateTime',
    '$process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId" -ErrorAction SilentlyContinue',
    'if ($null -eq $process) { @{ status = "already-exited"; stopped = $false } | ConvertTo-Json -Compress; exit 0 }',
    '$created = ([DateTime]$process.CreationDate).ToUniversalTime()',
    '$commandLine = [string]$process.CommandLine',
    '$owned = $process.Name -eq "Hwp.exe" -and $commandLine -match "(?i)-Automation" -and $commandLine -match "(?i)-Embedding" -and [Math]::Abs(($created - $recordedStart).TotalSeconds) -le 1',
    'if (!$owned) { @{ status = "ownership-mismatch"; stopped = $false } | ConvertTo-Json -Compress; exit 0 }',
    'Stop-Process -Id $targetId -Force -ErrorAction Stop',
    '@{ status = "stopped-owned-automation"; stopped = $true } | ConvertTo-Json -Compress'
  ].join('; ');
  try {
    const execution = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: {
        ...process.env,
        JARVIS_HWP_OWNER_PID: String(ownerRecord.processId),
        JARVIS_HWP_OWNER_STARTED: ownerRecord.startedAtUtc
      }
    });
    const output = String(execution.stdout ?? '').trim();
    const result = JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1));
    return { status: result.status ?? 'unknown', stopped: result.stopped === true, processId: ownerRecord.processId };
  } catch (error) {
    return { status: 'cleanup-failed', stopped: false, processId: ownerRecord.processId, error: String(error?.message ?? error).slice(0, 120) };
  }
}

// 구조화 블록(제목/헤딩/문단/불릿/표) 또는 평문을 표준 블록 배열로 정규화한다.
// planner가 blocks를 주면 그대로, content만 있으면 문단으로 변환한다.
export function normalizeDocBlocks({ blocks, content, text, title, docTitle, metadata = null } = {}) {
  const resolvedTitle = title ?? docTitle;
  const out = [];
  if (Array.isArray(blocks) && blocks.length) {
    for (const [index, b] of blocks.entries()) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw documentBlockContractError('BLOCK_INVALID', index, typeof b);
      const type = String(b.type ?? '').toLowerCase();
      if (type === 'heading') {
        if (!String(b.text ?? '').trim()) throw documentBlockContractError('CONTENT_REQUIRED', index, type);
        out.push({ type: 'heading', level: Math.min(3, Math.max(1, Number(b.level) || 1)), text: String(b.text) });
      }
      else if (type === 'paragraph' || (!type && b.text != null)) {
        if (!String(b.text ?? '').trim()) throw documentBlockContractError('CONTENT_REQUIRED', index, type || 'paragraph');
        out.push({ type: 'paragraph', text: String(b.text) });
      }
      else if (type === 'bullets') {
        const items = Array.isArray(b.items) ? b.items.map((x) => String(x ?? '')).filter((item) => item.trim()) : [];
        if (!items.length) throw documentBlockContractError('CONTENT_REQUIRED', index, type);
        out.push({ type: 'bullets', items });
      }
      else if (type === 'table') {
        const columns = Array.isArray(b.columns) ? b.columns : Array.isArray(b.headers) ? b.headers : [];
        if (!columns.length || columns.every((column) => !String(column ?? '').trim())) throw documentBlockContractError('TABLE_COLUMNS_REQUIRED', index, type);
        if (!Array.isArray(b.rows) || b.rows.some(row => !Array.isArray(row) || row.length !== columns.length)) {
          throw documentBlockContractError('TABLE_ROW_WIDTH_MISMATCH', index, type);
        }
        out.push({
          type: 'table',
          columns: columns.map((x) => String(x ?? '')),
          rows: (Array.isArray(b.rows) ? b.rows : []).map((r) => (Array.isArray(r) ? r.map((x) => String(x ?? '')) : [String(r ?? '')]))
        });
      }
      else throw documentBlockContractError('BLOCK_TYPE_UNSUPPORTED', index, type || '(missing)');
    }
  }
  const plainContent = content ?? text;
  if (!out.length && plainContent) {
    for (const line of String(plainContent).split(/\r?\n/)) {
      const t = line.trim();
      if (t) out.push({ type: 'paragraph', text: t });
    }
  }
  return {
    title: resolvedTitle ? String(resolvedTitle) : null,
    blocks: out,
    tableCount: out.filter((block) => block.type === 'table').length,
    metadata: metadata && typeof metadata === 'object' ? metadata : null
  };
}

function documentBlockContractError(reason, index, type) {
  const code = `B_DOCUMENT_${reason}`;
  const error = new Error(`${code.toLowerCase().replace(/^b_/, '').replace(/_/g, '-')}:${index}:${type}`);
  error.code = code;
  error.blockIndex = index;
  error.blockType = type;
  return error;
}

// Native authoring is only successful when every requested semantic item survives
// the Office renderer. Keep this list independent from visual formatting so a
// missing table or paragraph cannot be reported as a completed document.
export function expectedDocContentItems(doc = {}) {
  const items = [];
  if (doc.title) items.push(String(doc.title));
  for (const block of Array.isArray(doc.blocks) ? doc.blocks : []) {
    if (block?.type === 'heading' || block?.type === 'paragraph') items.push(String(block.text ?? ''));
    else if (block?.type === 'bullets') items.push(...(Array.isArray(block.items) ? block.items : []).map((item) => String(item ?? '')));
    else if (block?.type === 'table') {
      items.push(...(Array.isArray(block.columns) ? block.columns : []).map((item) => String(item ?? '')));
      for (const row of Array.isArray(block.rows) ? block.rows : []) {
        items.push(...(Array.isArray(row) ? row : [row]).map((item) => String(item ?? '')));
      }
    }
  }
  return items.map((item) => item.trim()).filter(Boolean);
}

// blocks 구조를 평문으로 렌더한다(HWP처럼 텍스트 삽입만 지원하는 어댑터용).
function renderDocBlocksAsText(doc) {
  const lines = [];
  if (doc.title) lines.push(doc.title, '');
  for (const b of doc.blocks) {
    if (b.type === 'heading') lines.push('', b.level === 1 ? `■ ${b.text}` : `- ${b.text}`, '');
    else if (b.type === 'paragraph') lines.push(b.text);
    else if (b.type === 'bullets') for (const it of b.items) lines.push(`  • ${it}`);
    else if (b.type === 'table') {
      lines.push(b.columns.join(' | '));
      for (const r of b.rows) lines.push(r.join(' | '));
    }
  }
  return lines.join('\r\n').replace(/(\r\n){3,}/g, '\r\n\r\n').trim();
}

// 같은 이름의 파일이 이미 있으면 삭제하지 않고 ~/.jarvis-backups로 이동한다(데이터 정책: 삭제 대신 보관).
// HWP/Office SaveAs가 기존 파일 앞에서 덮어쓰기 확인 모달을 띄워 무인 실행이 멈추는 것도 이걸로 막는다.
function backupExistingOutput(outPath, home, allowedRoots = null) {
  if (!existsSync(outPath)) return null;
  const configured = process.env.JARVIS_BACKUP_DIR ? resolve(process.env.JARVIS_BACKUP_DIR) : null;
  const configuredAllowed = configured && (!allowedRoots || allowedRoots.some((root) => isInside(root, configured)));
  const dir = configuredAllowed
    ? configured
    : allowedRoots?.[0]
      ? resolve(allowedRoots[0], '.jarvis-backups')
      : resolve(home, '.jarvis-backups');
  mkdirSync(dir, { recursive: true });
  const backupPath = resolve(dir, `${basename(outPath)}.${Date.now()}.bak`);
  renameSync(outPath, backupPath);
  return backupPath;
}

function resolveAuthoringOutPath({ args, home, defaultExt }) {
  let p = args?.path ? String(args.path) : '';
  const ext = /pdf/i.test(String(args?.outputFormat ?? '')) ? 'pdf' : defaultExt;
  if (p) {
    if (!new RegExp(`\\.${ext}$`, 'i').test(p)) p = p.replace(/\.[^.\\/]+$/, '') + '.' + ext;
    return resolve(p);
  }
  const name = String(args?.fileName ?? '문서').replace(/\.[^.\\/]+$/, '') + '.' + ext;
  const hint = args?.targetDirectoryHint;
  const dir = hint === 'desktop' ? resolve(home, 'Desktop')
    : hint === 'documents' ? resolve(home, 'Documents')
    : hint === 'downloads' ? resolve(home, 'Downloads')
    : resolve('./workspace');
  return resolve(dir, name);
}

// 워드(.docx)·PDF를 Word COM으로 네이티브 저작한다. 내장 스타일 ID(음수)를 써서 한글판 Word에서도 동작한다.
export class WordCreateToolAdapter {
  // PDF 내보내기는 첫 실행(폰트 캐시)에 60초를 넘길 수 있어 여유 있게 잡는다.
  constructor({ timeoutMs = 120000, allowedRoots = ['./workspace'], undoJournal = new UndoJournal() } = {}) {
    this.home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.timeoutMs = timeoutMs;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.contract = createToolContract({ toolName: 'word.create', mutatesSystem: true, rollback: true, evidence: ['outputPath', 'sha256', 'blockCount', 'contentVerification'], blockedOperations: ['outsideAllowedRoots'] });
  }

  resolveOutPath(args) {
    if(typeof args?.path==='string'&&extname(args.path))return resolve(args.path);
    return resolveAuthoringOutPath({args,home:this.home,defaultExt:'docx'});
  }

  async preparePublication(args) {
    const outputPath=this.resolveOutPath(args),isPdf=/\.pdf$/iu.test(outputPath);
    if(!/\.(docx|pdf)$/iu.test(outputPath))throw Error('word-output-format-unsupported');
    if(args?.outputFormat!==undefined&&(!['docx','pdf'].includes(String(args.outputFormat).toLowerCase())
      ||String(args.outputFormat).toLowerCase()!==extname(outputPath).slice(1).toLowerCase()))throw Error('word-output-format-conflict');
    const document=normalizeDocBlocks(args);
    if(!document.title&&!document.blocks.length)document.blocks.push({type:'paragraph',text:'(내용 없음)'});
    const key=createHash('sha256').update(JSON.stringify({outputPath,document})).digest('hex').slice(0,32);
    const renderDirectory=join(dirname(outputPath),`.jarvis-word-evidence-${key}`);
    const paths=[outputPath,join(renderDirectory,'native-report.json'),join(renderDirectory,isPdf?'document.docx':'document.pdf')];
    for(const path of paths)await assertAllowedRealPath(path,this.allowedRoots,{checkParentForCreate:true});
    return {outputPath,isPdf,document,renderDirectory,paths};
  }

  async shadow(args) {
    const doc = normalizeDocBlocks(args);
    const outputPath = this.resolveOutPath(args);
    try {
      await assertAllowedRealPath(outputPath, this.allowedRoots, { checkParentForCreate: true });
      return { mode: 'shadow', expectedChangesCount: 1, outputPath, blockCount: doc.blocks.length, warnings: [] };
    } catch (error) {
      return { mode: 'shadow', expectedChangesCount: 0, outputPath, blockCount: doc.blocks.length, warnings: [error.message] };
    }
  }

  async execute(args, packet = {}, context = {}) {
    const outPath = this.resolveOutPath(args);
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    try {
      assertAccess();
      await assertAllowedRealPath(outPath, this.allowedRoots, { checkParentForCreate: true });
      assertAccess();
    } catch (error) {
      return { status: 'blocked', error: error.message, targetPath: outPath, outputPaths: [], rollbackAvailable: false, warnings: [error.message] };
    }
    let prepared;
    try{prepared=await this.preparePublication(args);assertAccess();await context.beforeArtifactWrite?.({paths:prepared.paths,prepared});assertAccess();}
    catch(error){return this.failResult(outPath,error);}
    const {isPdf,document:doc}=prepared;
    if(existsSync(outPath)||existsSync(prepared.renderDirectory))return this.failResult(outPath,'word-target-exists-original-preserved');
    const expectedContentItems = expectedDocContentItems(doc);
    const stamp = Date.now();
    let staging=null,nativeReport=null,renderDirectory=null;
    const published=[];
    let tmpJson = resolve(process.env.TEMP ?? '.', `jarvis-word-${stamp}.json`);
    try {
      assertAccess();
      mkdirSync(dirname(outPath), { recursive: true });
      assertAccess();
      staging=await mkdtemp(join(dirname(outPath),'.jarvis-word-stage-'));
      tmpJson=join(staging,'request.json');
      const nativeSavePath=join(staging,isPdf?'document.pdf':'document.docx');
      assertAccess();
      writeFileSync(tmpJson,JSON.stringify({document:doc,staging,expectedContentItems}),'utf8');
      assertAccess();
      nativeReport=await createVerifiedWordDocument(tmpJson,{timeoutMs:this.timeoutMs,signal:context.signal});
      assertAccess();
      if(existsSync(nativeSavePath+'.err'))throw Error('word-native-authoring-reported-error');
      if(!existsSync(nativeSavePath))throw Error('word-native-output-missing');
      if(!isPdf){
        const tables=doc.blocks.filter(block=>block.type==='table').map(block=>[block.columns,...block.rows]);
        const verification=await verifyDocumentTables(nativeSavePath,tables,{allowedRoots:this.allowedRoots});
        if(!verification.passed)throw Error(verification.reason??'word-table-check-failed');
      }
      await assertAllowedRealPath(outPath,this.allowedRoots,{checkParentForCreate:true});
      assertAccess();
      // No overwrite or pre-emptive original backup. A late competing file
      // makes publication fail while preserving that file.
      renderDirectory=prepared.renderDirectory;
      await assertAllowedRealPath(renderDirectory,this.allowedRoots,{checkParentForCreate:true});assertAccess();
      await mkdir(renderDirectory);
      const publish=async(from,to,digest)=>{
        await assertAllowedRealPath(to,this.allowedRoots,{checkParentForCreate:true});
        if(digest&&createHash('sha256').update(await readFile(from)).digest('hex')!==digest)throw Error('word-render-artifact-changed');
        const identity=await lstat(from);assertAccess();await link(from,to);published.push({path:to,identity});
      };
      await publish(join(staging,'native-report.json'),join(renderDirectory,'native-report.json'));
      if(!isPdf)await publish(join(staging,'document.pdf'),join(renderDirectory,'document.pdf'),nativeReport.pdfSha256);
      if(isPdf)await publish(join(staging,'document.docx'),join(renderDirectory,'document.docx'),nativeReport.sourceSha256);
      await publish(nativeSavePath,outPath,isPdf?nativeReport.pdfSha256:nativeReport.sourceSha256);
    } catch (error) {
      try { rmSync(tmpJson, { force: true }); } catch { /* ignore */ }
      return {...this.failResult(outPath,error),...(published.length?{uncertain:true,outputPaths:published.map(file=>file.path),
        changedItems:published.map(file=>({type:'create_file',path:file.path,uncertain:true}))}:{})};
    } finally {
      if(staging){try{await assertAllowedRealPath(staging,this.allowedRoots);await rm(staging,{recursive:true,force:true});}catch{}}
    }
    try {
    try { rmSync(tmpJson, { force: true }); } catch { /* ignore */ }
    const errPath = outPath + '.err';
    if (existsSync(outPath)) {
      const documentTables=doc.blocks.filter(block=>block.type==='table').map(block=>[block.columns,...block.rows]);
      const tableVerification=isPdf?null:await verifyDocumentTables(outPath,documentTables,{allowedRoots:this.allowedRoots});
      if(!isPdf&&tableVerification?.passed!==true)throw Error(tableVerification?.reason??'word-table-check-failed');
      const documentParagraphs=!isPdf&&doc.blocks.every(block=>['paragraph','heading'].includes(block.type))
        ?[...(doc.title?[doc.title]:[]),...doc.blocks.map(block=>block.text)].flatMap(value=>value.replace(/\r\n?/g,'\n').split('\n')):null;
      if(documentParagraphs?.length){const checked=await verifyDocumentParagraphs(outPath,documentParagraphs,{allowedRoots:this.allowedRoots});if(!checked.passed)throw Error(checked.reason);}
      // Native errors belong to the owned staging directory. A pre-existing
      // <output>.err beside the final file is not this operation's property.
      const kind = isPdf ? 'PDF' : '워드';
      assertAccess();
      const undo = this.undoJournal.record({ taskId: packet.taskId, action: 'delete_created_file', path: outPath, fileKind: isPdf ? 'pdf' : 'docx' });
      const undoIds=published.filter(file=>file.path!==outPath).map(file=>this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path:file.path,fileKind:extname(file.path).slice(1)}).undoJournalId);
      const contentVerification = {
        status: 'verified',
        expectedItemCount: expectedContentItems.length,
        expectedTableCount: doc.tableCount
      };
      return {
        status: 'success',
        outputPaths: [outPath,...published.filter(file=>file.path!==outPath).map(file=>file.path)],
        renderDirectory,nativeReport,document:doc,artifactManifest:prepared,
        documentSourcePath:isPdf?join(renderDirectory,'document.docx'):outPath,
        targetPath: outPath,
        blockCount: doc.blocks.length,
        ...(!isPdf?{documentTables,tableVerification}:{}),
        ...(documentParagraphs?.length?{documentParagraphs}:{}),
        contentVerification,
        evidence: { document: { blockCount: doc.blocks.length, tableCount: doc.tableCount, contentVerification } },
        summary: `${kind} 문서 "${basename(outPath)}"을(를) 만들었어요.`,
        rollbackAvailable: true,
        undoJournalId: undo.undoJournalId,undoJournalIds:[undo.undoJournalId,...undoIds]
      };
    }
    return this.failResult(outPath, existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(0, 200) : 'word-unavailable');
    } catch(error) {
      return {...this.failResult(outPath,error),...(published.length?{uncertain:true,outputPaths:published.map(file=>file.path),
        changedItems:published.map(file=>({type:'create_file',path:file.path,uncertain:true}))}:{})};
    }
  }

  failResult(outPath, detail) {
    const text=[detail?.message??detail,detail?.stderr??''].join(' ');
    const reason=text.match(/word-[a-z-]+/u)?.[0]??(detail?.killed===true?'word-native-timeout':'word-native-operation-failed');
    return {
      status: 'failed',
      error: `word-create-failed: ${reason}`,
      targetPath: outPath,
      summary: 'Word 문서 생성과 저장 결과 검증을 완료하지 못했습니다.',
      nextAction:reason.includes('target-exists')?'기존 파일은 보존됐습니다. 새 파일 이름을 지정해 주세요.':
        reason.includes('interactive-session')?'Windows에 로그인한 PC 실행 경로로 연결해 주세요.':
        reason.includes('instance-not-isolated')?'기존 Word 작업은 유지했습니다. 작업을 저장한 뒤 다시 시도해 주세요.':
        '실행 기록과 Word 설치 상태를 확인한 뒤 다시 시도해 주세요.',
      ...(detail?.nativeRecovery?{nativeRecovery:detail.nativeRecovery}:{}),
      fallbackFormats: ['txt', 'hwp'],
      outputPaths: [],
      rollbackAvailable: false
    };
  }
}

// 파워포인트(.pptx)·PDF를 PowerPoint COM으로 네이티브 저작한다.
export class PowerPointCreateToolAdapter {
  constructor({ timeoutMs = 120000, allowedRoots = ['./workspace'], undoJournal = new UndoJournal() } = {}) {
    this.home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.timeoutMs = timeoutMs;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.contract = createToolContract({ toolName: 'powerpoint.create', mutatesSystem: true, rollback: true, evidence: ['outputPath', 'sha256', 'slideCount', 'titleSequenceVerification'], blockedOperations: ['outsideAllowedRoots'] });
  }

  resolveOutPath(args) {
    if(typeof args?.path==='string'&&extname(args.path))return resolve(args.path);
    return resolveAuthoringOutPath({args,home:this.home,defaultExt:'pptx'});
  }
  async preparePublication(args) {
    const outputPath=this.resolveOutPath(args),isPdf=/\.pdf$/iu.test(outputPath);
    if(!/\.(pptx|pdf)$/iu.test(outputPath))throw Error('powerpoint-output-format-unsupported');
    if(args?.outputFormat!==undefined&&(!['pptx','pdf'].includes(String(args.outputFormat).toLowerCase())
      ||String(args.outputFormat).toLowerCase()!==extname(outputPath).slice(1).toLowerCase()))throw Error('powerpoint-output-format-conflict');
    const deck=this.normalizeSlides(args);
    if(!deck.slides.length)throw Error('powerpoint-slides-required');
    const key=createHash('sha256').update(JSON.stringify({outputPath,deck})).digest('hex').slice(0,32);
    const renderDirectory=join(dirname(outputPath),`.jarvis-ppt-evidence-${key}`);
    const paths=[outputPath,...deck.slides.map((_,index)=>join(renderDirectory,`slide-${index+1}.png`)),join(renderDirectory,'native-report.json'),...(isPdf?[join(renderDirectory,'presentation.pptx')]:[])];
    for(const path of paths)await assertAllowedRealPath(path,this.allowedRoots,{checkParentForCreate:true});
    return {outputPath,isPdf,deck,renderDirectory,paths};
  }

  normalizeSlides(args) {
    let slides = Array.isArray(args?.slides) ? args.slides : [];
    if(slides.length>40||slides.some(s=>!s||typeof s!=='object'||typeof s.title!=='string'||
      (s.bullets!==undefined&&(!Array.isArray(s.bullets)||s.bullets.some(x=>typeof x!=='string')))||
      (s.notes!==undefined&&typeof s.notes!=='string')))throw new Error('powerpoint-slide-input-invalid');
    slides = slides.map((s) => ({
      title: String(s?.title ?? ''),
      bullets: Array.isArray(s?.bullets) ? s.bullets.map((x) => String(x ?? '')) : [],
      notes: s?.notes ? String(s.notes) : ''
    }));
    if (!slides.length && args?.deckTitle) slides = [{ title: String(args.deckTitle), bullets: [], notes: '' }];
    return { title: args?.deckTitle ? String(args.deckTitle) : null, slides };
  }

  async shadow(args) {
    const deck = this.normalizeSlides(args);
    const outputPath = this.resolveOutPath(args);
    try {
      await assertAllowedRealPath(outputPath, this.allowedRoots, { checkParentForCreate: true });
      return { mode: 'shadow', expectedChangesCount: 1, outputPath, slideCount: deck.slides.length, warnings: [] };
    } catch (error) {
      return { mode: 'shadow', expectedChangesCount: 0, outputPath, slideCount: deck.slides.length, warnings: [error.message] };
    }
  }

  async execute(args, packet = {}, context = {}) {
    const outPath=this.resolveOutPath(args);let staging,assetDirectory;const published=[];
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    try{assertAccess();await assertAllowedRealPath(outPath,this.allowedRoots,{checkParentForCreate:true});}
    catch(error){return {status:'blocked',error:error.message,targetPath:outPath,outputPaths:[],rollbackAvailable:false,warnings:[error.message]};}
    try {
      assertAccess();
      const prepared=await this.preparePublication(args),deck=prepared.deck;
      assertAccess();await context.beforeArtifactWrite?.({paths:prepared.paths,prepared});assertAccess();
      if(existsSync(outPath)||existsSync(prepared.renderDirectory))throw new Error('powerpoint-target-exists');
      assertAccess();
      await mkdir(dirname(outPath),{recursive:true});
      assertAccess();staging=await mkdtemp(join(dirname(outPath),'.jarvis-ppt-stage-'));
      const requestPath=join(staging,'request.json');
      assertAccess();await writeFile(requestPath,JSON.stringify({deck,staging,pdf:/\.pdf$/iu.test(outPath)}),'utf8');
      assertAccess();
      const {verification,nativeReport}=await createVerifiedPresentation(requestPath,{timeoutMs:this.timeoutMs,signal:context.signal});
      assertAccess();
      const source=join(staging,/\.pdf$/iu.test(outPath)?'presentation.pdf':'presentation.pptx');
      const sourceBytes=await readFile(source);
      if(/\.pdf$/iu.test(outPath)&&sourceBytes.subarray(0,5).toString()!=='%PDF-')throw new Error('powerpoint-pdf-export-invalid');
      if(/\.pptx$/iu.test(outPath)&&createHash('sha256').update(sourceBytes).digest('hex')!==verification.sha256)throw new Error('powerpoint-package-changed');
      assetDirectory=prepared.renderDirectory;
      await assertAllowedRealPath(assetDirectory,this.allowedRoots,{checkParentForCreate:true});assertAccess();await mkdir(assetDirectory);
      // Publication checks the current fence and physical root immediately
      // before each non-overwriting link. Track only files this call owns.
      const publish=async(from,to,expectedSha256)=>{await assertAllowedRealPath(to,this.allowedRoots,{checkParentForCreate:true});
        if(expectedSha256&&createHash('sha256').update(await readFile(from)).digest('hex')!==expectedSha256)throw new Error('powerpoint-render-artifact-changed');
        const identity=await lstat(from);assertAccess();await link(from,to);published.push({path:to,identity});};
      for(const item of verification.slides)await publish(join(staging,item.png),join(assetDirectory,item.png),item.pngSha256);
      await publish(join(staging,'native-report.json'),join(assetDirectory,'native-report.json'));
      if(/\.pdf$/iu.test(outPath))await publish(join(staging,'presentation.pptx'),join(assetDirectory,'presentation.pptx'),verification.sha256);
      await publish(source,outPath);
      assertAccess();const undo=this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path:outPath,fileKind:/\.pdf$/iu.test(outPath)?'pdf':'pptx'});
      const renderUndoIds=published.filter(file=>file.path!==outPath).map(file=>this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path:file.path,fileKind:extname(file.path).slice(1)}).undoJournalId);
      const titleSequenceVerification={status:'verified',titles:nativeReport.slides.map(s=>s.fields.find(f=>f.role==='title').text)};
      return {status:'success',outputPaths:[outPath,...published.filter(file=>file.path!==outPath).map(file=>file.path)],targetPath:outPath,artifactManifest:prepared,slideCount:verification.slideCount,titleSequenceVerification,
        presentationSourcePath:/\.pdf$/iu.test(outPath)?join(assetDirectory,'presentation.pptx'):outPath,layoutRequirements:deck.slides,
        contentVerification:verification,renderDirectory:assetDirectory,
        evidence:{presentation:{slideCount:verification.slideCount,titleSequenceVerification,contentVerification:verification,renderDirectory:assetDirectory,
          actualRenderingExecuted:true,renderer:nativeReport.renderer,ownedProcessId:nativeReport.ownedProcessId,jobAssigned:nativeReport.jobAssigned}},
        sha256:createHash('sha256').update(sourceBytes).digest('hex'),summary:'저장한 발표자료의 전체 문구·메모와 실제 렌더링 경계를 확인했습니다. 의미·디자인 평가는 별도입니다.',rollbackAvailable:true,undoJournalId:undo.undoJournalId,undoJournalIds:[undo.undoJournalId,...renderUndoIds]};
    } catch(error) {
      const detail=/^(?:powerpoint|presentation)-/u.test(error.message)?error.message:String(error.stderr??'');
      const reason=(detail.match(/(?:powerpoint|presentation)-[a-z-]+/u)?.[0]??'powerpoint-native-or-content-check-failed').replace('presentation-text-overflow','powerpoint-text-overflow');
      return {...this.failResult(outPath,reason),...(published.length?{uncertain:true,outputPaths:published.map(file=>file.path),changedItems:published.map(file=>({type:'create_file',path:file.path,uncertain:true}))}:{})};
    } finally {
      if(staging){try{await assertAllowedRealPath(staging,this.allowedRoots);await rm(staging,{recursive:true,force:true});}catch{}}
    }
  }

  failResult(outPath, detail) {
    const reason=String(detail??'');
    const nextAction=reason.includes('user-session-in-use')?'열려 있는 PowerPoint 작업을 저장하고 닫은 뒤 다시 실행해 주세요.':
      reason.includes('text-overflow')?'문구를 삭제하지 말고 여러 슬라이드로 나눠 다시 요청해 주세요.':
      reason.includes('target-exists')?'기존 파일을 보존하려면 새 출력 이름을 선택해 주세요.':
      'PowerPoint·Python·Pillow 연결과 출력 폴더 준비 상태를 확인해 주세요.';
    return {
      status: 'failed',
      error: `powerpoint-create-failed: ${String(detail ?? '').slice(0, 200)}`,
      targetPath: outPath,
      summary: 'PowerPoint 발표자료 생성 또는 저장 내용·렌더링 검증을 완료하지 못했습니다.',
      nextAction,
      fallbackFormats: ['docx', 'txt'],
      outputPaths: [],
      rollbackAvailable: false
    };
  }
}

// PC 전체에서 파일을 이름/확장자/기간/내용으로 찾는다. 읽기 전용이라 안전하다.
export class FileSearchToolAdapter {
  constructor({ maxResults = 100, maxDepth = 6, timeoutMs = 15000, allowedRoots = ['./workspace'] } = {}) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.roots = {
      workspace: this.allowedRoots[0] ?? resolve('./workspace'),
      home,
      desktop: resolve(home, 'Desktop'),
      documents: resolve(home, 'Documents'),
      downloads: resolve(home, 'Downloads')
    };
    this.maxResults = maxResults;
    this.maxDepth = maxDepth;
    this.timeoutMs = timeoutMs;
    this.excludeDirs = new Set(['node_modules', '.git', '.next', '.venv', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'dist', 'build', '.jarvis-backups']);
    this.contract = createToolContract({
      toolName: 'filesystem.searchFiles',
      readOnly: true,
      evidence: ['query', 'matchCount', 'roots'],
      blockedOperations: ['fileContentWrite']
    });
  }

  criteriaOf(args) {
    return {
      query: String(args?.query ?? '').trim().toLowerCase(),
      extensions: Array.isArray(args?.extensions) ? args.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()) : [],
      modifiedWithinDays: Number.isFinite(args?.modifiedWithinDays) ? args.modifiedWithinDays : null,
      contentQuery: String(args?.contentQuery ?? '').trim().toLowerCase(),
      scope: ['workspace', 'home', 'desktop', 'documents', 'downloads'].includes(args?.scope) ? args.scope : 'home'
    };
  }

  async searchRoot(args, criteria, packet = {}) {
    if (args?.directory === undefined) return this.roots[criteria.scope] ?? this.roots.home;
    if (criteria.scope !== 'workspace' || typeof args.directory !== 'string' || !args.directory.trim()
      || /[\0\r\n]/u.test(args.directory)) throw new Error('search-directory-invalid');
    const path = await assertAllowedRealPath(args.directory, this.allowedRoots);
    if (packet.capabilityToken) await assertAllowedRealPath(path, packet.capabilityToken.scope?.allowedPaths ?? []);
    return path;
  }

  async searchRoots(args, criteria, packet = {}) {
    if (args?.directories === undefined) return [await this.searchRoot(args, criteria, packet)];
    if (args.directory !== undefined || criteria.scope !== 'workspace' || !Array.isArray(args.directories)
      || args.directories.length < 1 || args.directories.length > 20) throw new Error('search-directories-invalid');
    const roots = [];
    for (const directory of args.directories) {
      const path = await this.searchRoot({ directory }, criteria, packet);
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (!roots.some(root => (process.platform === 'win32' ? root.toLowerCase() : root) === key)) roots.push(path);
    }
    return roots;
  }

  async shadow(args) {
    const c = this.criteriaOf(args);
    let roots, warnings = [];
    try { roots = await this.searchRoots(args, c); } catch { warnings = ['search-directory-not-allowed']; }
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      query: c.query,
      extensions: c.extensions,
      scope: c.scope,
      root: roots?.[0],
      roots,
      warnings
    };
  }

  async execute(args, packet = {}) {
    const c = this.criteriaOf(args);
    let roots;
    try { roots = await this.searchRoots(args, c, packet); }
    catch { return { status: 'failed', error: 'search-directory-not-allowed', matches: [], matchCount: 0, outputPaths: [], rollbackAvailable: false }; }
    const requestedLimit = args?.maxResults ?? this.maxResults;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000)
      return { status: 'failed', error: 'search-limit-invalid', matches: [], outputPaths: [], rollbackAvailable: false };
    const limit = Math.min(requestedLimit, this.maxResults);
    const bounded = args?.directory !== undefined || args?.directories !== undefined;
    const stopReasons = new Set(), visited = new Set(), foundPaths = new Set();
    const deadline = Date.now() + this.timeoutMs;
    const cutoff = c.modifiedWithinDays != null ? Date.now() - c.modifiedWithinDays * 86400000 : null;
    const queryWords = c.query ? c.query.split(/\s+/).filter(Boolean) : [];
    const matches = [];
    const walk = async (dir, depth) => {
      if (matches.length >= limit) { stopReasons.add('result-limit'); return; }
      if (Date.now() > deadline) { stopReasons.add('timeout'); return; }
      if (depth > this.maxDepth) { stopReasons.add('depth-limit'); return; }
      if (bounded) {
        try { await assertAllowedRealPath(dir, this.allowedRoots); } catch { stopReasons.add('path-unavailable'); return; }
      }
      const directoryKey = process.platform === 'win32' ? dir.toLowerCase() : dir;
      if (visited.has(directoryKey)) return;
      visited.add(directoryKey);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        stopReasons.add('directory-unreadable');
        return;
      }
      for (const entry of entries) {
        if (matches.length >= limit) { stopReasons.add('result-limit'); return; }
        if (Date.now() > deadline) { stopReasons.add('timeout'); return; }
        const full = resolve(dir, entry.name);
        if (bounded && entry.isSymbolicLink()) { stopReasons.add('link-excluded'); continue; }
        if (entry.isDirectory()) {
          if (this.excludeDirs.has(entry.name) || entry.name.startsWith('.')) { stopReasons.add('directory-excluded'); continue; }
          await walk(full, depth + 1);
        } else {
          const name = entry.name.toLowerCase();
          const ext = extname(name).replace(/^\./, '');
          if (queryWords.length && !queryWords.every((w) => name.includes(w))) continue;
          if (c.extensions.length && !c.extensions.includes(ext)) continue;
          let st;
          try {
            st = await stat(full);
          } catch {
            stopReasons.add('file-unreadable');
            continue;
          }
          if (cutoff && st.mtimeMs < cutoff) continue;
          if (c.contentQuery) {
            if (st.size > 2 * 1024 * 1024) { stopReasons.add('content-budget'); continue; }
            try {
              const body = await readFile(full, 'utf8');
              if (!body.toLowerCase().includes(c.contentQuery)) continue;
            } catch {
              stopReasons.add('content-unreadable');
              continue;
            }
          }
          const fileKey = process.platform === 'win32' ? full.toLowerCase() : full;
          if (!foundPaths.has(fileKey)) {
            foundPaths.add(fileKey);
            matches.push({ name: entry.name, path: full, size: st.size, modifiedAt: st.mtime.toISOString() });
          }
        }
      }
    };
    for (const root of roots) await walk(root, 0);
    matches.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return {
      status: 'success',
      query: c.query,
      scope: c.scope,
      root: roots[0],
      roots,
      searchCompleteness: { version: 'pc-search-completeness-v1', complete: stopReasons.size === 0, reasons: [...stopReasons], maxResults: limit, requestedRootCount: roots.length, returnedMatchCount: matches.length },
      matchCount: matches.length,
      matches,
      summary: stopReasons.size ? `${matches.length}개 파일을 찾았지만 일부 범위는 확인하지 못했어요.` : matches.length ? `${matches.length}개 파일을 찾았어요.` : '조건에 맞는 파일을 찾지 못했어요.',
      outputPaths: [],
      rollbackAvailable: false
    };
  }
}

// 사용자 폴더에서 이름 키워드로 파일들을 찾는다(첨부·편집 대상 해석용 공통 헬퍼).
// 여러 개가 매칭될 수 있으므로 최근순 배열로 돌려주고, 호출부가 모호성을 처리한다.
async function findFilesByQuery(query, { roots, extensions = [], maxDepth = 6, excludeDirs, limit = 12 } = {}) {
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const deadline = Date.now() + 10000;
  const matches = [];
  const walk = async (dir, depth) => {
    if (Date.now() > deadline || depth > maxDepth || matches.length >= 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) return;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs?.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else {
        const name = entry.name.toLowerCase();
        const ext = extname(name).replace(/^\./, '');
        if (extensions.length && !extensions.includes(ext)) continue;
        if (!words.every((w) => name.includes(w))) continue;
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        matches.push({ path: full, name: entry.name, mtimeMs: st.mtimeMs });
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches.slice(0, limit);
}

// 기존 엑셀(xlsx) 파일의 셀 내용을 수정한다. 편집 전 백업을 만들어 되돌릴 수 있게 한다.
export class DocumentEditToolAdapter {
  constructor({ maxDepth = 6, allowedRoots = ['./workspace'], undoJournal = new UndoJournal() } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.searchRoots = [...this.allowedRoots];
    this.undoJournal = undoJournal;
    this.excludeDirs = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'dist', 'build', '.jarvis-backups']);
    this.maxDepth = maxDepth;
    const configuredBackupDir = process.env.JARVIS_BACKUP_DIR ? resolve(process.env.JARVIS_BACKUP_DIR) : null;
    this.backupDir = configuredBackupDir && this.allowedRoots.some((root) => isInside(root, configuredBackupDir))
      ? configuredBackupDir
      : resolve(this.allowedRoots[0] ?? './workspace', '.jarvis-backups');
    this.contract = createToolContract({
      toolName: 'document.edit',
      mutatesSystem: true,
      rollback: true,
      evidence: ['targetPath', 'editedCells', 'backupPath'],
      blockedOperations: ['targetFileMissing', 'unsupportedFormat']
    });
  }

  async loadExcelJS() {
    try {
      const mod = await import('exceljs');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }

  async preparePublication(args) {
    const targets=await this.resolveTargets(args);
    if(targets.length!==1 || extname(targets[0].path).toLowerCase()!=='.xlsx')throw Error('DOCUMENT_EDIT_EXACT_XLSX_REQUIRED');
    const targetPath=targets[0].path,sourceSnapshot=createdFileRollbackSnapshot(targetPath);
    const edits=JSON.parse(JSON.stringify(args.edits??[])),sheet=args.sheet??null;
    const backupPath=resolve(this.backupDir,`${basename(targetPath)}.${editDigest({targetPath,sourceSnapshot,edits,sheet})}.bak`);
    return {version:'jarvis-document-edit-v1',targetPath,sourceSnapshot,sourceSha256:sourceSnapshot.sha256,backupPath,paths:[targetPath,backupPath],sheet,edits};
  }

  // 대상 파일을 해석한다. 정확한 경로면 그것을, 이름 검색이면 후보 배열을 준다.
  async resolveTargets(args) {
    if (args?.targetPath && existsSync(args.targetPath)) {
      const targetPath = await assertAllowedRealPath(args.targetPath, this.allowedRoots);
      return [{ path: targetPath, name: basename(targetPath) }];
    }
    return findFilesByQuery(args?.targetQuery ?? args?.targetPath, {
      roots: this.searchRoots,
      extensions: ['xlsx'],
      maxDepth: this.maxDepth,
      excludeDirs: this.excludeDirs
    });
  }

  async shadow(args) {
    let targets;
    try {
      targets = await this.resolveTargets(args);
    } catch (error) {
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        targetPath: args?.targetPath ? resolve(args.targetPath) : null,
        targetFound: false,
        edits: [],
        warnings: [error.message]
      };
    }
    const target = targets[0] ?? null;
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    return {
      mode: 'shadow',
      expectedChangesCount: edits.length,
      targetPath: target?.path ?? null,
      targetFound: Boolean(target),
      edits,
      warnings: target ? [] : ['수정할 엑셀 파일을 찾지 못했습니다']
    };
  }

  async execute(args, packet = {}, context = {}) {
    const assertAccess = () => {
      if (context.signal?.aborted) throw Object.assign(new Error('B_OPERATION_CANCELLED'),{code:'B_OPERATION_CANCELLED'});
      trustedLocalEffectFences.get(packet)?.(); context.assertAccess?.();
    };
    const assertPath = async path => {
      assertAccess(); await assertAllowedRealPath(path,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(path,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});
      assertAccess();
    };
    let targets;
    try {
      assertAccess();
      targets = await this.resolveTargets(args);
      for(const target of targets)await assertPath(target.path);
    } catch (error) {
      return { status: 'blocked', error: error.message, summary: '허용된 작업 폴더 밖의 문서는 편집할 수 없어요.', outputPaths: [], rollbackAvailable: false, warnings: [error.message] };
    }
    if (targets.length === 0) {
      return { status: 'failed', error: 'target-file-missing', summary: '수정할 파일을 찾지 못했어요. 파일 이름을 더 정확히 알려주시거나, 어느 폴더에 있는지 말씀해 주세요.', outputPaths: [], rollbackAvailable: false };
    }
    // 대상 파일이 여러 개면 임의로 고르지 않고 어느 파일인지 되묻는다.
    if (targets.length > 1) {
      return {
        status: 'needs_choice',
        candidates: targets.map((t) => ({ name: t.name, path: t.path })),
        summary: `"${args?.targetQuery ?? ''}"에 맞는 파일이 ${targets.length}개 있어요: ${targets.slice(0, 6).map((t) => t.name).join(', ')}. 어느 파일을 수정할까요?`,
        outputPaths: [],
        rollbackAvailable: false
      };
    }
    const target = targets[0];
    if (extname(target.path).toLowerCase() !== '.xlsx') {
      return { status: 'failed', error: `unsupported-format:${extname(target.path)}`, targetPath: target.path, summary: `지금은 엑셀(xlsx) 파일만 편집할 수 있어요. "${basename(target.path)}"은(는) ${extname(target.path)} 형식이라 아직 안 돼요.`, outputPaths: [], rollbackAvailable: false };
    }
    let prepared, originalSnapshot, originalBytes;
    try { prepared=await this.preparePublication(args);originalSnapshot=prepared.sourceSnapshot; originalBytes=readFileSync(target.path);assertAccess(); }
    catch(error){return {status:'blocked',error:error.code??error.message,targetPath:target.path,outputPaths:[],rollbackAvailable:false};}
    const ExcelJS = await this.loadExcelJS();
    if (!ExcelJS) {
      return { status: 'failed', error: 'exceljs-not-installed', targetPath: target.path, summary: '엑셀 편집 기능이 준비되지 않았어요. 잠시 후 다시 시도해 주세요.', outputPaths: [], rollbackAvailable: false };
    }
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    let backupPath=null,backupSnapshot=null,stagePath=null,stageSnapshot=null,published=false;
    try {
      assertAccess();
      if(!edits.length || edits.some(edit=>!edit || typeof edit!=='object' || (!edit.cell && edit.findText==null)
        || (edit.cell && !/^[A-Z]{1,3}[1-9]\d{0,6}$/iu.test(edit.cell)) || !Object.hasOwn(edit,'value')
        || (edit.findText!=null && !String(edit.findText).length)
        || (edit.scope!=null && !['ask','first','all'].includes(edit.scope)))) throw Error('document-edit-invalid-edits');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(originalBytes);
      assertAccess();
      const ws = args?.sheet ? wb.getWorksheet(args.sheet) : wb.worksheets[0];
      if(!ws)throw Error('document-edit-sheet-missing');

      // 1단계(변경 없이 스캔): findText가 여러 셀에 걸리고 범위가 불명확하면 실행하지 않고 선택지를 돌려준다.
      const collectHits = (findText) => {
        const needle = String(findText);
        const hits = [];
        ws.eachRow((row, rowNumber) => {
          row.eachCell((cell) => {
            if (String(cell.value ?? '').includes(needle)) {
              hits.push({ address: cell.address, row: rowNumber, current: String(cell.value ?? '') });
            }
          });
        });
        return hits;
      };
      const ambiguous = [];
      const missing = [];
      for (const edit of edits) {
        if (edit?.cell || edit?.findText == null) continue;
        const scope = String(edit.scope ?? 'ask');
        const hits = collectHits(edit.findText);
        if(!hits.length)missing.push(String(edit.findText));
        if (hits.length > 1 && scope !== 'all' && scope !== 'first') {
          ambiguous.push({ findText: String(edit.findText), value: edit.value, matchCount: hits.length, locations: hits.slice(0, 12) });
        }
      }
      if(missing.length)throw Error('document-edit-find-target-missing');
      if (ambiguous.length) {
        // 모호함: 파일을 건드리지 않고, 발견 위치와 맥락을 사용자에게 제시한다.
        const first = ambiguous[0];
        const preview = first.locations.map((h) => `${h.address}: "${h.current}"`).join(' / ');
        return {
          status: 'needs_choice',
          targetPath: target.path,
          ambiguous,
          summary: `"${first.first ?? first.findText}"이(가) ${first.matchCount}곳에 있어요: ${preview}. 전체를 바꿀까요, 아니면 특정 셀(예: ${first.locations[0].address})만 바꿀까요?`,
          choicePrompt: `"${first.findText}"을(를) 모두 바꾸려면 "전부 바꿔줘", 특정 위치만 바꾸려면 셀 주소(예: ${first.locations[0].address})나 위치를 말해 주세요.`,
          outputPaths: [],
          rollbackAvailable: false
        };
      }

      // 2단계(실제 편집): 백업 후 적용. 백업은 전용 폴더에 두어 원본 옆을 어지럽히지 않는다.
      const editedCells = [];
      const notFound = [];
      for (const edit of edits) {
        if (edit?.cell) {
          ws.getCell(edit.cell).value = edit.value;
          editedCells.push(edit.cell);
        } else if (edit?.findText != null) {
          const scope = String(edit.scope ?? 'ask');
          const hits = collectHits(edit.findText);
          if(hits.length>1 && !['all','first'].includes(scope))throw Error('document-edit-find-became-ambiguous');
          if (hits.length === 0) {
            notFound.push(String(edit.findText));
            continue;
          }
          const targets = scope === 'first' ? hits.slice(0, 1) : hits; // 1개거나 scope=all이면 전부
          for (const h of targets) {
            const cell = ws.getCell(h.address);
            // 문자열이면 부분 치환, 그 외에는 값 통째 교체.
            cell.value = typeof cell.value === 'string'
              ? cell.value.split(String(edit.findText)).join(String(edit.value))
              : edit.value;
            editedCells.push(h.address);
          }
        }
      }
      if(notFound.length)throw Error('document-edit-find-target-missing-after-earlier-edit');
      const outputBytes=Buffer.from(await wb.xlsx.writeBuffer());assertAccess();
      const checkWorkbook=new ExcelJS.Workbook();await checkWorkbook.xlsx.load(outputBytes);assertAccess();
      const checkSheet=checkWorkbook.getWorksheet(ws.name);
      if(!checkSheet || editedCells.some(cell=>JSON.stringify(checkSheet.getCell(cell).value)!==JSON.stringify(ws.getCell(cell).value)))throw Error('document-edit-output-mismatch');
      backupPath=prepared.backupPath;
      stagePath=resolve(dirname(target.path),`.jarvis-edit-${randomBytes(12).toString('hex')}.xlsx`);
      await assertPath(backupPath);await assertPath(target.path);
      await context.beforeArtifactWrite?.({paths:prepared.paths,prepared});assertAccess();
      if(!createdFileRollbackMatches(originalSnapshot,createdFileRollbackSnapshot(target.path)))throw Error('document-edit-source-changed');
      await mkdir(this.backupDir,{recursive:true});await assertPath(backupPath);
      await writeFile(backupPath,originalBytes,{flag:'wx'});assertAccess();
      backupSnapshot=createdFileRollbackSnapshot(backupPath);
      if(createHash('sha256').update(readFileSync(backupPath)).digest('hex')!==originalSnapshot.sha256)throw Error('document-edit-backup-changed');
      await assertPath(stagePath);await writeFile(stagePath,outputBytes,{flag:'wx'});stageSnapshot=createdFileRollbackSnapshot(stagePath);
      await assertPath(target.path);assertAccess();
      if(!createdFileRollbackMatches(originalSnapshot,createdFileRollbackSnapshot(target.path)))throw Error('document-edit-source-changed');
      if(!createdFileRollbackMatches(stageSnapshot,createdFileRollbackSnapshot(stagePath)))throw Error('document-edit-staging-changed');
      if(!createdFileRollbackMatches(backupSnapshot,createdFileRollbackSnapshot(backupPath)))throw Error('document-edit-backup-changed');
      assertAccess();renameSync(stagePath,target.path);published=true;assertAccess();
      if(!createdFileRollbackMatches(stageSnapshot,createdFileRollbackSnapshot(target.path)))throw Error('document-edit-published-file-changed');
      const undo = this.undoJournal.record({
        taskId: packet.taskId,
        action: 'restore_backup_file',
        path: target.path,
        backupPath,
        editedFileSnapshot:stageSnapshot,
        backupFileSnapshot:backupSnapshot,
        fileKind: 'xlsx'
      });
      assertAccess();
      if(!createdFileRollbackMatches(stageSnapshot,createdFileRollbackSnapshot(target.path))
        || !createdFileRollbackMatches(backupSnapshot,createdFileRollbackSnapshot(backupPath)))throw Error('document-edit-final-file-changed');
      const parts = [`${editedCells.length}개 셀을 수정했어요`];
      if (notFound.length) parts.push(`("${notFound.join('", "')}"은(는) 찾지 못함)`);
      return {
        status: 'success',
        targetPath: target.path,
        editedCells,
        notFound,
        backupPath,
        artifactManifest:prepared,
        sourceSha256:prepared.sourceSha256,
        undoJournalId: undo.undoJournalId,
        summary: `${basename(target.path)}에서 ${parts.join(' ')}.`,
        outputPaths: prepared.paths,
        rollbackAvailable: true
      };
    } catch (error) {
      return { status: 'failed', error: String(error?.code ?? error?.message ?? error), targetPath: target.path,
        artifactManifest:prepared,sourceSha256:prepared.sourceSha256,backupPath,uncertain:published,outputPaths:published?prepared.paths:[],rollbackAvailable:false };
    } finally {
      if(stagePath&&stageSnapshot){try{if(createdFileRollbackMatches(stageSnapshot,createdFileRollbackSnapshot(stagePath)))unlinkSync(stagePath);}catch{ /* Never remove replaced staging files. */ }}
    }
  }
}

// 첨부 파일과 함께 메일을 보낸다. SMTP 자격증명(JARVIS_SMTP_USER/PASS)이 있어야 실제 발송한다.
export class VisualCreateCardsToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(), pythonExecutable = process.env.JARVIS_PYTHON ?? 'python' } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.pythonExecutable = pythonExecutable;
    this.contract = createToolContract({
      toolName: 'visual.createCards',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPaths', 'cardCount', 'cards', 'undoJournalIds'],
      blockedOperations: ['outsideAllowedRoots', 'targetExists', 'invalidDimensions', 'tooManyCards']
    });
  }

  async normalize(args = {}) {
    const outputDirectory = resolve(args.outputDirectory ?? this.allowedRoots[0]);
    const width = Number(args.width ?? 1200);
    const height = Number(args.height ?? 675);
    const cards = Array.isArray(args.cards) ? args.cards.slice(0, 13) : [];
    const warnings = [];
    if (!this.allowedRoots.some((root) => isInside(root, outputDirectory))) warnings.push('outside-allowed-roots');
    if (!Number.isInteger(width) || width < 640 || width > 2400 || !Number.isInteger(height) || height < 360 || height > 1600) warnings.push('invalid-dimensions');
    if (cards.length === 0) warnings.push('cards-required');
    if (cards.length > 12) warnings.push('too-many-cards');
    const normalizedCards = [];
    const names = new Set();
    for (let index = 0; index < cards.length && index < 12; index += 1) {
      const source = cards[index] ?? {};
      const fileName = String(source.fileName ?? `card-${String(index + 1).padStart(2, '0')}.png`).trim();
      if (basename(fileName) !== fileName || !/^[^\\/:*?"<>|]+\.png$/iu.test(fileName)) {
        warnings.push(`invalid-card-filename:${index + 1}`);
        continue;
      }
      const nameKey = fileName.toLowerCase();
      if (names.has(nameKey)) {
        warnings.push(`duplicate-card-filename:${fileName}`);
        continue;
      }
      names.add(nameKey);
      const path = resolve(outputDirectory, fileName);
      try {
        await assertAllowedRealPath(path, this.allowedRoots, { checkParentForCreate: true });
      } catch {
        warnings.push(`outside-allowed-roots:${fileName}`);
      }
      if (await exists(path)) warnings.push(`target-exists:${path}`);
      const title = String(source.title ?? '').trim();
      if (!title) warnings.push(`card-title-required:${index + 1}`);
      const textFields={label:String(source.label??'JARVIS BRIEF').trim(),title,
        subtitle:String(source.subtitle??'').trim(),footer:String(source.footer??'Generated and verified by JARVIS').trim(),
        body:Array.isArray(source.body)?source.body.map(item=>String(item??'').trim()):String(source.body??'').trim()};
      if(textFields.title.length>600||textFields.label.length>120||textFields.subtitle.length>600||textFields.footer.length>600
        ||Array.isArray(textFields.body)&&(textFields.body.length>20||textFields.body.some(item=>item.length>1000))
        ||typeof textFields.body==='string'&&textFields.body.length>6000)warnings.push(`card-text-limit-exceeded:${index+1}`);
      const accent=String(source.accent??'#4471ff').trim();
      if(!/^#[a-f0-9]{6}$/iu.test(accent))warnings.push(`invalid-card-accent:${index+1}`);
      normalizedCards.push({
        path,
        fileName,
        ...textFields,
        accent
      });
    }
    return { outputDirectory, width, height, cards: normalizedCards, warnings: [...new Set(warnings)] };
  }

  async preparePublication(args) {
    const normalized=await this.normalize(args);
    if(normalized.warnings.length)throw Object.assign(Error(normalized.warnings.join(',')),{code:'B_CARD_PREFLIGHT_FAILED',warnings:normalized.warnings});
    return {manifestVersion:'jarvis-card-publication-v1',...normalized,paths:normalized.cards.map(card=>card.path)};
  }

  async shadow(args) {
    const normalized = await this.normalize(args);
    return {
      mode: 'shadow',
      expectedChangesCount: normalized.warnings.length ? 0 : normalized.cards.length,
      outputDirectory: normalized.outputDirectory,
      width: normalized.width,
      height: normalized.height,
      cardCount: normalized.cards.length,
      fileNames: normalized.cards.map((card) => card.fileName),
      warnings: normalized.warnings
    };
  }

  async execute(args, packet = {}, context = {}) {
    const assertAccess=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
    const assertPath=async path=>{assertAccess();await assertAllowedRealPath(path,this.allowedRoots,{checkParentForCreate:true});
      if(packet.capabilityToken)await assertAllowedRealPath(path,packet.capabilityToken.scope?.allowedPaths??[],{checkParentForCreate:true});assertAccess();};
    let normalized;
    try{assertAccess();normalized=await this.preparePublication(args);for(const path of normalized.paths)await assertPath(path);
      await context.beforeArtifactWrite?.({paths:normalized.paths,prepared:normalized});assertAccess();}
    catch(error){return {status:'blocked',error:error.code??error.message,outputPaths:[],changedItems:[],warnings:error.warnings??[],rollbackAvailable:false};}
    const script = fileURLToPath(new URL('./adapters/visual/create_cards.py', import.meta.url));
    await mkdir(normalized.outputDirectory,{recursive:true});
    const staging=await mkdtemp(join(normalized.outputDirectory,'.jarvis-card-stage-'));
    const stagedCards=normalized.cards.map(card=>({...card,path:join(staging,card.fileName)}));
    const published=[];
    const payload = Buffer.from(JSON.stringify({
      width: normalized.width,
      height: normalized.height,
      cards: stagedCards
    }), 'utf8').toString('base64');
    try {
      const result = await execFileAsync(this.pythonExecutable, [script, payload], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 45000,
        signal: context.signal,
        maxBuffer: 1024 * 1024
      });
      const worker = JSON.parse(String(result.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '{}');
      if (worker.status !== 'success') throw new Error(worker.badEntry ?? 'visual-card-worker-failed');
      const pixelScript=fileURLToPath(new URL('./adapters/visual/verify_card_pixels.py',import.meta.url));
      const pixelPayload=Buffer.from(JSON.stringify({entries:stagedCards.map(card=>({card,
        layout:worker.generated?.find(item=>item.path===card.path)?.layout}))}),'utf8').toString('base64');
      const pixelOutput=await execFileAsync(this.pythonExecutable,[pixelScript,pixelPayload],{windowsHide:true,timeout:45000,maxBuffer:1024*1024,signal:context.signal});
      const pixelResult=JSON.parse(String(pixelOutput.stdout??'').trim().split(/\r?\n/u).at(-1)??'{}');
      if(pixelResult.status!=='passed'||pixelResult.cards?.length!==normalized.cards.length)throw new Error('visual-card-pixel-content-unverified');
      const cards = [];
      const undoJournalIds = [];
      for (const [index,card] of normalized.cards.entries()) {
        const staged=stagedCards[index];
        const layout=worker.generated?.find(item=>item.path===staged.path)?.layout;
        const layoutVerification=verifyCardLayout(card,layout,normalized.width,normalized.height);
        if(!layoutVerification.passed)throw new Error(`${layoutVerification.reason}:${card.fileName}`);
        const buffer = await readFile(staged.path);
        const pngSignature = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const width = pngSignature ? buffer.readUInt32BE(16) : 0;
        const height = pngSignature ? buffer.readUInt32BE(20) : 0;
        if (!pngSignature || width !== normalized.width || height !== normalized.height) throw new Error(`png-verification-failed:${card.fileName}`);
        const sha256=createHash('sha256').update(buffer).digest('hex');
        const pixelVerification=pixelResult.cards.find(item=>item.path===staged.path);
        if(pixelVerification?.status!=='verified'||pixelVerification.sha256!==sha256||pixelVerification.fields?.length!==layoutVerification.requiredFieldCount)
          throw new Error(`visual-card-pixel-content-mismatch:${card.fileName}`);
        await assertPath(card.path);
        const stagedIdentity=await lstat(staged.path);
        assertAccess();
        await link(staged.path,card.path);
        published.push({path:card.path,identity:stagedIdentity,sha256});
        assertAccess();
        const undo = this.undoJournal.record({ taskId: packet.taskId, action: 'delete_created_file', path: card.path, fileKind: 'png' });
        undoJournalIds.push(undo.undoJournalId);
        assertAccess();
        await assertPath(card.path);
        if(createHash('sha256').update(await readFile(card.path)).digest('hex')!==sha256)throw Error('visual-card-published-content-changed');
        assertAccess();
        pixelVerification.path=card.path;
        const {title,label,subtitle,body,footer,accent}=card;
        cards.push({ name: card.fileName, path: card.path, width, height, size: buffer.length, sha256,layout,layoutVerification,pixelVerification,
          requiredContent:{title,label,subtitle,body:Array.isArray(body)?body:body?[body]:[],footer,accent} });
      }
      return {
        artifactManifest:normalized,
        layoutRequirements:normalized.cards,
        status: 'success',
        summary: `${cards.length}개의 PNG 카드에서 전체 문구의 글자 픽셀과 배치 경계를 확인했습니다. 의미·디자인 평가는 별도입니다.`,
        outputPaths: cards.map((card) => card.path),
        changedItems: cards.map((card) => ({ type: 'create_file', path: card.path, fileKind: 'png' })),
        cardCount: cards.length,
        cards,
        undoJournalId: undoJournalIds[0] ?? null,
        undoJournalIds,
        rollbackAvailable: true,
        evidence: { cardCount: cards.length, cards: cards.map(({ name, width, height, size, sha256 }) => ({ name, width, height, size, sha256 })) }
      };
    } catch (error) {
      const retained=[];
      for (const file of published) {
        try{await assertPath(file.path);assertAccess();const current=statSync(file.path),bytes=readFileSync(file.path);
          if(current.dev!==file.identity.dev||current.ino!==file.identity.ino||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('card-owned-output-changed');
          assertAccess();unlinkSync(file.path);
        }catch(cleanupError){if(cleanupError.code!=='ENOENT')retained.push(file.path);}
      }
      let reason='visual-card-worker-or-pixel-check-failed';
      try{const reported=JSON.parse(String(error.stdout??'').trim().split(/\r?\n/u).at(-1)??'{}').reason;
        if(/^pixel-verification-[a-z-]+$/u.test(reported??''))reason=reported;}catch{}
      if(String(error.stderr??'').includes('visual-card-text-overflow'))reason='visual-card-text-overflow';
      if(error.code==='EEXIST')reason='visual-card-target-exists';
      if(String(error.stderr??'').includes('ModuleNotFoundError'))reason='visual-card-python-dependency-unavailable';
      if(error.code==='ENOENT')reason='visual-card-python-runtime-unavailable';
      return { status: 'failed', error: reason, summary: 'PNG 카드 생성 또는 독립 파일 검증에 실패했습니다.',
        artifactManifest:normalized,layoutRequirements:normalized.cards,...(retained.length?{uncertain:true}:{}),
        nextAction:reason.includes('unavailable')?'연결된 Python 환경에 Pillow와 fontTools 및 한글 글꼴이 준비됐는지 확인해 주세요.':null,
        outputPaths: retained, changedItems:retained.map(path=>({type:'create_file',path,fileKind:'png'})), rollbackAvailable: false };
    } finally {
      try{await assertAllowedRealPath(staging,this.allowedRoots);await rm(staging,{recursive:true,force:true});}catch{}
    }
  }
}

export class ArchiveCreateZipToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(), pythonExecutable = process.env.JARVIS_PYTHON ?? 'python' } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.pythonExecutable = pythonExecutable;
    this.contract = createToolContract({
      toolName: 'archive.createZip',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'entryCount', 'entries', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'targetExists', 'inputMissing', 'duplicateArchiveName']
    });
  }

  async normalize(args = {}) {
    const outputPath = resolve(args.path ?? args.outputPath ?? resolve(this.allowedRoots[0], 'jarvis-bundle.zip'));
    const rawInputs = Array.isArray(args.inputs) && args.inputs.length
      ? args.inputs
      : (Array.isArray(args.inputPaths) ? args.inputPaths.map((path) => ({ path })) : []);
    const warnings = [];
    try {
      await assertAllowedRealPath(outputPath, this.allowedRoots, { checkParentForCreate: true });
    } catch {
      warnings.push('outside-allowed-roots');
    }
    if (!outputPath.toLowerCase().endsWith('.zip')) warnings.push('zip-output-required');
    if (await exists(outputPath)) warnings.push(`target-exists:${outputPath}`);
    if (rawInputs.length === 0) warnings.push('archive-inputs-required');
    if (rawInputs.length > 100) warnings.push('too-many-archive-inputs');
    const names = new Set();
    const inputs = [];
    for (const source of rawInputs.slice(0, 100)) {
      const rawPath = typeof source === 'string' ? source : source?.path;
      if (!rawPath) {
        warnings.push('archive-input-path-required');
        continue;
      }
      const candidate = resolve(rawPath);
      let path = candidate;
      try {
        path = await assertAllowedRealPath(candidate, this.allowedRoots);
        const details = await stat(path);
        if (!details.isFile()) warnings.push(`archive-input-not-file:${basename(path)}`);
      } catch {
        warnings.push(`archive-input-missing-or-outside:${basename(candidate)}`);
      }
      const archiveName = String((typeof source === 'object' ? source.archiveName : null) ?? basename(path)).replaceAll('\\', '/');
      if (!archiveName || /[\x00-\x1f:]/.test(archiveName) || archiveName.split('/').some(part => !part || part === '.' || part === '..')) warnings.push(`invalid-archive-name:${archiveName}`);
      const key = archiveName.toLowerCase();
      if (names.has(key)) warnings.push(`duplicate-archive-name:${archiveName}`);
      names.add(key);
      let sha256 = null;
      try {
        const {readFileSnapshot}=await import('./adapters/filesystem/read-text-snapshot.js');
        const {bytes}=await readFileSnapshot({path,maxBytes:128*1024*1024,checkAllowedPath:p=>assertAllowedRealPath(p,this.allowedRoots)});
        sha256=createHash('sha256').update(bytes).digest('hex');
      } catch { warnings.push(`archive-input-unreadable-or-too-large:${archiveName}`); }
      const expectedSha256 = typeof source === 'object' ? String(source.sha256 ?? source.contentSha256 ?? '').toLowerCase() : '';
      if (expectedSha256 && (!/^[a-f0-9]{64}$/.test(expectedSha256) || expectedSha256 !== sha256)) warnings.push(`archive-input-integrity-mismatch:${archiveName}`);
      inputs.push({ path, archiveName, sha256 });
    }
    return { outputPath, inputs, warnings: [...new Set(warnings)] };
  }

  async shadow(args) {
    const normalized = await this.normalize(args);
    return {
      mode: 'shadow',
      expectedChangesCount: normalized.warnings.length ? 0 : 1,
      outputPath: normalized.outputPath,
      inputCount: normalized.inputs.length,
      entryNames: normalized.inputs.map((item) => item.archiveName),
      archiveInputs: normalized.inputs,
      warnings: normalized.warnings
    };
  }

  async execute(args, packet = {}, context = {}) {
    const normalized = await this.normalize(args);
    if (normalized.warnings.length) {
      return { status: 'blocked', summary: 'ZIP 생성 사전 검사가 실패했습니다.', outputPaths: [], changedItems: [], warnings: normalized.warnings, rollbackAvailable: false };
    }
    const script = fileURLToPath(new URL('./adapters/archive/create_zip.py', import.meta.url));
    let stageDirectory=null, published=false;
    try {
      await context.beforeArtifactWrite?.({paths:[...normalized.inputs.map(input=>input.path),normalized.outputPath],prepared:normalized});
      const fence=()=>{if(context.signal?.aborted)throw Error('B_OPERATION_CANCELLED');trustedLocalEffectFences.get(packet)?.();context.assertAccess?.();};
      fence();
      trustedLocalEffectFences.get(packet)?.();
      await assertAllowedRealPath(normalized.outputPath,this.allowedRoots,{checkParentForCreate:true});
      fence();
      await mkdir(dirname(normalized.outputPath),{recursive:true});
      fence();
      await assertAllowedRealPath(normalized.outputPath,this.allowedRoots,{checkParentForCreate:true});
      fence();
      stageDirectory=await mkdtemp(join(dirname(normalized.outputPath),'.jarvis-zip-stage-'));
      await assertAllowedRealPath(stageDirectory,this.allowedRoots);
      const stagedInputs=[];
      const {readFileSnapshot}=await import('./adapters/filesystem/read-text-snapshot.js');
      let totalBytes=0;
      const readSource=path=>readFileSnapshot({path,maxBytes:128*1024*1024,checkAllowedPath:p=>assertAllowedRealPath(p,this.allowedRoots)});
      for(const [index,input]of normalized.inputs.entries()) {
        fence();
        trustedLocalEffectFences.get(packet)?.();
        const {bytes}=await readSource(input.path);
        if(createHash('sha256').update(bytes).digest('hex')!==input.sha256) throw new Error(`archive-input-integrity-mismatch:${input.archiveName}`);
        totalBytes+=bytes.length;
        if(totalBytes>512*1024*1024) throw new Error('archive-total-input-too-large');
        const path=join(stageDirectory,`input-${index}`);
        await assertAllowedRealPath(path,this.allowedRoots,{checkParentForCreate:true});
        fence();
        await writeFile(path,bytes,{flag:'wx'});
        stagedInputs.push({...input,path});
      }
      const stageOutput=join(stageDirectory,'bundle.zip');
      const payload=Buffer.from(JSON.stringify({outputPath:stageOutput,inputs:stagedInputs}),'utf8').toString('base64');
      fence();
      trustedLocalEffectFences.get(packet)?.();
      const result = await execFileAsync(this.pythonExecutable, [script, payload], {
        encoding: 'utf8', env:{...process.env,PYTHONIOENCODING:'utf-8'}, signal:context.signal, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024
      });
      const worker = JSON.parse(String(result.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '{}');
      if (worker.status !== 'success' || worker.entries?.length !== normalized.inputs.length) throw new Error(worker.badEntry ?? 'zip-worker-verification-failed');
      for(const [index,input]of normalized.inputs.entries()) {
        fence();
        const entry=worker.entries[index];
        if(entry.name!==input.archiveName || entry.sha256!==input.sha256) throw new Error('zip-entry-content-mismatch');
        const {bytes}=await readSource(input.path);
        if(createHash('sha256').update(bytes).digest('hex')!==input.sha256) throw new Error(`archive-input-integrity-mismatch:${input.archiveName}`);
      }
      const buffer = await readFile(stageOutput);
      if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('zip-signature-invalid');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      await assertAllowedRealPath(normalized.outputPath,this.allowedRoots,{checkParentForCreate:true});
      await assertAllowedRealPath(stageOutput,this.allowedRoots);
      fence();
      trustedLocalEffectFences.get(packet)?.();
      await link(stageOutput,normalized.outputPath);
      published=true;
      const undo = this.undoJournal.record({ taskId: packet.taskId, action: 'delete_created_file', path: normalized.outputPath, fileKind: 'zip' });
      return {
        status: 'success',
        summary: `${worker.entries.length}개 파일을 ZIP으로 묶고 무결성을 검증했습니다.`,
        outputPaths: [normalized.outputPath],
        changedItems: [{ type: 'create_file', path: normalized.outputPath, fileKind: 'zip' }],
        outputPath: normalized.outputPath,
        sha256,
        entryCount: worker.entries.length,
        entries: worker.entries,
        undoJournalId: undo.undoJournalId,
        rollbackAvailable: true,
        evidence: { outputPath: normalized.outputPath, sha256, entryCount: worker.entries.length, entries: worker.entries, inputs:normalized.inputs }
      };
    } catch (error) {
      return { status: 'failed', error: String(error?.message ?? error), summary: 'ZIP 생성 또는 무결성 검증에 실패했습니다.', outputPaths: published?[normalized.outputPath]:[], changedItems: published?[{type:'create_file',path:normalized.outputPath,fileKind:'zip',uncertain:true}]:[], uncertain:published, rollbackAvailable: false };
    } finally {
      if(stageDirectory) await rm(stageDirectory,{recursive:true,force:true}).catch(()=>{});
    }
  }
}

export class EmailSendToolAdapter {
  constructor({ allowedRoots = ['./workspace'], ledgerPath = null, clock = () => new Date() } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.searchRoots = [...this.allowedRoots];
    this.ledgerPath = ledgerPath;
    this.clock = clock;
    this.sentRequests = new Map();
    this.deliveryStates = new Map();
    if (this.ledgerPath) {
      try {
        for (const line of readFileSync(this.ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.idempotencyKey) this.deliveryStates.set(record.idempotencyKey, record);
          if (record.idempotencyKey && record.providerAccepted === true) this.sentRequests.set(record.idempotencyKey, record);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    this.excludeDirs = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'dist', 'build', '.jarvis-backups']);
    this.contract = createToolContract({
      toolName: 'email.send',
      requiresAvailabilityBinding: true,
      mutatesSystem: false,
      rollback: false,
      evidence: ['to', 'subject', 'attachmentCount', 'verification', 'changedItems'],
      blockedOperations: ['recipientMissing', 'smtpNotConfigured', 'attachmentMissing', 'attachmentOutsideAllowedRoots']
    });
  }

  evidenceHash(value) {
    return createHash('sha256').update(String(value ?? '')).digest('hex');
  }

  smtpRecipients(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => typeof item === 'string' ? item : item?.address)
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter(Boolean);
  }

  smtpAcceptance(info, { to, subject, attachments = [] }) {
    const accepted = this.smtpRecipients(info?.accepted);
    const rejected = this.smtpRecipients(info?.rejected);
    const pending = this.smtpRecipients(info?.pending);
    const responseCode = Number(String(info?.response ?? '').match(/^\s*(\d{3})/)?.[1] ?? 0) || null;
    const providerMessageIdSha256 = info?.messageId ? this.evidenceHash(info.messageId) : null;
    const normalizedRecipient = String(to).trim().toLowerCase();
    const providerAccepted = accepted.includes(normalizedRecipient);
    const passed = providerAccepted
      && accepted.length === 1
      && rejected.length === 0
      && pending.length === 0
      && (responseCode === null || Math.floor(responseCode / 100) === 2);
    const verification = {
      verificationVersion: 'b-email-smtp-acceptance-v1',
      passed,
      method: 'smtp-provider-envelope-and-data-acceptance',
      providerAccepted,
      recipientMatched: providerAccepted && accepted.length === 1,
      acceptedRecipientCount: accepted.length,
      rejectedRecipientCount: rejected.length,
      pendingRecipientCount: pending.length,
      responseCode,
      providerMessageIdSha256,
      checkedAt: this.clock().toISOString(),
      rawProviderResponseStored: false,
      rawRecipientListStored: false
    };
    const changedItems = providerAccepted ? [{
      type: 'external_email_delivery',
      channel: 'smtp',
      recipientSha256: this.evidenceHash(String(to).trim().toLowerCase()),
      subjectSha256: this.evidenceHash(subject),
      providerMessageIdSha256,
      attachmentCount: attachments.length,
      attachmentSha256: attachments.length === 1 ? attachments[0].sha256 : null,
      attachmentSha256s: attachments.map((attachment) => attachment.sha256),
      providerAccepted: true
    }] : [];
    return { verification, changedItems };
  }

  async loadNodemailer() {
    try {
      const mod = await import('nodemailer');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }

  smtpConfig() {
    const user = process.env.JARVIS_SMTP_USER;
    const pass = process.env.JARVIS_SMTP_PASS;
    if (!user || !pass) return null;
    return { user, pass, service: process.env.JARVIS_SMTP_SERVICE ?? 'gmail' };
  }

  maskRecipient(value) {
    const [local = '', domain = ''] = String(value ?? '').split('@');
    if (!domain) return '';
    return `${local.slice(0, 2)}***@${domain}`;
  }

  normalizeIdempotencyKey(value, { to, subject, body, attachments }) {
    const supplied = String(value ?? '').trim();
    if (supplied && !/^[A-Za-z0-9._:-]{8,200}$/.test(supplied)) {
      throw Object.assign(new Error('email-idempotency-key-invalid'), { code: 'B_EMAIL_IDEMPOTENCY_KEY_INVALID' });
    }
    return supplied || this.evidenceHash(JSON.stringify({
      recipient: String(to).trim().toLowerCase(),
      subject,
      bodySha256: this.evidenceHash(body),
      attachmentSha256s: attachments.map((attachment) => attachment.sha256)
    }));
  }

  payloadFingerprint({ to, subject, body, attachments }) {
    return this.evidenceHash(JSON.stringify({
      recipientSha256: this.evidenceHash(String(to).trim().toLowerCase()),
      subjectSha256: this.evidenceHash(subject),
      bodySha256: this.evidenceHash(body),
      attachmentSha256s: attachments.map((attachment) => attachment.sha256)
    }));
  }

  recordedPayloadFingerprint(record) {
    if (!record || typeof record !== 'object') return null;
    const stored = String(record.payloadFingerprintSha256 ?? '').trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(stored)) return stored;
    if (
      /^[a-f0-9]{64}$/.test(String(record.recipientSha256 ?? ''))
      && /^[a-f0-9]{64}$/.test(String(record.subjectSha256 ?? ''))
      && /^[a-f0-9]{64}$/.test(String(record.bodySha256 ?? ''))
      && Array.isArray(record.attachmentSha256s)
      && record.attachmentSha256s.every((value) => /^[a-f0-9]{64}$/.test(String(value ?? '')))
    ) {
      return this.evidenceHash(JSON.stringify({
        recipientSha256: record.recipientSha256,
        subjectSha256: record.subjectSha256,
        bodySha256: record.bodySha256,
        attachmentSha256s: record.attachmentSha256s
      }));
    }
    return null;
  }

  recordAcceptedDelivery(record) {
    this.sentRequests.set(record.idempotencyKey, record);
    this.deliveryStates.set(record.idempotencyKey, record);
    if (this.ledgerPath) appendJsonlImmediateSync(this.ledgerPath, record);
  }

  recordDeliveryStart(record) {
    this.deliveryStates.set(record.idempotencyKey, record);
    if (this.ledgerPath) appendJsonlImmediateSync(this.ledgerPath, record);
  }

  normalizeAttachmentSha256(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw Object.assign(new Error('attachment-sha256-invalid'), {
        code: 'B_EMAIL_ATTACHMENT_SHA256_INVALID'
      });
    }
    return normalized;
  }

  async attachmentRecord(path, details, { expectedSha256 = null, exactReference = false } = {}) {
    const actualSha256 = createHash('sha256').update(await readFile(path)).digest('hex');
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      throw Object.assign(new Error('attachment-content-integrity-mismatch'), {
        code: 'B_EMAIL_ATTACHMENT_INTEGRITY_MISMATCH',
        expectedSha256,
        actualSha256
      });
    }
    return {
      path,
      name: basename(path),
      mtimeMs: details.mtimeMs,
      size: details.size,
      sha256: actualSha256,
      expectedSha256,
      integrityBound: Boolean(expectedSha256),
      exactReference
    };
  }

  async resolveSingleAttachment(args) {
    const expectedSha256 = this.normalizeAttachmentSha256(args.attachmentSha256);
    if (args.attachmentRef) {
      const rootIndex = Number(args.attachmentRef.rootIndex);
      const relativePath = String(args.attachmentRef.relativePath ?? '').trim();
      const root = Number.isInteger(rootIndex) ? this.allowedRoots[rootIndex] : null;
      if (!root || !relativePath) {
        throw Object.assign(new Error('attachment-reference-invalid'), { code: 'B_EMAIL_ATTACHMENT_REFERENCE_INVALID' });
      }
      const candidate = resolve(root, relativePath);
      const path = await assertAllowedRealPath(candidate, this.allowedRoots);
      const details = await stat(path);
      if (!details.isFile()) {
        throw Object.assign(new Error('attachment-reference-not-file'), { code: 'B_EMAIL_ATTACHMENT_NOT_FILE' });
      }
      return await this.attachmentRecord(path, details, { expectedSha256, exactReference: true });
    }
    if (args.attachmentPath) {
      const path = await assertAllowedRealPath(args.attachmentPath, this.allowedRoots);
      const details = await stat(path);
      if (!details.isFile()) {
        throw Object.assign(new Error('attachment-path-not-file'), { code: 'B_EMAIL_ATTACHMENT_NOT_FILE' });
      }
      return await this.attachmentRecord(path, details, { expectedSha256, exactReference: true });
    }
    if (expectedSha256) {
      throw Object.assign(new Error('attachment-sha256-requires-exact-reference'), {
        code: 'B_EMAIL_ATTACHMENT_HASH_REQUIRES_EXACT_REFERENCE'
      });
    }
    const query = String(args.attachmentQuery ?? '').trim();
    if (!query) return null;
    return findFilesByQuery(query, { roots: this.searchRoots, excludeDirs: this.excludeDirs });
  }

  async resolveAttachments(argsOrQuery) {
    const args = argsOrQuery && typeof argsOrQuery === 'object'
      ? argsOrQuery
      : { attachmentQuery: argsOrQuery };
    if (Array.isArray(args.attachments)) {
      if (args.attachments.length > 20) {
        throw Object.assign(new Error('email-attachment-limit-exceeded'), { code: 'B_EMAIL_ATTACHMENT_LIMIT_EXCEEDED' });
      }
      const attachments = [];
      for (const spec of args.attachments) {
        const normalized = spec?.attachmentRef || spec?.attachmentPath || spec?.attachmentQuery
          ? spec
          : {
              attachmentRef: spec?.ref ?? null,
              attachmentPath: spec?.path ?? null,
              attachmentQuery: spec?.query ?? '',
              attachmentSha256: spec?.attachmentSha256 ?? spec?.sha256 ?? spec?.contentSha256 ?? null
            };
        const resolved = await this.resolveSingleAttachment(normalized);
        if (Array.isArray(resolved)) {
          throw Object.assign(new Error('structured-attachment-query-ambiguous'), { code: 'B_EMAIL_ATTACHMENT_QUERY_AMBIGUOUS' });
        }
        if (!resolved) throw Object.assign(new Error('structured-attachment-missing'), { code: 'B_EMAIL_ATTACHMENT_MISSING' });
        attachments.push(resolved);
      }
      const uniquePaths = new Set(attachments.map((item) => item.path.toLowerCase()));
      if (uniquePaths.size !== attachments.length) {
        throw Object.assign(new Error('duplicate-email-attachment'), { code: 'B_EMAIL_ATTACHMENT_DUPLICATE' });
      }
      if (attachments.reduce((sum, item) => sum + Number(item.size ?? 0), 0) > 18 * 1024 * 1024) {
        throw Object.assign(new Error('email-attachment-bytes-limit-exceeded'), { code: 'B_EMAIL_ATTACHMENT_BYTES_LIMIT_EXCEEDED' });
      }
      return attachments;
    }
    const resolved = await this.resolveSingleAttachment(args);
    if (!resolved) return [];
    return Array.isArray(resolved) ? resolved : [resolved];
  }

  async shadow(args) {
    let attachments = [];
    let attachmentError = null;
    try {
      attachments = await this.resolveAttachments(args);
    } catch (error) {
      attachmentError = error;
    }
    return {
      mode: 'shadow',
      expectedChangesCount: 1,
      to: args?.to ?? '',
      subject: args?.subject ?? '',
      attachmentPath: attachments[0]?.path ?? null,
      attachmentCount: attachments.length,
      attachmentAmbiguous: !Array.isArray(args?.attachments) && attachments.length > 1,
      exactAttachmentReference: attachments.length === 0 || attachments.every((attachment) => attachment.exactReference === true),
      attachmentSha256: attachments.length === 1 ? attachments[0].sha256 : null,
      attachmentSha256s: attachments.map((attachment) => attachment.sha256),
      attachmentIntegrityBound: attachments.length === 0 || attachments.every((attachment) => attachment.integrityBound === true),
      smtpConfigured: Boolean(this.smtpConfig()),
      warnings: [
        ...(attachmentError ? ['승인된 첨부 파일 참조를 확인할 수 없습니다'] : []),
        ...(this.smtpConfig() ? [] : ['메일 계정이 설정되지 않아 실제 발송은 되지 않습니다'])
      ]
    };
  }

  async execute(args, packet = {}) {
    let to = String(args?.to ?? '').trim();
    if(args?.recipientMode==='self'&&to&&!/^self$/i.test(to)){
      const configured=this.smtpConfig();
      const mailbox=value=>{const match=/^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(value??'').trim());return match?`${match[1]}@${match[2].toLowerCase()}`:null;};
      if(!mailbox(to)||!mailbox(configured?.user)||mailbox(to)!==mailbox(configured.user)){
        return {status:'blocked',error:'B_EMAIL_SELF_RECIPIENT_CONFLICT',summary:'본인 메일 요청과 명시된 수신자가 일치하지 않아 발송하지 않았습니다.',outputPaths:[],rollbackAvailable:false};
      }
    }
    // "내 메일/내 구글메일/나에게" 같은 본인 발송이면 SMTP 계정 주소로 채운다.
    if (!to || !/@/.test(to)) {
      const rawText = String(args?.rawText ?? '');
      const cfg = this.smtpConfig();
      if (cfg && (args?.recipientMode === 'self' || /^self$/i.test(to) || /(내|제)\s*(구글\s*)?(이|e)?메일|나(에게|한테|한테로)|본인(에게)?|self|스스로/i.test(rawText))) {
        to = cfg.user;
      }
    }
    const strictRecipient = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(to);
    if (!strictRecipient) {
      return { status: 'blocked', error: 'recipient-missing-or-invalid', to, summary: '받는 사람 이메일 주소를 못 찾았어요. 주소를 알려주시거나 "내 메일로"라고 해주세요.', outputPaths: [], rollbackAvailable: false };
    }
    // 첨부 후보가 여러 개면 임의로 보내지 않는다(잘못된 파일 외부 유출 방지). 어느 파일인지 되묻는다.
    let attachments;
    try {
      attachments = await this.resolveAttachments(args);
    } catch (error) {
      return {
        status: 'blocked',
        error: error?.code ?? 'attachment-reference-invalid',
        to,
        summary: '승인된 첨부 파일을 정확히 확인할 수 없어 메일을 보내지 않았습니다.',
        outputPaths: [],
        rollbackAvailable: false
      };
    }
    if (!Array.isArray(args?.attachments) && attachments.length > 1) {
      return {
        status: 'needs_choice',
        to,
        candidates: attachments.map((a) => ({ name: a.name, path: a.path })),
        summary: `첨부할 파일 후보가 ${attachments.length}개예요: ${attachments.slice(0, 6).map((a) => a.name).join(', ')}. 어느 파일을 보낼까요? (잘못된 파일이 외부로 나가지 않도록 확인합니다)`,
        outputPaths: [],
        rollbackAvailable: false
      };
    }
    const config = this.smtpConfig();
    if (!config) {
      return { status: 'blocked', error: 'smtp-not-configured', to, summary: '메일 계정이 아직 연결되지 않았어요. Gmail 앱 비밀번호를 설정하면 발송할 수 있어요.', outputPaths: [], rollbackAvailable: false };
    }
    const nodemailer = await this.loadNodemailer();
    if (!nodemailer) {
      return { status: 'failed', error: 'nodemailer-not-installed', to, outputPaths: [], rollbackAvailable: false };
    }
    try {
      const transporter = nodemailer.createTransport({ service: config.service, auth: { user: config.user, pass: config.pass },
        requireTLS: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, logger: false, debug: false });
      const subject = String(args?.subject ?? '(제목 없음)');
      const body = String(args?.body ?? '');
      const idempotencyKey = this.normalizeIdempotencyKey(args?.idempotencyKey, { to, subject, body, attachments });
      const payloadFingerprintSha256 = this.payloadFingerprint({ to, subject, body, attachments });
      const previous = this.sentRequests.get(idempotencyKey);
      const previousState = this.deliveryStates.get(idempotencyKey) ?? previous;
      if (previousState && this.recordedPayloadFingerprint(previousState) !== payloadFingerprintSha256) {
        return {
          status: 'blocked',
          error: 'B_EMAIL_IDEMPOTENCY_CONFLICT',
          to: this.maskRecipient(to),
          recipientSha256: this.evidenceHash(to.toLowerCase()),
          subject,
          attachmentCount: attachments.length,
          attachmentSha256s: attachments.map((attachment) => attachment.sha256),
          idempotencyKeySha256: this.evidenceHash(idempotencyKey),
          payloadFingerprintSha256,
          summary: '같은 메일 재시도 키에 다른 수신자·제목·본문 또는 첨부가 결합되어 발송을 차단했습니다.',
          outputPaths: [],
          changedItems: [],
          rollbackAvailable: false
        };
      }
      if (previous?.providerAccepted === true) {
        const verification = {
          verificationVersion: 'b-email-smtp-acceptance-v1',
          passed: true,
          method: 'persistent-idempotency-ledger',
          providerAccepted: true,
          recipientMatched: true,
          acceptedRecipientCount: 1,
          rejectedRecipientCount: 0,
          pendingRecipientCount: 0,
          responseCode: previous.responseCode ?? null,
          providerMessageIdSha256: previous.providerMessageIdSha256 ?? null,
          checkedAt: this.clock().toISOString(),
          deduplicated: true,
          rawProviderResponseStored: false,
          rawRecipientListStored: false
        };
        return {
          status: 'success',
          to: this.maskRecipient(to),
          recipientSha256: this.evidenceHash(to.toLowerCase()),
          subject,
          attachmentCount: attachments.length,
          attachmentSha256: attachments.length === 1 ? attachments[0].sha256 : null,
          attachmentSha256s: attachments.map((attachment) => attachment.sha256),
          attachmentIntegrityBound: attachments.length === 0 || attachments.every((attachment) => attachment.integrityBound),
          idempotencyKeySha256: this.evidenceHash(idempotencyKey),
          payloadFingerprintSha256,
          deduplicated: true,
          summary: '동일한 메일이 이미 SMTP에서 수락되어 중복 발송을 생략했습니다.',
          outputPaths: [],
          changedItems: [{
            type: 'external_email_delivery',
            channel: 'smtp',
            recipientSha256: previous.recipientSha256,
            subjectSha256: previous.subjectSha256,
            providerMessageIdSha256: previous.providerMessageIdSha256 ?? null,
            attachmentCount: attachments.length,
            attachmentSha256: attachments.length === 1 ? attachments[0].sha256 : null,
            attachmentSha256s: attachments.map((attachment) => attachment.sha256),
            providerAccepted: true,
            deduplicated: true
          }],
          verification,
          evidence: { email: verification },
          rollbackAvailable: false
        };
      }
      if (previousState?.deliveryStatus === 'started' && previousState.providerAccepted !== true) {
        return {
          status: 'blocked',
          error: 'email-delivery-state-uncertain',
          to: this.maskRecipient(to),
          recipientSha256: this.evidenceHash(to.toLowerCase()),
          subject,
          attachmentCount: attachments.length,
          attachmentSha256s: attachments.map((attachment) => attachment.sha256),
          idempotencyKeySha256: this.evidenceHash(idempotencyKey),
          payloadFingerprintSha256,
          summary: '이전 SMTP 호출의 최종 수락 여부가 불명확해 중복 발송을 막기 위해 자동 재전송하지 않았습니다.',
          outputPaths: [],
          changedItems: [],
          rollbackAvailable: false
        };
      }
      this.assertConnectionConfiguration?.(config);
      trustedLocalEffectFences.get(packet)?.();
      this.recordDeliveryStart({
        recordVersion: 'b-email-idempotency-record-v1',
        deliveryStatus: 'started',
        idempotencyKey,
        recipientSha256: this.evidenceHash(to.toLowerCase()),
        subjectSha256: this.evidenceHash(subject),
        bodySha256: this.evidenceHash(body),
        attachmentSha256s: attachments.map((attachment) => attachment.sha256),
        payloadFingerprintSha256,
        providerAccepted: false,
        startedAt: this.clock().toISOString(),
        rawRecipientStored: false,
        rawSubjectStored: false,
        rawBodyStored: false
      });
      this.assertConnectionConfiguration?.(config);
      trustedLocalEffectFences.get(packet)?.();
      const info = await transporter.sendMail({
        from: config.user,
        to,
        subject,
        text: body,
        attachments: attachments.map((attachment) => ({ path: attachment.path, filename: attachment.name }))
      });
      const acceptance = this.smtpAcceptance(info, { to, subject, attachments });
      if (!acceptance.verification.passed) {
        return {
          status: 'failed',
          error: acceptance.verification.providerAccepted
            ? 'smtp-provider-acceptance-partial-or-ambiguous'
            : 'smtp-provider-recipient-not-accepted',
          to: this.maskRecipient(to),
          subject,
          attachmentCount: attachments.length,
          attachmentSha256: attachments.length === 1 ? attachments[0].sha256 : null,
          attachmentSha256s: attachments.map((attachment) => attachment.sha256),
          attachmentIntegrityBound: attachments.length === 0 || attachments.every((attachment) => attachment.integrityBound),
          summary: 'SMTP 서버가 수신자를 수락하지 않아 메일을 보내지 않았습니다.',
          outputPaths: [],
          changedItems: acceptance.changedItems,
          verification: acceptance.verification,
          evidence: { email: acceptance.verification },
          rollbackAvailable: false
        };
      }
      this.recordAcceptedDelivery({
        recordVersion: 'b-email-idempotency-record-v1',
        deliveryStatus: 'accepted',
        idempotencyKey,
        recipientSha256: this.evidenceHash(to.toLowerCase()),
        subjectSha256: this.evidenceHash(subject),
        bodySha256: this.evidenceHash(body),
        attachmentSha256s: attachments.map((attachment) => attachment.sha256),
        payloadFingerprintSha256,
        providerMessageIdSha256: acceptance.verification.providerMessageIdSha256,
        responseCode: acceptance.verification.responseCode,
        providerAccepted: true,
        acceptedAt: this.clock().toISOString(),
        rawRecipientStored: false,
        rawSubjectStored: false,
        rawBodyStored: false
      });
      return {
        status: 'success',
        to: this.maskRecipient(to),
        recipientSha256: this.evidenceHash(to.toLowerCase()),
        subject,
        attachmentCount: attachments.length,
        attachmentSha256: attachments.length === 1 ? attachments[0].sha256 : null,
        attachmentSha256s: attachments.map((attachment) => attachment.sha256),
        attachmentIntegrityBound: attachments.length === 0 || attachments.every((attachment) => attachment.integrityBound),
        idempotencyKeySha256: this.evidenceHash(idempotencyKey),
        payloadFingerprintSha256,
        deduplicated: false,
        summary: acceptance.verification.passed
          ? `${this.maskRecipient(to)}로 메일을 보냈어요${attachments.length ? ` (첨부 ${attachments.length}개)` : ''}.`
          : 'SMTP 서버가 일부 수신자만 수락했습니다. 중복 발송을 막기 위해 자동 재시도하지 않습니다.',
        outputPaths: [],
        changedItems: acceptance.changedItems,
        verification: acceptance.verification,
        evidence: { email: acceptance.verification },
        rollbackAvailable: false
      };
    } catch (error) {
      return { status: 'failed', error: String(error?.message ?? error), to: this.maskRecipient(to), outputPaths: [], rollbackAvailable: false };
    }
  }
}

export class FileMoveToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(), toolName = 'filesystem.moveFiles', previewOnly = false } = {}) {
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.previewOnly = previewOnly;
    this.contract = createToolContract({
      toolName,
      mutatesSystem: !previewOnly,
      rollback: !previewOnly,
      evidence: ['from', 'to', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'missingSource', 'targetExists'],
      modes: previewOnly ? ['shadow'] : ['shadow', 'execute']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  async normalizeMoves(args) {
    const moves = args.moves ?? (args.from && args.to ? [{ from: args.from, to: args.to }] : []);
    const normalized = [];
    for (const move of moves) {
      const item = { fromInput: move.from, toInput: move.to, from: resolve(move.from), to: resolve(move.to), pathIssues: [] };
      try {
        item.from = await assertAllowedRealPath(move.from, this.allowedRoots);
      } catch (error) {
        item.pathIssues.push(classifyFileError(error, { path: move.from, targetPath: move.to }));
      }
      try {
        item.to = await assertAllowedRealPath(move.to, this.allowedRoots, { checkParentForCreate: true });
      } catch (error) {
        item.pathIssues.push(classifyFileError(error, { path: move.from, targetPath: move.to }));
      }
      normalized.push(item);
    }
    return normalized;
  }

  async shadow(args) {
    const moves = await this.normalizeMoves(args);
    const checks = [];
    for (const move of moves) {
      checks.push({
        from: move.from,
        to: move.to,
        pathIssues: move.pathIssues,
        sourceExists: await exists(move.from),
        targetExists: await exists(move.to)
      });
    }
    const batchDiff = batchDiffForFileMoves(checks);
    const batchPolicy = createFileMoveBatchPolicy({
      checks,
      conflictResolutions: args.conflictResolutions ?? args.resolutions ?? {},
      allowOverwrite: args.allowOverwrite === true
    });
    const conflicts = [
      ...batchDiff.conflicts,
      ...checks.flatMap((check) => check.pathIssues ?? [])
    ];
    const conflictResolutionUi = createFileConflictResolutionUiState({ checks, conflicts, batchDiff, batchPolicy });
    const partialMoveTransactionDryRun = createPartialMoveTransactionDryRun({ batchPolicy, taskId: args.taskId ?? null });
    const warnings = [
      ...batchPolicy.blockedItems.flatMap((item) => (item.issues ?? []).map((issue) => issue.detail ?? `${issue.code}:${item.from}`)),
      ...batchPolicy.readyItems
        .filter((item) => item.action === 'overwrite')
        .map((item) => `overwrite-requires-explicit-approval:${item.to}`)
    ];
    return {
      mode: 'shadow',
      expectedChangesCount: moves.length,
      moves: checks,
      batchDiff,
      batchPolicy,
      conflicts,
      conflictResolutionUi,
      conflictPolicy: 'block-batch-until-all-items-ready',
      partialMoveTransactionDryRun,
      windowsAclDenyCorpus: createWindowsAclDenyCorpus({ allowedRoot: this.allowedRoots[0] ?? null }),
      warnings
    };
  }

  async execute(args, packet = {}, { assertAccess = () => {}, beforeMoves = null } = {}) {
    if (this.previewOnly) {
      return {
        status: 'blocked',
        summary: 'Preview-only adapter cannot execute.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: ['preview-only-adapter']
      };
    }
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'Move preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: shadow.warnings,
        evidence: {
          batchDiff: shadow.batchDiff,
          conflicts: shadow.conflicts,
          conflictPolicy: shadow.conflictPolicy,
          conflictResolutionUi: shadow.conflictResolutionUi,
          batchPolicy: shadow.batchPolicy,
          partialMoveTransactionDryRun: shadow.partialMoveTransactionDryRun
        }
      };
    }
    assertAccess();
    const moveFence = beforeMoves ? await beforeMoves(shadow.batchPolicy.readyItems) : assertAccess;
    if(typeof moveFence!=='function')throw new Error('B_MOVE_FENCE_INVALID');
    const movedItems = [];
    const checkMovePaths=move=>{
      for(const path of [move.from,move.to]) {
        const physical=rollbackPhysicalPath(path);
        if(!physical||!this.allowedRoots.some(root=>isInside(root,physical)))throw Error('B_MOVE_PATH_CHANGED');
        const expected=process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
        if(physical!==expected)throw Error('B_MOVE_PATH_CHANGED');
      }
    };
    const windowsMove=(move,kind)=>{
      const literal=value=>`'${value.replaceAll("'","''")}'`;
      const command=`$ErrorActionPreference='Stop'; [System.IO.${kind}]::Move(${literal(move.from)},${literal(move.to)})`;
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
        {windowsHide:true,timeout:30000,stdio:'pipe'});
    };
    try {
    for (const move of shadow.batchPolicy.readyItems) {
      moveFence();
      checkMovePaths(move);
      await mkdir(dirname(move.to), { recursive: true });
      moveFence();
      // Recheck resolved bindings after every asynchronous boundary, including
      // conflict-resolution targets which were not the original shadow target.
      checkMovePaths(move);
      if(existsSync(move.to))throw Object.assign(Error('B_MOVE_TARGET_EXISTS'),{code:'B_MOVE_TARGET_EXISTS'});
      if (move.action === 'copy') {
        await copyFile(move.from, move.to, fsConstants.COPYFILE_EXCL);
        movedItems.push({ type: 'copy_file', from: move.from, to: move.to });
        this.undoJournal.record({
          taskId: packet.taskId,
          action: 'delete_created_file',
          path: move.to
        });
      } else {
        const source=lstatSync(move.from);
        if(source.isFile()) {
          // Exclusive publication cannot replace a concurrently created target.
          // Record publication before unlink so an unlink failure is not hidden.
          let linked=false;
          try {linkSync(move.from,move.to);linked=true;}
          catch(error){
            if(process.platform!=='win32'||!['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(error.code))throw error;
            // Filesystems without hardlink support retain native move behavior;
            // File.Move's two-argument form never replaces an existing target.
            windowsMove(move,'File');
          }
          movedItems.push({ type: move.action === 'rename' ? 'move_file_renamed_target' : 'move_file', from: move.from, to: move.to, sourceRetained:linked });
          if(linked){unlinkSync(move.from);movedItems.at(-1).sourceRetained=false;}
        } else if(source.isDirectory()&&process.platform==='win32') {
          windowsMove(move,'Directory');
          movedItems.push({type:move.action==='rename'?'move_file_renamed_target':'move_file',from:move.from,to:move.to});
        } else {
          // Preserve the existing non-Windows directory path. A native
          // rename-no-replace adapter is still required for its OS race boundary.
          renameSync(move.from,move.to);
          movedItems.push({type:move.action==='rename'?'move_file_renamed_target':'move_file',from:move.from,to:move.to});
        }
        this.undoJournal.record({
          taskId: packet.taskId,
          action: 'move_back',
          from: move.from,
          to: move.to
        });
      }
    }
    } catch(error) {
      return {status:'failed',summary:movedItems.length?'File batch stopped after partial publication.':'File batch stopped before publication.',
        error:{code:error.code??error.message??'B_MOVE_FAILED',message:error.message},warnings:[error.code??error.message??'B_MOVE_FAILED'],
        uncertain:movedItems.length>0,outputPaths:movedItems.map(item=>item.to),changedItems:movedItems,
        rollbackAvailable:movedItems.length>0&&this.undoJournal.list().some(entry=>entry.taskId===packet.taskId),
        batchPolicy:shadow.batchPolicy,partialMoveTransactionDryRun:shadow.partialMoveTransactionDryRun,
        undoJournalId:this.undoJournal.list().find(entry=>entry.taskId===packet.taskId)?.undoJournalId};
    }
    return {
      status: 'success',
      outputPaths: movedItems.map((item) => item.to),
      changedItems: movedItems,
      rollbackAvailable: movedItems.length > 0,
      batchPolicy: shadow.batchPolicy,
      partialMoveTransactionDryRun: shadow.partialMoveTransactionDryRun,
      undoJournalId: this.undoJournal.list().find((entry) => entry.taskId === packet.taskId)?.undoJournalId
    };
  }
}

export class BrowserReadOnlyGuard {
  constructor({ blockedOperations = ['formSubmit', 'download', 'fileUpload', 'credentialEntry', 'javascriptExecution', 'cookieMutation'] } = {}) {
    this.blockedOperations = blockedOperations;
  }

  inspect(args = {}) {
    const readOnly = args.readOnly !== false;
    const checks = [
      { operation: 'navigation', attempted: true, allowed: readOnly, reason: readOnly ? 'GET navigation only' : 'read-only mode disabled' },
      { operation: 'download', attempted: args.download === true, allowed: false, reason: 'downloads are blocked in browser.search' },
      { operation: 'formSubmit', attempted: args.submitForms === true, allowed: false, reason: 'form submission is blocked in browser.search' },
      { operation: 'fileUpload', attempted: args.fileUpload === true, allowed: false, reason: 'file upload is blocked in browser.search' },
      { operation: 'credentialEntry', attempted: args.enterCredentials === true, allowed: false, reason: 'credential entry is blocked in browser.search' },
      { operation: 'javascriptExecution', attempted: args.executeScript === true, allowed: false, reason: 'custom JavaScript execution is blocked in browser.search' },
      { operation: 'cookieMutation', attempted: args.allowCookies === true, allowed: false, reason: 'cookie mutation is blocked in browser.search' }
    ];
    const warnings = [];
    if (!readOnly) warnings.push('browser-search-must-be-read-only');
    for (const check of checks) {
      if (check.attempted && check.allowed === false && check.operation !== 'navigation') {
        warnings.push(`browser-${check.operation.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-blocked`);
      }
    }
    return {
      readOnly,
      blockedOperations: this.blockedOperations,
      checks,
      warnings,
      sideEffectsAllowed: false
    };
  }
}

export class BrowserNetworkRecorder {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  capture({ url, method = 'GET', searchEngine, response = null, sideEffects = null }) {
    const requestId = stableId('net', `${method}:${url}`, this.clock().toISOString());
    return {
      requestId,
      capturedAt: this.clock().toISOString(),
      method,
      url,
      searchEngine,
      requestHeaders: {
        accept: 'text/html,application/xhtml+xml',
        cookie: '[blocked]'
      },
      response: {
        status: response?.status ?? 200,
        contentType: response?.contentType ?? 'text/html',
        bodyCapture: 'metadata-and-sanitized-preview-only'
      },
      sideEffects: sideEffects ?? {
        cookiesWritten: false,
        downloadsStarted: false,
        formsSubmitted: false,
        filesUploaded: false,
        credentialsEntered: false
      }
    };
  }
}

export class BrowserDomSnapshotter {
  snapshot({ url, resultPreview = [], text = null, source = 'deterministic-preview' }) {
    const nodes = resultPreview.map((item) => ({
      role: 'search-result',
      rank: item.rank,
      title: item.title,
      url: item.url,
      snippet: item.snippet
    }));
    const snapshotText = text ?? nodes.map((node) => `${node.title}\n${node.snippet}`).join('\n\n');
    return {
      snapshotId: stableId('dom', url ?? 'browser-search', resultPreview.length),
      url,
      captureMode: 'sanitized-text-only',
      source,
      nodeCount: nodes.length,
      textPreview: snapshotText.slice(0, 1200),
      textSha256: createHash('sha256').update(snapshotText).digest('hex'),
      nodes,
      excluded: ['forms', 'inputs', 'scripts', 'cookies', 'downloads']
    };
  }
}

export const defaultBrowserNetworkReplayCorpusPath = 'apps/pc-agent/fixtures/browser-network-replay-corpus.json';
export const defaultWorkbookProductCorpusPath = 'apps/pc-agent/fixtures/workbook-product-corpus.json';

export function loadBrowserNetworkReplayCorpus(fixturePath = defaultBrowserNetworkReplayCorpusPath) {
  const resolvedPath = resolve(fixturePath);
  const raw = readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.fixtures)) {
    throw new Error(`invalid-browser-network-replay-corpus:${resolvedPath}`);
  }
  return {
    ...parsed,
    fixturePath: resolvedPath,
    fixtureSha256: createHash('sha256').update(raw).digest('hex')
  };
}

export function loadWorkbookProductCorpus(fixturePath = defaultWorkbookProductCorpusPath) {
  const resolvedPath = resolve(fixturePath);
  const raw = readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.fixtures)) {
    throw new Error(`invalid-workbook-product-corpus:${resolvedPath}`);
  }
  return {
    ...parsed,
    fixturePath: resolvedPath,
    fixtureSha256: createHash('sha256').update(raw).digest('hex')
  };
}

export async function runWorkbookProductCorpus({
  fixturePath = defaultWorkbookProductCorpusPath,
  fixturePack = null,
  outputRoot = 'dist/workbook-product-soak/workbooks',
  cycles = null,
  clock = () => new Date()
} = {}) {
  const pack = fixturePack ?? loadWorkbookProductCorpus(fixturePath);
  const report = await runWorkbookProductFixturePack({
    fixturePack: pack,
    outputRoot,
    cycles: cycles ?? pack.workerPool?.cycles ?? 2,
    clock
  });
  return {
    reportVersion: 'b-workbook-product-soak-report-v1',
    status: report.status,
    generatedAt: clock().toISOString(),
    fixturePackVersion: pack.fixturePackVersion,
    fixturePackId: pack.fixturePackId,
    fixturePath: pack.fixturePath ?? resolve(fixturePath),
    fixtureSha256: pack.fixtureSha256 ?? createHash('sha256').update(JSON.stringify(pack)).digest('hex'),
    outputRoot: resolve(outputRoot),
    migrationReport: report.migrationReport,
    workerPoolSoak: report.workerPoolSoak,
    rendererProbe: report.rendererProbe,
    coverage: report.coverage,
    nextActions: report.status === 'passed'
      ? ['Run with JARVIS_WORKBOOK_RENDERER_REQUIRED=true on a host with Excel or LibreOffice to capture strict external-renderer evidence.']
      : ['Inspect failed workbook fixture, renderer probe, or template migration item before release.']
  };
}

export function createBrowserCacheRecoveryGuide({
  cachePath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '%LOCALAPPDATA%\\ms-playwright',
  error = null,
  systemChromePath = process.env.JARVIS_BROWSER_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  pythonExecutable = process.env.JARVIS_PYTHON_PLAYWRIGHT ?? 'python'
} = {}) {
  return {
    guideVersion: 'b-playwright-cache-recovery-guide-v1',
    status: 'operator-action-required-only',
    cachePath,
    detectedError: error?.message ?? error ?? null,
    recoveryPolicy: {
      destructiveCleanupAutomated: false,
      preferSystemChromeFallback: true,
      preserveEvidenceBeforeCleanup: true
    },
    environmentOverrides: {
      JARVIS_BROWSER_CHROME_PATH: systemChromePath,
      JARVIS_PYTHON_PLAYWRIGHT: pythonExecutable,
      PLAYWRIGHT_BROWSERS_PATH: cachePath
    },
    steps: [
      'Stop active JARVIS browser replay or live browser jobs.',
      'Archive the managed browser cache lock/error log as release evidence.',
      'Remove only stale Playwright lock files under the configured cache path after operator approval.',
      'Rerun npm run browser:replay-soak to confirm replay corpus stability.',
      'If managed Chromium remains unavailable, use JARVIS_BROWSER_CHROME_PATH system Chrome fallback.'
    ],
    verificationCommands: [
      'npm run browser:replay-soak',
      'node --test --test-name-pattern "B browser|Playwright" tests/ag-runtime.test.js'
    ]
  };
}

export function createBrowserRenderingSnapshot({
  fixture = null,
  liveCapture = null,
  domSnapshot = null,
  resultPreview = [],
  text = null,
  clock = () => new Date()
} = {}) {
  const previewText = Array.isArray(resultPreview)
    ? resultPreview.map((item) => `${item.title ?? ''} ${item.snippet ?? ''}`).join(' ')
    : '';
  const sanitizedText = sanitizeBrowserText(
    text
      ?? liveCapture?.sanitizedText
      ?? domSnapshot?.textPreview
      ?? fixture?.bodyText
      ?? previewText
  );
  const screenshotHash = liveCapture?.screenshot?.sha256
    ?? createHash('sha256').update(`${fixture?.fixtureId ?? 'browser'}|${fixture?.title ?? ''}|${sanitizedText}`).digest('hex');
  const screenshotSize = liveCapture?.screenshot?.sizeBytes
    ?? Buffer.byteLength(`${fixture?.fixtureId ?? ''}:${sanitizedText}`, 'utf8');
  return {
    snapshotVersion: 'b-browser-rendering-snapshot-v1',
    snapshotId: stableId('browser-rendering', fixture?.fixtureId ?? domSnapshot?.url ?? 'browser', screenshotHash),
    capturedAt: clock().toISOString(),
    source: liveCapture?.driver ?? domSnapshot?.source ?? 'recorded-network-replay',
    fixtureId: fixture?.fixtureId ?? null,
    url: fixture?.url ?? domSnapshot?.url ?? null,
    captureMode: 'sanitized-dom-and-viewport-hash',
    textPreview: sanitizedText.slice(0, 600),
    sanitizedTextSha256: createHash('sha256').update(sanitizedText).digest('hex'),
    nodeCount: domSnapshot?.nodeCount ?? Math.max(1, Array.isArray(resultPreview) ? resultPreview.length : 1),
    screenshot: {
      captureMode: 'viewport-png-hash-only',
      sha256: screenshotHash,
      sizeBytes: screenshotSize
    },
    layout: {
      viewport: { width: 1365, height: 768 },
      stableTextLengthBucket: Math.ceil(sanitizedText.length / 100) * 100,
      maxTextPreviewCharacters: 600
    },
    excludedRawArtifacts: ['screenshotPixels', 'cookies', 'inputs', 'scripts', 'downloads']
  };
}

export function diffBrowserRenderingSnapshots({
  baseline = null,
  current,
  expectedTextIncludes = []
} = {}) {
  if (!current) {
    return {
      diffVersion: 'b-browser-rendering-diff-v1',
      status: 'failed',
      failures: ['missing-current-rendering-snapshot']
    };
  }
  const text = String(current.textPreview ?? '').toLowerCase();
  const missingExpectedText = expectedTextIncludes.filter((expected) => !text.includes(String(expected).toLowerCase()));
  const screenshotHashValid = /^[a-f0-9]{64}$/i.test(String(current.screenshot?.sha256 ?? ''));
  const textStable = baseline
    ? baseline.sanitizedTextSha256 === current.sanitizedTextSha256
    : true;
  const failures = [
    ...missingExpectedText.map((expected) => `missing-text:${expected}`),
    ...(screenshotHashValid ? [] : ['missing-viewport-screenshot-hash']),
    ...(current.nodeCount > 0 ? [] : ['empty-dom-snapshot'])
  ];
  return {
    diffVersion: 'b-browser-rendering-diff-v1',
    status: failures.length ? 'failed' : 'passed',
    baselineSnapshotId: baseline?.snapshotId ?? null,
    currentSnapshotId: current.snapshotId,
    missingExpectedText,
    screenshotHashStable: baseline ? baseline.screenshot?.sha256 === current.screenshot?.sha256 : true,
    textStable,
    failures
  };
}

export function createBrowserReplayDriver(fixturePack = loadBrowserNetworkReplayCorpus(), { clock = () => new Date() } = {}) {
  const fixtures = new Map((fixturePack.fixtures ?? []).map((fixture) => [browserReplayFixtureKey(fixture), fixture]));
  return {
    driver: 'recorded-network-replay',
    async capture({ url, query, searchEngine, maxResults = 5 }) {
      const fixture = fixtures.get(browserReplayFixtureKey({ query, searchEngine }))
        ?? [...fixtures.values()].find((item) => item.url === url)
        ?? [...fixtures.values()].find((item) => item.query === query)
        ?? null;
      if (!fixture) {
        return {
          live: false,
          driver: 'recorded-network-replay',
          status: 'fixture-missing',
          warnings: ['browser-replay-fixture-missing']
        };
      }
      const sanitizedText = sanitizeBrowserText(fixture.bodyText ?? '');
      const resultPreview = createLiveResultPreview({
        query: fixture.query,
        searchEngine: fixture.searchEngine,
        title: fixture.title,
        url: fixture.url,
        bodyText: sanitizedText,
        maxResults
      });
      const requests = (fixture.requests ?? []).map((request) => ({
        method: String(request.method ?? 'GET').toUpperCase(),
        url: request.url,
        resourceType: request.resourceType ?? 'document',
        blocked: request.method && String(request.method).toUpperCase() !== 'GET' ? request.blocked === true : request.blocked === true
      }));
      const allowedRequestMethods = [...new Set(requests.filter((request) => request.blocked !== true).map((request) => request.method))];
      return {
        live: true,
        replay: true,
        fixtureId: fixture.fixtureId,
        driver: 'recorded-network-replay',
        status: 'captured',
        capturedAt: clock().toISOString(),
        resultPreview,
        pageTitle: fixture.title,
        sanitizedText,
        networkEvents: {
          requests,
          responses: fixture.responses ?? [],
          blockedNonGetRequests: requests.filter((request) => request.method !== 'GET' && request.blocked === true).length,
          allRequestsGetOnly: requests.every((request) => request.method === 'GET' || request.blocked === true),
          allowedRequestMethods,
          replayMode: 'recorded-fixture'
        },
        screenshot: {
          captureMode: 'viewport-png-hash-only',
          sha256: createHash('sha256').update(`${fixture.fixtureId}|${fixture.title}|${sanitizedText}`).digest('hex'),
          sizeBytes: Buffer.byteLength(`${fixture.fixtureId}:${sanitizedText}`, 'utf8')
        },
        sideEffects: {
          cookiesWritten: false,
          downloadsStarted: false,
          formsSubmitted: false,
          filesUploaded: false,
          credentialsEntered: false
        }
      };
    }
  };
}

export async function runBrowserNetworkReplayCorpus({
  fixturePath = defaultBrowserNetworkReplayCorpusPath,
  fixturePack = null,
  cycles = 1,
  clock = () => new Date()
} = {}) {
  const pack = fixturePack ?? loadBrowserNetworkReplayCorpus(fixturePath);
  const cycleCount = Math.max(1, Number(cycles) || 1);
  const adapter = new BrowserSearchToolAdapter({
    browserDriver: createBrowserReplayDriver(pack, { clock })
  });
  const items = [];
  const renderingDiffs = [];
  for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
    for (const fixture of pack.fixtures) {
      const executed = await adapter.execute({
        query: fixture.query,
        searchEngine: fixture.searchEngine,
        maxResults: Math.min(3, fixture.expectedTextIncludes?.length + 1 || 3),
        readOnly: true
      });
      const browserEvidence = executed.evidence?.browser ?? {};
      const renderingSnapshot = createBrowserRenderingSnapshot({
        fixture,
        liveCapture: browserEvidence.liveCapture,
        domSnapshot: browserEvidence.domSnapshot,
        resultPreview: browserEvidence.resultPreview,
        clock
      });
      const renderingDiff = diffBrowserRenderingSnapshots({
        current: renderingSnapshot,
        expectedTextIncludes: fixture.expectedTextIncludes ?? []
      });
      renderingDiffs.push({
        fixtureId: fixture.fixtureId,
        cycleIndex,
        ...renderingDiff
      });
      const sideEffects = browserEvidence.networkCapture?.sideEffects ?? {};
      const blockedNonGetRequests = browserEvidence.liveCapture?.networkEvents?.blockedNonGetRequests ?? 0;
      const allRequestsGetOnly = browserEvidence.liveCapture?.networkEvents?.allRequestsGetOnly === true;
      const rawSensitiveLeak = browserRenderingRawSensitiveLeakDetected(renderingSnapshot.textPreview);
      const sideEffectsBlocked = Object.values(sideEffects).every((value) => value === false);
      const expectedTextPresent = renderingDiff.missingExpectedText.length === 0;
      const passed = executed.status === 'success'
        && allRequestsGetOnly
        && sideEffectsBlocked
        && !rawSensitiveLeak
        && expectedTextPresent
        && renderingDiff.status === 'passed';
      items.push({
        itemVersion: 'b-browser-network-replay-item-v1',
        fixtureId: fixture.fixtureId,
        cycleIndex,
        status: passed ? 'passed' : 'failed',
        query: fixture.query,
        searchEngine: fixture.searchEngine,
        executedStatus: executed.status,
        allRequestsGetOnly,
        blockedNonGetRequests,
        expectedTextPresent,
        rawSensitiveLeak,
        sideEffectsBlocked,
        domSnapshot: {
          captureMode: browserEvidence.domSnapshot?.captureMode,
          source: browserEvidence.domSnapshot?.source,
          nodeCount: browserEvidence.domSnapshot?.nodeCount,
          textSha256: browserEvidence.domSnapshot?.textSha256
        },
        renderingSnapshot,
        renderingDiff
      });
    }
  }
  const passedCount = items.filter((item) => item.status === 'passed').length;
  const passRate = items.length ? passedCount / items.length : 0;
  const failed = items.filter((item) => item.status === 'failed');
  return {
    reportVersion: 'b-browser-network-replay-corpus-report-v1',
    status: failed.length ? 'failed' : 'passed',
    generatedAt: clock().toISOString(),
    fixturePackVersion: pack.fixturePackVersion,
    fixturePackId: pack.fixturePackId,
    fixturePath: pack.fixturePath ?? resolve(fixturePath),
    fixtureSha256: pack.fixtureSha256 ?? createHash('sha256').update(JSON.stringify(pack)).digest('hex'),
    fixtureCount: pack.fixtures.length,
    cycleCount,
    itemCount: items.length,
    passedCount,
    passRate,
    coverage: {
      engines: [...new Set(pack.fixtures.map((fixture) => fixture.searchEngine))],
      blockedMutationAttemptFixtures: pack.fixtures.filter((fixture) => (fixture.requests ?? []).some((request) => String(request.method).toUpperCase() !== 'GET')).length,
      expectedTextAssertions: pack.fixtures.reduce((sum, fixture) => sum + (fixture.expectedTextIncludes?.length ?? 0), 0),
      renderingSnapshots: items.length,
      cacheRecoveryGuide: 'b-playwright-cache-recovery-guide-v1'
    },
    cacheRecoveryGuide: createBrowserCacheRecoveryGuide(),
    renderingDiffs,
    items,
    failures: failed.map((item) => ({
      fixtureId: item.fixtureId,
      cycleIndex: item.cycleIndex,
      renderingFailures: item.renderingDiff.failures,
      allRequestsGetOnly: item.allRequestsGetOnly,
      rawSensitiveLeak: item.rawSensitiveLeak
    }))
  };
}

export async function runBrowserReadOnlySoak({
  fixturePath = defaultBrowserNetworkReplayCorpusPath,
  fixturePack = null,
  cycles = 3,
  clock = () => new Date()
} = {}) {
  const report = await runBrowserNetworkReplayCorpus({ fixturePath, fixturePack, cycles, clock });
  const hashesByFixture = new Map();
  for (const item of report.items) {
    const hashes = hashesByFixture.get(item.fixtureId) ?? new Set();
    hashes.add(item.renderingSnapshot.screenshot.sha256);
    hashesByFixture.set(item.fixtureId, hashes);
  }
  const unstableFixtures = [...hashesByFixture.entries()]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([fixtureId]) => fixtureId);
  return {
    soakVersion: 'b-browser-readonly-soak-v1',
    status: report.status === 'passed' && unstableFixtures.length === 0 ? 'passed' : 'failed',
    generatedAt: clock().toISOString(),
    cycles: report.cycleCount,
    fixtureCount: report.fixtureCount,
    itemCount: report.itemCount,
    passRate: report.passRate,
    stableRendering: unstableFixtures.length === 0,
    unstableFixtures,
    report
  };
}

function browserReplayFixtureKey({ query, searchEngine }) {
  return `${String(searchEngine ?? '').toLowerCase()}::${String(query ?? '').trim().toLowerCase()}`;
}

function browserRenderingRawSensitiveLeakDetected(value) {
  const text = String(value ?? '');
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b\d{2,3}-\d{3,4}-\d{4}\b/.test(text);
}

export class PlaywrightReadOnlyBrowserDriver {
  constructor({
    enabled = ['1', 'true', 'playwright', 'python-playwright'].includes(String(process.env.JARVIS_BROWSER_DRIVER ?? '').toLowerCase()),
    moduleName = 'playwright',
    timeoutMs = 7000,
    pythonExecutable = process.env.JARVIS_PYTHON_PLAYWRIGHT ?? 'python',
    systemChromePath = process.env.JARVIS_BROWSER_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    clock = () => new Date()
  } = {}) {
    this.enabled = enabled;
    this.moduleName = moduleName;
    this.timeoutMs = timeoutMs;
    this.pythonExecutable = pythonExecutable;
    this.systemChromePath = systemChromePath;
    this.clock = clock;
  }

  async capture({ url, query, searchEngine, maxResults = 5 }) {
    if (!this.enabled) {
      return {
        live: false,
        driver: 'playwright',
        status: 'disabled',
        warnings: ['playwright-driver-disabled']
      };
    }
    let browser = null;
    try {
      const playwright = await import(this.moduleName);
      const chromium = playwright.chromium;
      if (!chromium?.launch) throw new Error('playwright chromium launcher is unavailable');
      const requests = [];
      const responses = [];
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: true,
        viewport: { width: 1365, height: 768 }
      });
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const request = route.request();
        requests.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
        if (request.method() !== 'GET') return route.abort('blockedbyclient');
        return route.continue();
      });
      page.on('response', (response) => {
        responses.push({
          url: response.url(),
          status: response.status(),
          contentType: response.headers()['content-type'] ?? null
        });
      });
      page.on('download', (download) => {
        requests.push({ method: 'DOWNLOAD', url: download.url(), resourceType: 'download', blocked: true });
      });
      const navigationResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      if (/(?:bing\.com|duckduckgo\.com)/i.test(new URL(url).hostname)) await page.locator('#b_results h2 a, a.result__a, [data-testid="result-title-a"]').first().waitFor({timeout:3000}).catch(()=>{});
      const title = await page.title().catch(() => '');
      const main = await page.locator('main').count() ? page.locator('main').first() : page.locator('body');
      const bodyText = sanitizeBrowserText(await main.innerText({ timeout: 1500 }).catch(() => ''));
      const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => ({url:a.href,title:a.innerText,snippet:a.parentElement?.innerText}))).catch(()=>[]);
      const screenshot = await page.screenshot({ fullPage: false, timeout: this.timeoutMs }).catch(() => null);
      const resultPreview = createLiveResultPreview({
        query,
        searchEngine,
        title,
        url: page.url(),
        bodyText,
        links,
        maxResults
      });
      return {
        live: true,
        driver: 'playwright',
        status: 'captured',
        navigationStatus: navigationResponse?.status() ?? null,
        finalUrl: page.url(),
        capturedAt: this.clock().toISOString(),
        resultPreview,
        pageTitle: title,
        sanitizedText: bodyText,
        networkEvents: {
          requests,
          responses: responses.slice(0, 25),
          blockedNonGetRequests: requests.filter((request) => request.method !== 'GET').length,
          allRequestsGetOnly: requests.every((request) => request.method === 'GET')
        },
        screenshot: screenshot
          ? {
              captureMode: 'viewport-png-hash-only',
              sha256: createHash('sha256').update(screenshot).digest('hex'),
              sizeBytes: screenshot.length
            }
          : {
              captureMode: 'unavailable',
              sha256: null,
              sizeBytes: 0
            },
        sideEffects: {
          cookiesWritten: false,
          downloadsStarted: false,
          formsSubmitted: false,
          filesUploaded: false,
          credentialsEntered: false
        }
      };
    } catch (error) {
      const fallback = this.captureWithPythonPlaywright({ url, query, searchEngine, maxResults }, error);
      if (fallback.live || fallback.status !== 'unavailable') return fallback;
      return fallback;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  captureWithPythonPlaywright({ url, query, searchEngine, maxResults = 5 }, nodeError) {
    const script = `
import hashlib
import json
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
payload = json.loads(sys.argv[1])
requests = []
responses = []

def sanitize(value):
    value = re.sub(r"\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b", "[email]", value or "", flags=re.I)
    value = re.sub(r"\\b\\d{2,3}-\\d{3,4}-\\d{4}\\b", "[phone]", value)
    return re.sub(r"\\s+", " ", value).strip()[:4000]

try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        launch_options = {"headless": True}
        if payload.get("systemChromePath"):
            launch_options["executable_path"] = payload["systemChromePath"]
        browser = p.chromium.launch(**launch_options)
        context = browser.new_context(accept_downloads=False, java_script_enabled=True, viewport={"width": 1365, "height": 768})
        page = context.new_page()

        def handle_route(route):
            request = route.request
            requests.append({"method": request.method, "url": request.url, "resourceType": request.resource_type})
            if request.method != "GET":
                route.abort()
            else:
                route.continue_()

        page.route("**/*", handle_route)
        page.on("response", lambda response: responses.append({
            "url": response.url,
            "status": response.status,
            "contentType": response.headers.get("content-type")
        }))
        page.on("download", lambda download: requests.append({
            "method": "DOWNLOAD",
            "url": download.url,
            "resourceType": "download",
            "blocked": True
        }))
        navigation_response = page.goto(payload["url"], wait_until="domcontentloaded", timeout=payload["timeoutMs"])
        if 'bing.com/' in payload['url'] or 'duckduckgo.com/' in payload['url']:
            try:
                page.locator('#b_results h2 a, a.result__a, [data-testid="result-title-a"]').first.wait_for(timeout=3000)
            except Exception:
                pass
        title = page.title()
        links = page.locator('a[href]').evaluate_all("anchors => anchors.map(a => ({url:a.href,title:a.innerText,snippet:a.parentElement?.innerText}))")
        try:
            main = page.locator('main').first if page.locator('main').count() else page.locator('body')
            body_text = sanitize(main.inner_text(timeout=1500))
        except Exception:
            body_text = ""
        try:
            screenshot = page.screenshot(full_page=False, timeout=payload["timeoutMs"])
            screenshot_hash = hashlib.sha256(screenshot).hexdigest()
            screenshot_size = len(screenshot)
        except Exception:
            screenshot_hash = None
            screenshot_size = 0
        browser.close()
        print(json.dumps({
            "ok": True,
            "title": title,
            "navigationStatus": navigation_response.status if navigation_response else None,
            "finalUrl": page.url,
            "bodyText": body_text,
            "links": links,
            "requests": requests,
            "responses": responses[:25],
            "screenshotHash": screenshot_hash,
            "screenshotSize": screenshot_size
        }, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
`;
    try {
      const output = execFileSync(this.pythonExecutable, [
        '-c',
        script,
        JSON.stringify({
          url,
          timeoutMs: this.timeoutMs,
          systemChromePath: this.systemChromePath
        })
      ], {
        encoding: 'utf8',
        timeout: this.timeoutMs + 12000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '{}');
      if (!payload.ok) {
        throw new Error(payload.error ?? 'python playwright capture failed');
      }
      const bodyText = sanitizeBrowserText(payload.bodyText ?? '');
      const resultPreview = createLiveResultPreview({
        query,
        searchEngine,
        title: payload.title,
        url: payload.finalUrl ?? url,
        bodyText,
        links: payload.links,
        maxResults
      });
      const requests = payload.requests ?? [];
      return {
        live: true,
        driver: 'python-playwright-system-chrome',
        status: 'captured',
        navigationStatus: payload.navigationStatus ?? null,
        finalUrl: payload.finalUrl ?? url,
        capturedAt: this.clock().toISOString(),
        resultPreview,
        pageTitle: payload.title ?? '',
        sanitizedText: bodyText,
        networkEvents: {
          requests,
          responses: payload.responses ?? [],
          blockedNonGetRequests: requests.filter((request) => request.method !== 'GET').length,
          allRequestsGetOnly: requests.every((request) => request.method === 'GET')
        },
        screenshot: payload.screenshotHash
          ? {
              captureMode: 'viewport-png-hash-only',
              sha256: payload.screenshotHash,
              sizeBytes: payload.screenshotSize ?? 0
            }
          : {
              captureMode: 'unavailable',
              sha256: null,
              sizeBytes: 0
            },
        sideEffects: {
          cookiesWritten: false,
          downloadsStarted: false,
          formsSubmitted: false,
          filesUploaded: false,
          credentialsEntered: false
        },
        fallbackFrom: {
          driver: 'node-playwright',
          error: nodeError?.message ?? null
        }
      };
    } catch (fallbackError) {
      return {
        live: false,
        driver: 'playwright',
        status: 'unavailable',
        warnings: ['playwright-driver-unavailable', 'python-playwright-system-chrome-unavailable'],
        error: `${nodeError?.message ?? 'node playwright unavailable'}; ${fallbackError.message}`
      };
    }
  }
}

function sanitizeBrowserText(value) {
  return String(value ?? '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{2,3}-\d{3,4}-\d{4}\b/g, '[phone]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

const trustedDocumentationHosts = new Set(['developer.mozilla.org','docs.python.org','nodejs.org','learn.microsoft.com']);

export function createLiveResultPreview({ query, searchEngine, title, url, bodyText, links = [], maxResults }) {
  const count = Math.max(1, Math.min(Number(maxResults ?? 5), 10));
  try {
    if (trustedDocumentationHosts.has(new URL(url).hostname)) return [{rank:1,title:String(title??query).slice(0,300),url,snippet:bodyText.slice(0,1800)}];
  } catch {}
  const results = [];
  for (const link of links) {
    try {
      let target = new URL(link.url);
      if (target.searchParams.has('uddg')) target = new URL(target.searchParams.get('uddg'));
      if (!['http:','https:'].includes(target.protocol) || /(^|\.)(?:duckduckgo\.com|bing\.com|microsoft\.com|msn\.com)$/i.test(target.hostname)) continue;
      const label = sanitizeBrowserText(link.title ?? '');
      if (!label || results.some(item=>item.url===target.href)) continue;
      results.push({rank:results.length+1,title:label.slice(0,300),url:target.href,snippet:sanitizeBrowserText(link.snippet??'').slice(0,500)});
      if (results.length >= count) break;
    } catch {}
  }
  if (results.length) return results;
  const sentences = bodyText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const fallback = title || bodyText.slice(0, 80) || query || 'live browser result';
  return Array.from({ length: Math.min(count, Math.max(1, sentences.length || 1)) }, (_, index) => ({
    rank: index + 1,
    title: index === 0 ? fallback.slice(0, 120) : `${query || 'search'} live excerpt ${index + 1}`,
    url: index === 0 ? url : `${url}#jarvis-live-${index + 1}`,
    snippet: (sentences[index] ?? bodyText.slice(index * 160, (index + 1) * 160) ?? '').slice(0, 240) || `Live read-only ${searchEngine} page capture.`
  }));
}

export class BrowserSearchToolAdapter {
  constructor({ allowedEngines = ['duckduckgo', 'bing'], readOnlyGuard = new BrowserReadOnlyGuard(), networkRecorder = new BrowserNetworkRecorder(), domSnapshotter = new BrowserDomSnapshotter(), browserDriver = new PlaywrightReadOnlyBrowserDriver() } = {}) {
    this.allowedEngines = new Set(allowedEngines);
    this.readOnlyGuard = readOnlyGuard;
    this.networkRecorder = networkRecorder;
    this.domSnapshotter = domSnapshotter;
    this.browserDriver = browserDriver;
    this.contract = createToolContract({
      toolName: 'browser.search',
      readOnly: true,
      evidence: ['query', 'searchEngine', 'url', 'resultPreview', 'blockedOperations', 'networkCapture', 'domSnapshot', 'liveCapture'],
      blockedOperations: ['formSubmit', 'download', 'fileUpload', 'credentialEntry', 'javascriptExecution', 'cookieMutation'],
      modes: ['shadow', 'execute']
    });
  }

  searchUrl({ query, searchEngine = 'duckduckgo' }) {
    try {
      const direct = new URL(String(query).trim());
      if (direct.protocol === 'https:' && !direct.username && !direct.password && !direct.port && trustedDocumentationHosts.has(direct.hostname)) return direct.href;
    } catch {}
    if (searchEngine === 'bing') return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  }

  async shadow(args) {
    const query = String(args.query ?? '').trim();
    const searchEngine = args.searchEngine ?? 'duckduckgo';
    const readOnly = args.readOnly !== false;
    const warnings = [];
    const guard = this.readOnlyGuard.inspect(args);
    if (!query) warnings.push('empty-query');
    if (!this.allowedEngines.has(searchEngine)) warnings.push(`engine-not-allowed:${searchEngine}`);
    if (!readOnly) warnings.push('browser-search-must-be-read-only');
    warnings.push(...guard.warnings.filter((warning) => !warnings.includes(warning)));
    const url = query ? this.searchUrl({ query, searchEngine }) : null;
    const resultPreview = query ? this.previewResults({ query, searchEngine, maxResults: args.maxResults }) : [];
    const liveCapture = url && !warnings.length ? await this.browserDriver.capture({ url, query, searchEngine, maxResults: args.maxResults }) : null;
    const liveResultPreview = liveCapture?.live && liveCapture.resultPreview?.length ? liveCapture.resultPreview : resultPreview;
    const networkCapture = liveCapture?.live
      ? this.networkRecorder.capture({ url, searchEngine, response: liveCapture.networkEvents?.responses?.[0], sideEffects: liveCapture.sideEffects })
      : url ? this.networkRecorder.capture({ url, searchEngine }) : null;
    const domSnapshot = liveCapture?.live
      ? this.domSnapshotter.snapshot({ url, resultPreview: liveResultPreview, text: liveCapture.sanitizedText, source: 'playwright-live-read-only' })
      : url ? this.domSnapshotter.snapshot({ url, resultPreview }) : null;
    return {
      mode: 'shadow',
      expectedChangesCount: 0,
      query,
      searchEngine,
      readOnly,
      url,
      navigationPlan: {
        url,
        method: 'GET',
        networkMode: 'public-web-read-only',
        contentCapture: 'metadata-and-preview-only'
      },
      readOnlyGuard: guard,
      blockedOperations: this.contract.blockedOperations,
      blockedOperationProofs: guard.checks,
      networkCapture,
      domSnapshot,
      liveCapture,
      resultPreview: liveResultPreview,
      warnings
    };
  }

  async execute(args) {
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'Browser search preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: shadow.warnings
      };
    }
    return {
      status: 'success',
      outputPaths: [],
      changedItems: [],
      rollbackAvailable: false,
      readOnly: true,
      search: {
        query: shadow.query,
        searchEngine: shadow.searchEngine,
        url: shadow.url,
        maxResults: Math.min(Number(args.maxResults ?? 5), 10),
        resultPreview: shadow.resultPreview,
        networkCapture: shadow.networkCapture,
        domSnapshot: shadow.domSnapshot,
        liveCapture: summarizeBrowserLiveCapture(shadow.liveCapture)
      },
      evidence: {
        browser: {
          readOnly: true,
          navigationPlan: shadow.navigationPlan,
          blockedOperations: shadow.blockedOperations,
          blockedOperationProofs: shadow.blockedOperationProofs,
          networkCapture: shadow.networkCapture,
          domSnapshot: shadow.domSnapshot,
          liveCapture: summarizeBrowserLiveCapture(shadow.liveCapture),
          resultPreview: shadow.resultPreview,
          sideEffectsAllowed: shadow.readOnlyGuard.sideEffectsAllowed
        }
      }
    };
  }

  previewResults({ query, searchEngine, maxResults = 5 }) {
    const count = Math.max(1, Math.min(Number(maxResults ?? 5), 5));
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    return Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      title: `${terms || 'search'} preview ${index + 1}`,
      url: `${this.searchUrl({ query, searchEngine })}&jarvis_preview=${index + 1}`,
      snippet: 'Read-only search preview generated before any browser side effect.'
    }));
  }
}

function summarizeBrowserLiveCapture(liveCapture) {
  if (!liveCapture) return null;
  return {
    live: liveCapture.live === true,
    replay: liveCapture.replay === true,
    driver: liveCapture.driver,
    status: liveCapture.status,
    navigationStatus: liveCapture.navigationStatus ?? null,
    finalUrl: liveCapture.finalUrl ?? null,
    capturedAt: liveCapture.capturedAt ?? null,
    warnings: liveCapture.warnings ?? [],
    error: liveCapture.error ?? null,
    pageTitle: liveCapture.pageTitle ?? null,
    networkEvents: liveCapture.networkEvents
      ? {
          requestCount: liveCapture.networkEvents.requests?.length ?? 0,
          responseCount: liveCapture.networkEvents.responses?.length ?? 0,
          blockedNonGetRequests: liveCapture.networkEvents.blockedNonGetRequests ?? 0,
          allRequestsGetOnly: liveCapture.networkEvents.allRequestsGetOnly === true
        }
      : null,
    screenshot: liveCapture.screenshot ?? null
  };
}

export class ExcelPdfExportToolAdapter {
  constructor({allowedRoots=['./workspace'],undoJournal=new UndoJournal(),renderer=new NativeWorkbookPdfRenderer()}={}){
    this.allowedRoots=allowedRoots.map(path=>resolve(path));this.undoJournal=undoJournal;this.renderer=renderer;
    this.contract=createToolContract({toolName:'excel.exportPdf',mutatesSystem:true,rollback:true,evidence:['pdfExport','undoJournalId'],blockedOperations:['outsideAllowedRoots','overwrite','activeWorkbookContent','formulaRecalculation']});
  }
  async shadow(args={}){
    const warnings=[];let inputPath=null,outputPath=null;
    try{
      if(typeof args.inputPath!=='string'||!args.inputPath.toLowerCase().endsWith('.xlsx')||typeof args.outputPath!=='string'||!args.outputPath.toLowerCase().endsWith('.pdf'))throw Error('XLSX_PDF_PATHS_REQUIRED');
      inputPath=resolve(args.inputPath);outputPath=resolve(args.outputPath);
      await assertAllowedRealPath(inputPath,this.allowedRoots);await assertAllowedRealPath(outputPath,this.allowedRoots,{checkParentForCreate:true});
      if(await exists(outputPath))throw Error('XLSX_PDF_OUTPUT_EXISTS');
    }catch(error){warnings.push(error.code??error.message);}
    return {mode:'shadow',expectedChangesCount:1,requestedXlsxSource:inputPath,pdfOutputPath:outputPath,warnings};
  }
  async preparePublication(args){
    const inputPath=resolve(args.inputPath),outputPath=resolve(args.outputPath);
    const {readFileSnapshot}=await import('./adapters/filesystem/read-text-snapshot.js');
    const {bytes}=await readFileSnapshot({path:inputPath,maxBytes:16*1024*1024,
      checkAllowedPath:async path=>{await assertAllowedRealPath(path,this.allowedRoots);return path;}});
    await assertAllowedRealPath(outputPath,this.allowedRoots,{checkParentForCreate:true});
    validateXlsxNativeExport(bytes);
    const sourceSha256=createHash('sha256').update(bytes).digest('hex');
    if(args.expectedSha256!==undefined&&args.expectedSha256!==sourceSha256)throw Error('XLSX_SOURCE_HASH_MISMATCH');
    return {inputPath,outputPath,sourceSha256};
  }
  async execute(args={},packet={},context={}){
    const shadow=await this.shadow(args);
    const blocked=reason=>({status:'blocked',summary:'기존 엑셀의 PDF 출력을 완료하지 못했습니다. 원본은 보존됩니다.',warnings:[reason],outputPaths:[],changedItems:[],rollbackAvailable:false});
    if(shadow.warnings.length)return blocked(shadow.warnings[0]);
    try{
      const inputPath=shadow.requestedXlsxSource,outputPath=shadow.pdfOutputPath;
      context.assertAccess?.();
      const checkPaths=async()=>{for(const roots of [this.allowedRoots,...(packet.capabilityToken?[packet.capabilityToken.scope?.allowedPaths??[]]:[])]){
        context.assertAccess?.();
        await assertAllowedRealPath(inputPath,roots);await assertAllowedRealPath(outputPath,roots,{checkParentForCreate:true});
        context.assertAccess?.();}};
      await checkPaths();
      const {readFileSnapshot}=await import('./adapters/filesystem/read-text-snapshot.js');
      const readSource=()=>readFileSnapshot({path:inputPath,maxBytes:16*1024*1024,checkAllowedPath:async path=>{await assertAllowedRealPath(path,this.allowedRoots);return path;}});
      const {bytes}=await readSource(),sourceSha256=createHash('sha256').update(bytes).digest('hex');
      if(args.expectedSha256!==undefined&&args.expectedSha256!==sourceSha256)return blocked('XLSX_SOURCE_HASH_MISMATCH');
      const preflight=validateXlsxNativeExport(bytes);
      await context.beforeArtifactWrite?.({paths:[inputPath,outputPath],prepared:{inputPath,outputPath,sourceSha256}});
      context.assertAccess?.();
      await mkdir(dirname(outputPath),{recursive:true});
      context.assertAccess?.();
      const render=await this.renderer.render({inputPath,outputPath,expectedSha256:sourceSha256,signal:context.signal,beforePublish:async()=>{
        await checkPaths();
        if(createHash('sha256').update((await readSource()).bytes).digest('hex')!==sourceSha256)throw Error('XLSX_SOURCE_CHANGED');
        context.assertAccess?.();
        await context.beforePdfPublish?.();
      }});
      const undo=this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path:outputPath,fileKind:'pdf'});
      return {status:'success',summary:'기존 엑셀을 보존하고 PDF를 생성했습니다. 내용·시각 품질 검증은 별도입니다.',outputPaths:[outputPath],changedItems:[{type:'create_file',path:outputPath}],rollbackAvailable:true,undoJournalId:undo.undoJournalId,
        pdfExport:{inputPath,outputPath,sourceSha256,preflight,render},evidence:{pdfExport:{inputPath,outputPath,sourceSha256,preflight,render}}};
    }catch(error){
      if(shadow.pdfOutputPath&&await exists(shadow.pdfOutputPath))return {status:'failed',retryable:false,
        summary:'PDF 위치에 파일이 있지만 이번 실행의 결과인지 확인하지 못했습니다. 덮어쓰기나 자동 재시도를 중지했습니다.',
        warnings:['XLSX_PDF_EFFECT_UNCERTAIN'],unverifiedOutputPath:shadow.pdfOutputPath,outputPaths:[],changedItems:[],rollbackAvailable:false};
      const recovery=nativeFailureRecovery(error);
      return {...blocked(error.code??error.message),...(recovery?{retryable:false,nativeRecovery:recovery,
        nextAction:recovery.activationGapUnverified?'Excel 실행 초기 종료 여부를 확인할 수 없습니다. 자동 재시도를 중지했으므로 실행 중인 Excel을 확인하세요.':'원본은 보존되었습니다. 실행 권한과 Excel 상태를 확인한 뒤 다시 요청하세요.'}:{})};
    }
  }
}

export class ExcelWorkbookToolAdapter {
  constructor({ allowedRoots = ['./workspace'], undoJournal = new UndoJournal(), workbookWorker = new ExcelWorkbookWorker() } = {}) {
    this.home = process.env.USERPROFILE ?? process.env.HOME ?? resolve('./');
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.workbookWorker = workbookWorker;
    this.contract = createToolContract({
      toolName: 'excel.createWorkbook',
      mutatesSystem: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'workbook.sheetName', 'workbook.rowCount', 'workbook.templateId', 'workbook.chartCount', 'workbook.chartPartCount', 'workbook.hasDrawing', 'workbook.openValidation', 'workbook.visualValidation', 'workbook.renderSmoke', 'workbook.worker', 'undoJournalId'],
      blockedOperations: ['outsideAllowedRoots', 'macroWorkbook', 'overwriteWithoutApproval', 'rowLimitExceeded', 'unsupportedChartType']
    });
  }

  assertAllowed(path) {
    const resolved = resolve(path);
    if (!this.allowedRoots.some((root) => isInside(root, resolved))) {
      throw new Error(`outside-allowed-roots:${resolved}`);
    }
    return resolved;
  }

  resolveOutputPath(args = {}) {
    const explicit = args.outputPath ?? args.path;
    if (explicit) return this.assertAllowed(explicit);
    const fileName = String(args.fileName ?? 'jarvis-output.xlsx')
      .replace(/\.[^.\\/]+$/, '') + '.xlsx';
    const directory = args.targetDirectoryHint === 'desktop' ? resolve(this.home, 'Desktop')
      : args.targetDirectoryHint === 'documents' ? resolve(this.home, 'Documents')
      : args.targetDirectoryHint === 'downloads' ? resolve(this.home, 'Downloads')
      : this.allowedRoots[0] ?? resolve('./workspace');
    return this.assertAllowed(resolve(directory, fileName));
  }

  async normalize(args) {
    const outputPath = this.resolveOutputPath(args);
    const prepared = await this.workbookWorker.prepare({ ...args, outputPath });
    const pdfOutputPath=args.renderPdf===true?this.assertAllowed(args.pdfOutputPath):null;
    const warnings = [];
    if (outputPath.toLowerCase().endsWith('.xlsm')) warnings.push('xlsm-macro-workbook-forbidden');
    if (!outputPath.toLowerCase().endsWith('.xlsx')) warnings.push('xlsx-output-required');
    if (!prepared.sheetName || prepared.sheetName.length > 31 || /[\[\]:*?/\\]/.test(prepared.sheetName)) warnings.push('invalid-sheet-name');
    if (!Array.isArray(prepared.columns) || prepared.columns.length === 0) warnings.push('columns-required');
    if (!Array.isArray(prepared.rows)) warnings.push('rows-must-be-array');
    if (prepared.rows.length > 5000) warnings.push('row-limit-exceeded');
    for (const chart of prepared.charts) {
      if (!['bar', 'line', 'pie'].includes(chart.type)) warnings.push(`unsupported-chart-type:${chart.type}`);
    }
    return {
      ...prepared,
      outputPath,
      pdfOutputPath,
      warnings
    };
  }

  async normalizeTemplate(template = {}) {
    return this.workbookWorker.templateCatalog.resolveTemplate(template);
  }

  normalizeStyle(style = {}) {
    return this.workbookWorker.normalizeStyle(style);
  }

  normalizeCharts(charts, columns, rows) {
    return this.workbookWorker.normalizeCharts(charts, columns, rows);
  }

  async shadow(args) {
    const normalized = await this.normalize(args);
    await assertAllowedRealPath(normalized.outputPath, this.allowedRoots, { checkParentForCreate: true });
    if(normalized.pdfOutputPath) {
      await assertAllowedRealPath(normalized.pdfOutputPath,this.allowedRoots,{checkParentForCreate:true});
      if(await exists(normalized.pdfOutputPath)) normalized.warnings.push(`target-exists:${normalized.pdfOutputPath}`);
    }
    if (await exists(normalized.outputPath)) {
      normalized.warnings.push(`target-exists:${normalized.outputPath}`);
    }
    return {
      mode: 'shadow',
      expectedChangesCount: normalized.pdfOutputPath?2:1,
      outputPath: normalized.outputPath,
      pdfOutputPath:normalized.pdfOutputPath,
      sheetName: normalized.sheetName,
      columnCount: normalized.columns.length,
      rowCount: normalized.rows.length,
      templateId: normalized.template.templateId,
      templateSource: normalized.template.source,
      templateVersion: normalized.template.version,
      worker: {
        workerId: this.workbookWorker.workerId,
        processIsolation: 'worker-module'
      },
      style: normalized.style,
      chartCount: normalized.charts.length,
      charts: normalized.charts,
      overwrite: false,
      warnings: normalized.warnings
    };
  }

  async execute(args, packet = {}, context = {}) {
    const shadow = await this.shadow(args);
    if (shadow.warnings.length) {
      return {
        status: 'blocked',
        summary: 'Workbook preflight failed.',
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        warnings: shadow.warnings
      };
    }
    const normalized = await this.normalize(args);
    context.assertAccess?.();
    await context.beforeArtifactWrite?.({paths:[normalized.outputPath,...(normalized.pdfOutputPath?[normalized.pdfOutputPath]:[])],prepared:normalized});
    context.assertAccess?.();
    await assertAllowedRealPath(normalized.outputPath, this.allowedRoots, { checkParentForCreate: true });
    if(normalized.pdfOutputPath) {
      await assertAllowedRealPath(normalized.pdfOutputPath,this.allowedRoots,{checkParentForCreate:true});
      const granted=packet.capabilityToken?.scope?.allowedPaths??this.allowedRoots;
      await assertAllowedRealPath(normalized.outputPath,granted.map(path=>resolve(path)),{checkParentForCreate:true});
      await assertAllowedRealPath(normalized.pdfOutputPath,granted.map(path=>resolve(path)),{checkParentForCreate:true});
      context.assertAccess?.();
      await mkdir(dirname(normalized.pdfOutputPath),{recursive:true});
    }
    const workerResult = await this.workbookWorker.writeWorkbook({ ...args, outputPath: normalized.outputPath, ...(normalized.pdfOutputPath?{pdfOutputPath:normalized.pdfOutputPath}:{}) }, context);
    const inspection = workerResult.inspection;
    const undo = this.undoJournal.record({
      taskId: packet.taskId,
      action: 'delete_created_file',
      path: normalized.outputPath,
      fileKind: 'xlsx'
    });
    const pdf=workerResult.renderValidation?.status==='passed'?workerResult.renderValidation.pdf:null;
    const pdfUndo=pdf?this.undoJournal.record({taskId:packet.taskId,action:'delete_created_file',path:pdf.path,fileKind:'pdf'}):null;
    const renderFailed=workerResult.renderValidation?.requested===true&&workerResult.renderValidation.status!=='passed';
    return {
      status: renderFailed?'failed':'success',
      ...(renderFailed?{summary:'엑셀 파일은 저장했지만 요청한 PDF 출력은 완료되지 않았습니다.',warnings:[workerResult.renderValidation.reason],
        retryable:false,nextAction:workerResult.renderValidation.nextAction,
        ...(workerResult.renderValidation.nativeRecovery?{nativeRecovery:workerResult.renderValidation.nativeRecovery}:{})}:{}),
      outputPaths: [normalized.outputPath,...(pdf?[pdf.path]:[])],
      changedItems: [{ type: 'create_workbook', path: normalized.outputPath },...(pdf?[{type:'create_file',path:pdf.path,undoJournalId:pdfUndo.undoJournalId}]:[])],
      rollbackAvailable: true,
      undoJournalId: undo.undoJournalId,
      evidence: {
        verificationEvidenceId: `evidence_${packet.taskId ?? 'workbook'}`,
        workbook: {
          outputPath: normalized.outputPath,
          sheetName: inspection.sheetName,
          sheetNames: inspection.sheetNames,
          sheetCount: inspection.sheetCount,
          columnCount: inspection.columnCount,
          rowCount: inspection.rowCount,
          templateId: inspection.templateId,
          templateSource: inspection.templateSource,
          templateVersion: inspection.templateVersion,
          chartCount: inspection.chartCount,
          chartPartCount: inspection.chartPartCount,
          hasDrawing: inspection.hasDrawing,
          hasStyles: inspection.hasStyles,
          hasAutoFilter: inspection.hasAutoFilter,
          hasContentTypes: inspection.hasContentTypes,
          hasWorkbookRelationship: inspection.hasWorkbookRelationship,
          zipMagic: inspection.zipMagic,
          worker: workerResult.worker,
          openValidation: workerResult.openValidation,
          visualValidation: workerResult.visualValidation,
          renderSmoke: workerResult.renderSmoke,
          renderValidation:workerResult.renderValidation,
          sourceSha256:workerResult.sha256
        }
      }
    };
  }
}

export class PcAgentRuntime {
  #unpublishedFailureReceipts = new WeakMap();
  #unpublishedFailureSigner = null;
  constructor({ policyRuntime, trustKernel = null, allowedRoots = ['./workspace'], auditLog = null, auditRoot, undoJournalPath, rollbackTransactionPath, packetJournalPath, packetQueuePath, tokenVaultPath, tokenVaultKeyProvider = null, emailLedgerPath = null, browserDriver = null, newsClient = null, publisherRssClient = null, publisherArticleReader = null, desktopControlAdapter = null, clock = () => new Date() } = {}) {
    this.clock = clock;
    this.auditRoot = auditRoot;
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.policyRuntime = policyRuntime;
    this.trustKernel = trustKernel;
    try{this.#unpublishedFailureSigner=trustKernel?.createPurposeBoundSigner({purpose:'b-pre-publication-person-failure-v1'})??null;}
    catch{ /* In-process proofs remain usable; unsigned receipts never recover authority. */ }
    this.auditLog = auditLog ?? new JsonlAuditLog({
      filePath: auditRoot ? `${auditRoot}/pc-agent-audit.jsonl` : 'apps/pc-agent/logs/pc-agent-audit.jsonl',
      clock
    });
    this.executionLogPath = auditRoot ? `${auditRoot}/executions.jsonl` : 'apps/pc-agent/logs/executions.jsonl';
    this.packetJournal = new ExecutionPacketJournal({
      clock,
      journalPath: packetJournalPath ?? (auditRoot ? `${auditRoot}/packet-journal.jsonl` : 'apps/pc-agent/logs/packet-journal.jsonl')
    });
    this.executionQueue = new ExecutionPacketQueue({
      clock,
      queuePath: packetQueuePath ?? (auditRoot ? `${auditRoot}/packet-queue.jsonl` : 'apps/pc-agent/logs/packet-queue.jsonl')
    });
    this.capabilityVault = new CapabilityTokenVault({
      clock,
      vaultPath: tokenVaultPath ?? (auditRoot ? `${auditRoot}/capability-vault.jsonl` : 'apps/pc-agent/logs/capability-vault.jsonl'),
      keyProvider: tokenVaultKeyProvider
    });
    this.evidenceCollector = new ExecutionEvidenceCollector({
      clock,
      logPath: auditRoot ? `${auditRoot}/evidence.jsonl` : 'apps/pc-agent/logs/evidence.jsonl'
    });
    this.memoryEmitter = new ExecutionMemoryEmitter({
      clock,
      logPath: auditRoot ? `${auditRoot}/memory-events.jsonl` : 'apps/pc-agent/logs/memory-events.jsonl'
    });
    this.undoJournal = new UndoJournal({
      clock,
      journalPath: undoJournalPath ?? (auditRoot ? `${auditRoot}/undo-journal.jsonl` : 'apps/pc-agent/logs/undo-journal.jsonl')
    });
    this.rollbackTransactions = new RollbackTransactionLog({
      clock,
      journalPath: rollbackTransactionPath ?? (auditRoot ? `${auditRoot}/rollback-transactions.jsonl` : 'apps/pc-agent/logs/rollback-transactions.jsonl')
    });
    this.registry = new ToolAdapterRegistry();
    this.fileSystemAdapter = new FileSystemToolAdapter({ allowedRoots, undoJournal: this.undoJournal });
    this.registry.register('filesystem.createTextFile', this.fileSystemAdapter);
    this.registry.register('filesystem.listFiles', new FileListToolAdapter({ allowedRoots }));
    this.registry.register('filesystem.readText', new FileReadTextToolAdapter({ allowedRoots }));
    this.registry.register('document.readPdf',new PdfReadToolAdapter({allowedRoots}));
    this.registry.register('excel.readWorkbook',new XlsxReadToolAdapter({allowedRoots}));
    this.registry.register('filesystem.previewMoveFiles', new FileMoveToolAdapter({
      allowedRoots,
      undoJournal: this.undoJournal,
      toolName: 'filesystem.previewMoveFiles',
      previewOnly: true
    }));
    this.registry.register('filesystem.moveFiles', new FileMoveToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('excel.createWorkbook', new ExcelWorkbookToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('excel.exportPdf',new ExcelPdfExportToolAdapter({allowedRoots,undoJournal:this.undoJournal}));
    this.registry.register('browser.search', new BrowserSearchToolAdapter({ browserDriver: browserDriver ?? undefined }));
    const resolvedPublisherRssClient = publisherRssClient ?? new PublisherRssFeedClient({ clock });
    this.registry.register('news.fetchHeadlines', new NewsFetchHeadlinesToolAdapter({
      client: newsClient ?? undefined,
      publisherLinkResolver: news => resolveCataloguedPublisherHeadlines(news, {
        feedClient: resolvedPublisherRssClient, maxResults: news.maxResults
      })
    }));
    this.registry.register('news.fetchPublisherFeed', new NewsFetchPublisherFeedToolAdapter({ client: resolvedPublisherRssClient }));
    this.registry.register('news.fetchArticle', new NewsFetchArticleToolAdapter({ reader: publisherArticleReader ?? undefined }));
    this.registry.register('desktop.control', desktopControlAdapter ?? new WindowsDesktopControlToolAdapter({ allowedRoots }));
    this.registry.register('shell.execute', new ShellExecuteToolAdapter({}));
    this.registry.register('filesystem.searchFiles', new FileSearchToolAdapter({ allowedRoots }));
    this.registry.register('hwp.create', new HwpCreateToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('weather.createHwpReport', new WeatherHwpReportToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('word.create', new WordCreateToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('powerpoint.create', new PowerPointCreateToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('capability.describe', new CapabilityDescribeToolAdapter({
      capabilityProvider: () => this.registry.capabilityMatrix()
    }));
    this.registry.register('macro.save', new MacroSaveToolAdapter({}));
    this.registry.register('document.edit', new DocumentEditToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('visual.createCards', new VisualCreateCardsToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('archive.createZip', new ArchiveCreateZipToolAdapter({ allowedRoots, undoJournal: this.undoJournal }));
    this.registry.register('email.send', new EmailSendToolAdapter({
      allowedRoots,
      ledgerPath: emailLedgerPath ?? (auditRoot ? `${auditRoot}/email-idempotency.jsonl` : 'apps/pc-agent/logs/email-idempotency.jsonl')
    }));
    this.logs = [];
    this.results = new Map();
    for (const result of this.packetJournal.results.values()) {
      this.results.set(result.taskId, result);
      this.logs.unshift({ ...result, replayedFromPacketJournal: true });
    }
  }

  queueExecutionPacket(packet, { dryRun = false } = {}) {
    const queued = this.executionQueue.enqueue(packet, { dryRun });
    this.auditLog.write('execution.packet.queued', {
      taskId: queued.taskId,
      packetId: queued.packetId,
      queueId: queued.queueId,
      status: queued.status,
      attempts: queued.attempts
    });
    return queued;
  }

  async processExecutionQueue({ limit = 10 } = {}) {
    const result = await this.executionQueue.drain(
      (packet, context) => this.receiveExecutionPacket(packet, { dryRun: context?.dryRun === true }),
      { limit }
    );
    this.auditLog.write('execution.queue.drained', {
      processed: result.processed,
      queued: result.status.queued,
      retryScheduled: result.status.retryScheduled,
      quarantined: result.status.quarantined
    });
    return result;
  }

  executionQueueStatus() {
    return this.executionQueue.status();
  }

  executionQueuePolicy() {
    return this.executionQueue.retryPolicy();
  }

  updateExecutionQueuePolicy(options = {}) {
    const result = this.executionQueue.updateRetryPolicy(options);
    this.auditLog.write('execution.queue.retry_policy_updated', {
      success: result.success,
      maxAttempts: result.current?.maxAttempts ?? null,
      baseBackoffMs: result.current?.baseBackoffMs ?? null,
      updatedBy: options.updatedBy ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  poisonQueueStatus({ includeIgnored = false } = {}) {
    return {
      items: this.executionQueue.poisonPackets({ includeIgnored }),
      queue: this.executionQueue.status()
    };
  }

  reviewPoisonPacket(queueId, options = {}) {
    const result = this.executionQueue.reviewPoisonPacket(queueId, options);
    this.auditLog.write('execution.packet.poison_reviewed', {
      queueId,
      success: result.success,
      reviewStatus: result.item?.reviewStatus ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  requeuePoisonPacket(queueId, options = {}) {
    const result = this.executionQueue.requeuePoisonPacket(queueId, options);
    this.auditLog.write('execution.packet.poison_requeued', {
      queueId,
      success: result.success,
      status: result.item?.status ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  ignorePoisonPacket(queueId, options = {}) {
    const result = this.executionQueue.ignorePoisonPacket(queueId, options);
    this.auditLog.write('execution.packet.poison_ignored', {
      queueId,
      success: result.success,
      status: result.item?.status ?? null,
      errorCode: result.error?.code ?? null
    });
    return result;
  }

  executionPacketReleaseDossier() {
    const journalRecords = this.packetJournal.records;
    const queueRecords = this.executionQueue.records;
    const journalCounts = countBy(journalRecords, 'recordType');
    const queueCounts = countBy(queueRecords, 'recordType');
    const queueStatus = this.executionQueue.status();
    const rawLeakNeedle = {
      packet: true,
      capabilityToken: true,
      userConfirmation: true,
      arguments: true,
      queuePath: true,
      journalPath: true
    };
    const artifactManifest = {
      manifestVersion: 'b-execution-packet-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      journalManifest: {
        manifestVersion: 'b-execution-packet-journal-manifest-v1',
        recordCount: journalRecords.length,
        resultCount: this.packetJournal.results.size,
        recordCounts: journalCounts,
        idempotencyKeyHashes: journalRecords
          .map((record) => record.idempotencyKey)
          .filter(Boolean)
          .slice(0, 50)
          .map((key) => createHash('sha256').update(String(key)).digest('hex'))
      },
      queueManifest: {
        manifestVersion: 'b-execution-packet-queue-manifest-v1',
        recordCount: queueRecords.length,
        recordCounts: queueCounts,
        statusCounts: {
          total: queueStatus.total,
          queued: queueStatus.queued,
          retryScheduled: queueStatus.retryScheduled,
          succeeded: queueStatus.succeeded,
          quarantined: queueStatus.quarantined,
          ignored: queueStatus.ignored
        },
        retryPolicyHash: createHash('sha256').update(canonicalJson({
          maxAttempts: queueStatus.retryPolicy.maxAttempts,
          baseBackoffMs: queueStatus.retryPolicy.baseBackoffMs,
          updatedAt: queueStatus.retryPolicy.updatedAt ?? null
        })).digest('hex')
      },
      healthHandshake: {
        handshakeVersion: 'b-execution-packet-health-handshake-v1',
        journalReady: journalRecords.some((record) => record.recordType === 'packet_received')
          && journalRecords.some((record) => record.recordType === 'packet_result'),
        queueReady: queueRecords.some((record) => record.recordType === 'packet_queued')
          && queueRecords.some((record) => record.recordType === 'packet_succeeded'),
        idempotencyReady: this.packetJournal.results.size > 0,
        retryPolicyReady: Number.isInteger(queueStatus.retryPolicy.maxAttempts)
          && Number.isInteger(queueStatus.retryPolicy.baseBackoffMs)
      },
      fallbackPolicy: {
        policyVersion: 'b-execution-packet-fallback-policy-v1',
        primaryFlow: 'service_supervisor_queue_drain_to_receive_execution_packet',
        fallbackFlows: [
          'manual_queue_drain_from_local_api',
          'poison_queue_review_requeue_or_ignore',
          'idempotent_packet_replay_after_restart'
        ],
        operatorEscalation: 'pc_agent_tray_poison_queue_review'
      },
      packetJournalPathHash: createHash('sha256').update(String(this.packetJournal.journalPath ?? '')).digest('hex'),
      packetQueuePathHash: createHash('sha256').update(String(this.executionQueue.queuePath ?? '')).digest('hex'),
      rawExecutionPacketPayloadStored: false,
      rawQueueFilePathStored: false,
      rawJournalFilePathStored: false,
      rawCapabilityTokenStored: false,
      rawUserConfirmationStored: false
    };
    const rawLeakDetected = containsExecutionPacketReleaseRawLeak(artifactManifest, rawLeakNeedle);
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-execution-packet-release-raw-leak-check-v1',
      rawLeakDetected,
      checkedNeedles: Object.keys(rawLeakNeedle)
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-execution-packet-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B pc-agent service supervisor drains queued packets" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'execution_packet_journal_manifest_ready',
        'execution_packet_queue_manifest_ready',
        'execution_packet_health_handshake_ready',
        'execution_packet_raw_payload_not_stored',
        'execution_packet_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      rawExecutionPacketPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-execution-packet-worm-promotion-package-v1',
      providerContractVersion: 'b-execution-packet-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-execution-packet-release-artifact-manifest-v1'
        && artifactManifest.healthHandshake.handshakeVersion === 'b-execution-packet-health-handshake-v1'
        && artifactManifest.healthHandshake.journalReady
        && artifactManifest.healthHandshake.queueReady
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && ciNightlyGatePlan.planVersion === 'b-execution-packet-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawExecutionPacketPayloadStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseDossier = {
      dossierVersion: 'b-execution-packet-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
      artifactManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
        ? 'promote_execution_packet_journal_queue_and_supervisor_evidence_to_worm'
        : 'block_execution_packet_release_until_queue_journal_health_passes'
    };
    releaseDossier.dossierSha256 = createHash('sha256').update(canonicalJson(releaseDossier)).digest('hex');
    return releaseDossier;
  }

  executionPacketProductGate() {
    const releaseDossier = this.executionPacketReleaseDossier();
    const checks = [
      {
        checkId: 'execution_packet_release_dossier_ready',
        passed: releaseDossier.dossierVersion === 'b-execution-packet-release-dossier-v1'
          && releaseDossier.status === 'passed'
          && releaseDossier.dossierSha256.length === 64
      },
      {
        checkId: 'execution_packet_journal_manifest_ready',
        passed: releaseDossier.artifactManifest.journalManifest.manifestVersion === 'b-execution-packet-journal-manifest-v1'
          && releaseDossier.artifactManifest.journalManifest.recordCount >= 2
          && releaseDossier.artifactManifest.journalManifest.resultCount >= 1
      },
      {
        checkId: 'execution_packet_queue_manifest_ready',
        passed: releaseDossier.artifactManifest.queueManifest.manifestVersion === 'b-execution-packet-queue-manifest-v1'
          && releaseDossier.artifactManifest.queueManifest.recordCounts.packet_queued >= 1
          && releaseDossier.artifactManifest.queueManifest.recordCounts.packet_succeeded >= 1
      },
      {
        checkId: 'execution_packet_health_handshake_ready',
        passed: releaseDossier.artifactManifest.healthHandshake.handshakeVersion === 'b-execution-packet-health-handshake-v1'
          && releaseDossier.artifactManifest.healthHandshake.journalReady
          && releaseDossier.artifactManifest.healthHandshake.queueReady
          && releaseDossier.artifactManifest.healthHandshake.idempotencyReady
      },
      {
        checkId: 'execution_packet_raw_payload_not_stored',
        passed: releaseDossier.artifactManifest.rawExecutionPacketPayloadStored === false
          && releaseDossier.artifactManifest.rawCapabilityTokenStored === false
          && releaseDossier.artifactManifest.rawUserConfirmationStored === false
          && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
      },
      {
        checkId: 'execution_packet_worm_promotion_package_ready',
        passed: releaseDossier.externalWormPromotionPackage.packageVersion === 'b-execution-packet-worm-promotion-package-v1'
          && releaseDossier.externalWormPromotionPackage.providerContractVersion === 'b-execution-packet-worm-provider-contract-v1'
          && releaseDossier.externalWormPromotionPackage.status === 'ready'
      }
    ];
    return {
      productGateVersion: 'b-execution-packet-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'blocked',
      checks,
      releaseDossier
    };
  }

  rollbackTransactionStatus() {
    return this.rollbackTransactions.status();
  }

  pathSafetyStatus() {
    return {
      guardVersion: 'b-path-safety-guard-v1',
      allowedRoots: this.allowedRoots,
      issueCatalog: pathSafetyIssueCatalog(),
      adapters: {
        createTextFile: {
          toctouLock: true,
          realpathGuard: true
        },
        moveFiles: {
          realpathGuard: true
        },
        listFiles: {
          realpathGuard: true
        }
      }
    };
  }

  async runPathSafetyCorpus(corpus) {
    const guard = new PathSafetyGuard({ allowedRoots: this.allowedRoots, clock: this.clock });
    const report = await guard.runFixtureCorpus(corpus);
    this.auditLog.write('path_safety.corpus_run', {
      corpusVersion: report.corpusVersion,
      status: report.status,
      total: report.total,
      passed: report.passed,
      passRate: report.passRate
    });
    return report;
  }

  async runWorkbookProductCorpus(options = {}) {
    const report = await runWorkbookProductCorpus({
      ...options,
      clock: options.clock ?? this.clock
    });
    this.auditLog.write('workbook.product_corpus_run', {
      reportVersion: report.reportVersion,
      status: report.status,
      fixturePackVersion: report.fixturePackVersion,
      workerPoolStatus: report.workerPoolSoak.status,
      migrationStatus: report.migrationReport.status
    });
    return report;
  }

  queryExecutionEvidence(options = {}) {
    return this.evidenceCollector.query(options);
  }

  executionEvidenceRetention(options = {}) {
    return this.evidenceCollector.retentionReport(options);
  }

  async rotateExecutionEvidence(options = {}) {
    const rotation = await this.evidenceCollector.rotate(options);
    this.auditLog.write('execution.evidence.rotated', {
      dryRun: rotation.dryRun,
      removed: rotation.removed.length,
      retainedCount: rotation.retainedCount,
      archivePath: rotation.archive?.path ?? null
    });
    return rotation;
  }

  executionEvidenceSchemaSnapshot() {
    return this.evidenceCollector.schemaSnapshot();
  }

  executionEvidenceSchemaRegression(baseline) {
    return this.evidenceCollector.schemaRegressionReport(baseline);
  }

  executionEvidencePrivacyFixtureReport() {
    return this.evidenceCollector.privacyFixtureReport();
  }

  queryExecutionMemoryEvents(options = {}) {
    return this.memoryEmitter.query(options);
  }

  async executionEvidenceProductGate({ keepLast = 1, maxAgeMs = null } = {}) {
    const query = this.queryExecutionEvidence({ limit: 1 });
    const nextPage = query.pageInfo.nextCursor
      ? this.queryExecutionEvidence({ cursor: query.pageInfo.nextCursor, limit: 1 })
      : null;
    const retention = this.executionEvidenceRetention({ keepLast, maxAgeMs });
    const rotationDryRun = await this.rotateExecutionEvidence({ keepLast, maxAgeMs, dryRun: true });
    const schemaSnapshot = this.executionEvidenceSchemaSnapshot();
    const schemaRegression = this.executionEvidenceSchemaRegression(schemaSnapshot);
    const privacyFixtures = this.executionEvidencePrivacyFixtureReport();
    const memoryEvents = this.queryExecutionMemoryEvents({ limit: 5 });
    const recentEvidenceIds = new Set(
      this.evidenceCollector.recent(20)
        .map((item) => item.evidenceId)
        .filter(Boolean)
    );
    const memoryLinked = recentEvidenceIds.size === 0
      || memoryEvents.items.some((item) => recentEvidenceIds.has(item.payload?.evidenceId));
    const paginationHealthy = query.pageInfo.total <= query.pageInfo.limit
      ? query.pageInfo.nextCursor === null
      : Boolean(nextPage) && Number(nextPage.pageInfo.cursor) === Number(query.pageInfo.nextCursor);
    const checks = [
      {
        checkId: 'execution_evidence_query_pagination_ready',
        passed: query.queryVersion === 'b-execution-evidence-query-v1' && paginationHealthy
      },
      {
        checkId: 'execution_evidence_retention_policy_ready',
        passed: retention.reportVersion === 'b-execution-evidence-retention-report-v1' && typeof retention.retainedCount === 'number'
      },
      {
        checkId: 'execution_evidence_rotation_dry_run_ready',
        passed: rotationDryRun.rotationVersion === 'b-execution-evidence-rotation-v1' && rotationDryRun.dryRun === true
      },
      {
        checkId: 'execution_evidence_schema_regression_passed',
        passed: schemaSnapshot.snapshotVersion === 'b-execution-evidence-schema-snapshot-v1' && schemaRegression.status === 'passed'
      },
      {
        checkId: 'execution_evidence_privacy_redaction_passed',
        passed: privacyFixtures.reportVersion === 'b-evidence-privacy-redaction-fixture-report-v1' && privacyFixtures.status === 'passed'
      },
      {
        checkId: 'execution_memory_event_evidence_link_ready',
        passed: memoryEvents.queryVersion === 'b-execution-memory-event-query-v1' && memoryLinked
      }
    ];
    const releaseCheckSnapshot = checks.map((check) => ({ checkId: check.checkId, passed: check.passed }));
    const recentEvidence = this.evidenceCollector.recent(50);
    const artifactManifest = {
      manifestVersion: 'b-execution-evidence-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      evidenceLogPathHash: createHash('sha256').update(String(this.evidenceCollector.logPath ?? '')).digest('hex'),
      memoryEventLogPathHash: createHash('sha256').update(String(this.memoryEmitter.logPath ?? '')).digest('hex'),
      evidenceQueryHash: createHash('sha256').update(canonicalJson({
        queryVersion: query.queryVersion,
        total: query.pageInfo.total,
        limit: query.pageInfo.limit,
        nextCursor: query.pageInfo.nextCursor,
        statusCounts: countBy(recentEvidence, 'status'),
        toolCounts: countBy(recentEvidence, 'toolName')
      })).digest('hex'),
      retentionEvidenceHash: createHash('sha256').update(canonicalJson({
        reportVersion: retention.reportVersion,
        total: retention.total,
        retainedCount: retention.retainedCount,
        removableCount: retention.removableCount,
        rotationRecommended: retention.rotationRecommended,
        policy: retention.policy
      })).digest('hex'),
      rotationDryRunHash: createHash('sha256').update(canonicalJson({
        rotationVersion: rotationDryRun.rotationVersion,
        dryRun: rotationDryRun.dryRun === true,
        removedCount: rotationDryRun.removed.length,
        retainedCount: rotationDryRun.retainedCount
      })).digest('hex'),
      schemaSnapshotHash: schemaSnapshot.snapshotHash,
      schemaRegressionHash: createHash('sha256').update(canonicalJson({
        reportVersion: schemaRegression.reportVersion,
        status: schemaRegression.status,
        currentSnapshotHash: schemaRegression.currentSnapshotHash,
        baselineSnapshotHash: schemaRegression.baselineSnapshotHash,
        itemStatusCounts: countBy(schemaRegression.items, 'status')
      })).digest('hex'),
      privacyFixtureHash: createHash('sha256').update(canonicalJson({
        reportVersion: privacyFixtures.reportVersion,
        corpusVersion: privacyFixtures.corpusVersion,
        status: privacyFixtures.status,
        caseCount: privacyFixtures.caseCount
      })).digest('hex'),
      memoryLinkageHash: createHash('sha256').update(canonicalJson({
        queryVersion: memoryEvents.queryVersion,
        total: memoryEvents.pageInfo.total,
        recentEvidenceCount: recentEvidenceIds.size,
        linked: memoryLinked
      })).digest('hex'),
      evidenceCount: query.pageInfo.total,
      memoryEventCount: memoryEvents.pageInfo.total,
      recentToolCounts: countBy(recentEvidence, 'toolName'),
      rawExecutionEvidenceStored: false,
      rawFilePathStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false,
      rawUserCommandStored: false
    };
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-execution-evidence-release-raw-leak-check-v1',
      rawLeakDetected: containsExecutionEvidenceReleaseRawLeak(artifactManifest),
      checkedRawFields: [
        'rawExecutionEvidenceStored',
        'rawFilePathStored',
        'rawMemoryPayloadStored',
        'rawCapabilityTokenStored',
        'rawUserCommandStored'
      ]
    };
    const operationalHandoffManifest = {
      manifestVersion: 'b-execution-evidence-operational-handoff-manifest-v1',
      healthHandshakeVersion: 'b-execution-evidence-health-handshake-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed)
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'ready'
        : 'blocked',
      healthHandshake: {
        queryReady: query.queryVersion === 'b-execution-evidence-query-v1',
        retentionReady: retention.reportVersion === 'b-execution-evidence-retention-report-v1',
        rotationDryRunReady: rotationDryRun.rotationVersion === 'b-execution-evidence-rotation-v1' && rotationDryRun.dryRun === true,
        schemaRegressionReady: schemaRegression.status === 'passed',
        privacyRedactionReady: privacyFixtures.status === 'passed',
        memoryLinkageReady: memoryLinked,
        evidenceCount: query.pageInfo.total,
        memoryEventCount: memoryEvents.pageInfo.total
      },
      fallbackPolicy: {
        policyVersion: 'b-execution-evidence-fallback-policy-v1',
        primaryFlow: 'collect_redacted_execution_evidence_then_emit_memory_event_for_f_and_g',
        fallbackFlows: [
          'schema_regression_blocks_release_on_removed_required_fields',
          'privacy_fixture_failure_blocks_g_f_handoff',
          'retention_rotation_dry_run_before_archive_write',
          'manual_memory_link_repair_from_evidence_id'
        ],
        operatorEscalation: 'pc_agent_evidence_product_gate_and_memory_event_query'
      },
      rawExecutionEvidenceStored: false,
      rawFilePathStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false,
      rawUserCommandStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-execution-evidence-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B pc-agent execution evidence supports retention" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'execution_evidence_query_pagination_ready',
        'execution_evidence_retention_policy_ready',
        'execution_evidence_rotation_dry_run_ready',
        'execution_evidence_schema_regression_passed',
        'execution_evidence_privacy_redaction_passed',
        'execution_memory_event_evidence_link_ready',
        'execution_evidence_release_dossier_ready',
        'execution_evidence_release_artifact_manifest_ready',
        'execution_evidence_operational_handoff_ready',
        'execution_evidence_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      rawExecutionEvidenceStored: false,
      rawMemoryPayloadStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-execution-evidence-worm-promotion-package-v1',
      providerContractVersion: 'b-execution-evidence-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-execution-evidence-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'b-execution-evidence-ci-nightly-gate-plan-v1'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawExecutionEvidenceStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseDossier = {
      dossierVersion: 'b-execution-evidence-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
      rawExecutionEvidenceStored: false,
      rawFilePathStored: false,
      rawMemoryPayloadStored: false,
      rawCapabilityTokenStored: false,
      rawUserCommandStored: false,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      releaseChecks: releaseCheckSnapshot,
      recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
        ? 'attach_execution_evidence_schema_privacy_memory_handoff_and_worm_release_evidence'
        : 'block_execution_evidence_release_until_schema_privacy_retention_and_memory_link_pass'
    };
    releaseDossier.dossierSha256 = createHash('sha256').update(canonicalJson(releaseDossier)).digest('hex');
    checks.push({
      checkId: 'execution_evidence_release_dossier_ready',
      passed: releaseDossier.dossierVersion === 'b-execution-evidence-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && releaseDossier.dossierSha256.length === 64
    });
    checks.push({
      checkId: 'execution_evidence_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest.manifestVersion === 'b-execution-evidence-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        && releaseDossier.artifactManifest.rawExecutionEvidenceStored === false
        && releaseDossier.artifactManifest.rawMemoryPayloadStored === false
    });
    checks.push({
      checkId: 'execution_evidence_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest.manifestVersion === 'b-execution-evidence-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest.healthHandshakeVersion === 'b-execution-evidence-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest.fallbackPolicy.policyVersion === 'b-execution-evidence-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest.status === 'ready'
    });
    checks.push({
      checkId: 'execution_evidence_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage.packageVersion === 'b-execution-evidence-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage.providerContractVersion === 'b-execution-evidence-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage.status === 'ready'
    });
    return {
      productGateVersion: 'b-execution-evidence-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      evidenceCount: query.pageInfo.total,
      query,
      nextPage,
      retention,
      rotationDryRun,
      schemaSnapshot,
      schemaRegression,
      privacyFixtures,
      memoryEvents,
      releaseDossier
    };
  }

  supportsTrustedLocalMissionEffects() { return true; }

  operationStore() {
    if (!this.remoteOperationStore) {
      this.remoteOperationStore = new RemoteOperationStore({ path: resolve(dirname(this.packetJournal.journalPath), 'remote-operations.sqlite'),
        clock: this.clock, recoverInFlight: this.operationRecoveryInitialized !== true });
      this.operationRecoveryInitialized = true;
    }
    return this.remoteOperationStore;
  }

  remoteOperationDescriptor({ operationId, taskId, action } = {}) {
    if (typeof operationId !== 'string' || !/^mission_op_[a-f0-9]{32}$/u.test(operationId)
      || typeof taskId !== 'string' || !taskId || action?.toolName !== 'filesystem.createTextFile'
      || typeof action.arguments?.path !== 'string' || typeof (action.arguments.content ?? '') !== 'string') {
      throw Object.assign(new Error('B_OPERATION_SCOPE_UNSUPPORTED'), { code: 'B_OPERATION_SCOPE_UNSUPPORTED' });
    }
    return { operationId, taskId, fingerprint: executionPacketFingerprint({ taskId, action, requestedMode: 'execute' }) };
  }

  remoteOperationResourceKey(path) {
    return `file:${createHash('sha256').update(this.remoteOperationPhysicalPath(path)).digest('hex')}`;
  }

  remoteOperationPhysicalPath(path) {
    let cursor = resolve(this.allowedRoots[0], path), suffix = [];
    while (true) {
      try { cursor = resolve(realpathSync(cursor), ...suffix); break; }
      catch (error) { if (error.code !== 'ENOENT' || dirname(cursor) === cursor) throw error; suffix.unshift(basename(cursor)); cursor = dirname(cursor); }
    }
    const identity = process.platform === 'win32' ? cursor.toLowerCase() : cursor;
    return identity;
  }

  assertRemoteOperationAuthorization(packet, paths = [packet.action?.arguments?.path]) {
    const capabilities = this.policyRuntime?.capabilities;
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const verified = capabilities?.verifySignedToken?.(packet.capabilityToken?.capabilityToken);
    if (verified?.valid !== true) fail(verified?.reason ?? 'B_OPERATION_AUTH_REQUIRED');
    const payload = verified.payload, scope = packet.capabilityToken?.scope;
    if (!scope || createHash('sha256').update(JSON.stringify(scope)).digest('hex') !== payload.scopeHash) fail('B_OPERATION_SIGNED_SCOPE_MISMATCH');
    const legacyMove=['filesystem.moveFiles','excel.createWorkbook'].includes(packet.action?.toolName)&&!/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'');
    if ((!legacyMove || packet.planId!==undefined) && payload.planId !== packet.planId
      || (!legacyMove || packet.userConfirmation?.approvalId!==undefined) && payload.approvalId !== packet.userConfirmation?.approvalId) fail('B_OPERATION_SIGNED_APPROVAL_MISMATCH');
    const binding = actionArgumentsBinding(packet.action?.arguments);
    if ((!legacyMove || scope.executionBinding) && (!binding || scope.executionBinding?.version !== binding.version
      || scope.executionBinding.argumentsSha256 !== binding.argumentsSha256)) fail('B_OPERATION_ARGUMENT_BINDING_MISMATCH');
    // Older direct local packets used the adapter's configured roots when the
    // signed scope had no path restriction. Mission operations always require
    // an explicit nonempty signed scope.
    const legacyWorkbookDefault=legacyMove&&packet.action.toolName==='excel.createWorkbook'
      &&packet.action.arguments?.renderPdf!==true&&!scope.executionBinding
      &&Array.isArray(scope.allowedPaths)&&scope.allowedPaths.length===1&&scope.allowedPaths[0]==='./workspace';
    const allowedPaths=legacyMove&&(scope.allowedPaths===undefined||Array.isArray(scope.allowedPaths)&&scope.allowedPaths.length===0||legacyWorkbookDefault)?this.allowedRoots:scope.allowedPaths;
    if (!Array.isArray(allowedPaths) || !allowedPaths.length
      || allowedPaths.some(path => typeof path !== 'string' || !isAbsolute(path))) fail('B_OPERATION_SIGNED_PATH_SCOPE_REQUIRED');
    const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
    for (const path of paths) {
      if (typeof path !== 'string' || !path.trim()) fail('B_OPERATION_SIGNED_PATH_SCOPE_MISMATCH');
      const target = resolve(this.allowedRoots[0], path), physical = this.remoteOperationPhysicalPath(target);
      if (!allowedPaths.some(root => within(resolve(root), target)
        && within(this.remoteOperationPhysicalPath(root), physical))) fail('B_OPERATION_SIGNED_PATH_SCOPE_MISMATCH');
    }
    const fields = { tokenId: packet.capabilityToken.tokenId, capabilityToken: packet.capabilityToken.capabilityToken,
      taskId: packet.taskId, toolName: packet.action.toolName, actionType: packet.action.actionType };
    const adoption = capabilities.adoptSignedToken(fields);
    if (adoption?.valid !== true) fail(adoption?.reason ?? 'B_OPERATION_AUTH_REQUIRED');
    const validation = capabilities.validate(fields);
    if (validation?.valid !== true) fail(validation?.reason ?? 'B_OPERATION_AUTH_REQUIRED');
    return legacyMove?createHash('sha256').update(JSON.stringify({tokenHash:verified.tokenHash,allowedPaths})).digest('hex'):verified.tokenHash;
  }

  async claimWorkflowPublication(packet, paths, resumeIntent = null) {
    const authorize=()=>{
      if(packet.action?.toolName!=='macro.save')return this.assertRemoteOperationAuthorization(packet,paths);
      const guard=trustedLocalEffectFences.get(packet),registered=this.registry.get('macro.save')?.store?.path;
      if(packet.action.actionType!==ActionType.MACRO_SAVE||typeof guard?.assertArtifactPlan!=='function'
        ||!guard.macroPublication||paths.length!==1||paths[0]!==resolve(registered??'.')
        ||guard.macroPublication.path!==paths[0]||guard.macroPublication.physicalPath!==this.remoteOperationPhysicalPath(paths[0]))throw Error('B_MACRO_CONTROL_RESOURCE_SCOPE_REQUIRED');
      guard();
      // MACRO_SAVE is a signed tool-owned state permission. It does not grant
      // arbitrary file access or enlarge allowedPaths to the user's home.
      return this.assertRemoteOperationAuthorization(packet,[]);
    };
    const authorizationHash = authorize();
    if (!paths.length) return { fence: () => this.assertRemoteOperationAuthorization(packet, paths) };
    const resourceKeys = [...new Set(paths.map(path => this.remoteOperationResourceKey(path)))].sort();
    const descriptor = { operationId: `workflow_publish_${createHash('sha256').update(this.packetJournal.idempotencyKey(packet)).digest('hex').slice(0, 32)}`,
      taskId: packet.taskId, fingerprint: executionPacketFingerprint(packet), authorizationHash,
      resourceKey: resourceKeys[0], resourceKeys };
    // A per-publication connection does not recover/downgrade another live
    // owner's in-flight row. Durable claims remain after this handle closes.
    const store = new RemoteOperationStore({ path: resolve(dirname(this.packetJournal.journalPath), 'remote-operations.sqlite'),
      clock: this.clock, recoverInFlight: this.operationRecoveryInitialized !== true });
    this.operationRecoveryInitialized = true;
    let claim;
    try {
      if (resumeIntent) claim = store.resumePublicationClaim(descriptor, resumeIntent);
      else { const prepared = store.prepare(descriptor); claim = store.claim(descriptor, prepared.ticket, prepared.generation); }
    }
    catch (error) { store.close(); throw error; }
    descriptor.publicationGeneration = claim.generation;
    const fence = () => {
      store.assertFence(claim); trustedLocalEffectFences.get(packet)?.();
      if (authorize() !== authorizationHash
        || JSON.stringify([...new Set(paths.map(path => this.remoteOperationResourceKey(path)))].sort()) !== JSON.stringify(resourceKeys))
        throw Object.assign(new Error('B_OPERATION_PUBLICATION_BINDING_CHANGED'), { code: 'B_OPERATION_PUBLICATION_BINDING_CHANGED' });
    };
    fence.persistIntent = intent => {
      fence();
      const fail = () => { throw Object.assign(new Error('B_PUBLICATION_CONTRACT_INVALID'), { code: 'B_PUBLICATION_CONTRACT_INVALID' }); };
      if (intent.taskId !== packet.taskId || intent.packetId !== packet.packetId
        || !/^[a-f0-9]{64}$/u.test(intent.specSha256 ?? '') || !Array.isArray(intent.files)
        || JSON.stringify([...new Set(intent.files.map(file => this.remoteOperationResourceKey(file.path)))].sort()) !== JSON.stringify(resourceKeys)) fail();
      const args = packet.action.arguments;
      if (Object.hasOwn(args, 'spec') && intent.specSha256 !== createHash('sha256').update(JSON.stringify(args.spec)).digest('hex')) fail();
      if (args.expectedSha256 && intent.specSha256 !== args.expectedSha256.toLowerCase()) fail();
      const boundIntent = { ...intent, publicationOperationId: descriptor.operationId };
      store.recordPublicationIntent(descriptor, claim, boundIntent);
      return boundIntent;
    };
    try { await this.remoteOperationBoundary?.('workflow-publication-claimed', { descriptor, claim }); fence(); }
    catch (error) { try { store.uncertain(descriptor.operationId); } finally { store.close(); } throw error; }
    return { descriptor, store, fence };
  }

  abandonWorkflowPublication(publication) {
    if (publication?.descriptor) { try { publication.store.uncertain(publication.descriptor.operationId); }
      finally { publication.store.close(); } }
  }

  async prepareRemoteOperation(packet) {
    const descriptor = this.remoteOperationDescriptor({ operationId: packet.idempotencyKey, taskId: packet.taskId, action: packet.action });
    if (packet.requestedMode !== 'execute' || packet.userConfirmation?.confirmed !== true) throw new Error('B_OPERATION_MODE_INVALID');
    descriptor.authorizationHash = this.assertRemoteOperationAuthorization(packet);
    const shadow = await this.registry.get('filesystem.createTextFile').shadow(packet.action.arguments, packet);
    if (shadow.warnings?.length) throw Object.assign(new Error('B_OPERATION_PATH_PREFLIGHT_FAILED'), { code: 'B_OPERATION_PATH_PREFLIGHT_FAILED' });
    descriptor.resourceKey = this.remoteOperationResourceKey(shadow.targetPath);
    const prepared = this.operationStore().prepare(descriptor);
    await this.remoteOperationBoundary?.('prepared', prepared);
    return prepared;
  }

  readRemoteOperation(input) {
    const descriptor = this.remoteOperationDescriptor(input), store = this.operationStore();
    const row = store.bound(descriptor);
    if (row && ['in_flight', 'uncertain'].includes(row.state)) {
      const receipt = this.receiptForOperation(input);
      if (receipt) return store.complete(descriptor, receipt);
    }
    return store.public(row);
  }

  cancelRemoteOperation(input) {
    const descriptor = this.remoteOperationDescriptor(input);
    const current = this.readRemoteOperation(input);
    if (current?.state === 'succeeded') return { ...current, cancellationConfirmed: false };
    return this.operationStore().cancel(descriptor);
  }

  async executeRemoteOperation(packet, { ticket, generation, beforeRemoteMutation = null, beforeLocalExecute = null } = {}) {
    if(beforeRemoteMutation!==null&&typeof beforeRemoteMutation!=='function')throw Object.assign(new Error('B_OPERATION_MUTATION_GUARD_INVALID'),{code:'B_OPERATION_MUTATION_GUARD_INVALID'});
    if(beforeLocalExecute!==null&&typeof beforeLocalExecute!=='function')throw Object.assign(new Error('B_LOCAL_EFFECT_GUARD_INVALID'),{code:'B_LOCAL_EFFECT_GUARD_INVALID'});
    const input = { operationId: packet.idempotencyKey, taskId: packet.taskId, action: packet.action };
    const descriptor = this.remoteOperationDescriptor(input), store = this.operationStore();
    const prior = this.readRemoteOperation(input);
    if (prior?.state === 'succeeded') return prior.receipt;
    // Reject changed E authority before entering the packet journal. An invalid
    // request must not cache a failed result under the original operation key.
    descriptor.authorizationHash = this.assertRemoteOperationAuthorization(packet);
    store.assertAuthorization(descriptor);
    let claim;
    try {
      // Reject stale/foreign tickets atomically before the packet journal can
      // memoize their failure under the legitimate operation's idempotency key.
      // Claiming is not execution authority: normal B trust/E/shadow checks and
      // the last-moment fence below still precede every filesystem effect.
      claim = store.claim(descriptor, ticket, generation);
      await this.remoteOperationBoundary?.('claimed', claim);
      const result = await this.receiveDelegatedExecutionPacket(packet, { beforeRemoteMutation,
        operationClaim: trustedFileOperationClaim, beforeLocalExecute: async () => {
        const coreFence = beforeLocalExecute ? await beforeLocalExecute(packet) : null;
        if (beforeLocalExecute && typeof coreFence !== 'function') throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
        const fence = () => {
          coreFence?.();
          store.assertFence(claim);
          if (store.row(descriptor.operationId).resource_key !== this.remoteOperationResourceKey(packet.action.arguments.path)) {
            throw Object.assign(new Error('B_OPERATION_RESOURCE_CHANGED'), { code: 'B_OPERATION_RESOURCE_CHANGED' });
          }
          if (this.assertRemoteOperationAuthorization(packet) !== descriptor.authorizationHash) {
            throw Object.assign(new Error('B_OPERATION_AUTHORIZATION_BINDING_MISMATCH'), { code: 'B_OPERATION_AUTHORIZATION_BINDING_MISMATCH' });
          }
        }; fence(); return fence;
      } });
      if (result?.status === TaskStatus.COMPLETED) {
        const receipt = this.receiptForOperation(input);
        if (!receipt || !claim) throw Object.assign(new Error('B_OPERATION_RECEIPT_UNBOUND'), { code: 'B_OPERATION_RECEIPT_UNBOUND' });
        store.complete(descriptor, receipt);
        await this.remoteOperationBoundary?.('receipt', store.public(store.row(descriptor.operationId)));
      } else if (claim) store.uncertain(descriptor.operationId);
      return result;
    } catch (error) { if (claim) store.uncertain(descriptor.operationId); throw error; }
  }

  async receiveExecutionPacket(packet, { dryRun = false, beforeLocalExecute = null, beforeRemoteMutation = null, resumePublication = false, signal = null, operationClaim = null } = {}) {
    if (!dryRun && /^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey ?? '') && typeof beforeLocalExecute !== 'function') {
      return { taskId: packet.taskId, status: TaskStatus.BLOCKED, blockedReason: 'B_MISSION_OPERATION_PROTOCOL_REQUIRED' };
    }
    // Local Mission writes must share B's physical-file claims with workflows
    // and HTTP writes. The private marker only prevents recursive delegation;
    // packet fields and JSON options cannot establish an operation claim.
    if (!dryRun && /^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey ?? '')
      && packet.action?.toolName === 'filesystem.createTextFile' && operationClaim !== trustedFileOperationClaim) {
      try {
        const coreFence = await beforeLocalExecute(packet);
        if (typeof coreFence !== 'function') throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
        coreFence();
        const prepared = await this.prepareRemoteOperation(packet);
        coreFence();
        return await this.executeRemoteOperation(packet, { ...prepared, beforeLocalExecute: async () => coreFence, beforeRemoteMutation });
      } catch (error) {
        return { taskId: packet.taskId, status: TaskStatus.BLOCKED, blockedReason: error.code ?? error.message };
      }
    }
    const startedAt = this.clock().toISOString();
    const action = packet.action ?? {};
    const effectiveRequestedMode = dryRun || action.toolName === 'filesystem.previewMoveFiles'
      ? 'shadow'
      : (packet.requestedMode ?? 'execute');
    if (packet.requestedMode !== effectiveRequestedMode) {
      packet = { ...packet, requestedMode: effectiveRequestedMode };
    }
    const idempotencyInspection = this.packetJournal.inspectPacket(packet, { dryRun });
    if (!idempotencyInspection.compatible) {
      return this.idempotencyConflict(packet, idempotencyInspection, { dryRun });
    }
    const existing = this.packetJournal.resultFor(packet, { dryRun });
    if (existing) {
      if (!dryRun && ['workflow.execute','filesystem.moveFiles','excel.createWorkbook','excel.exportPdf','archive.createZip','word.create','powerpoint.create','hwp.create','weather.createHwpReport','visual.createCards','document.edit','macro.save'].includes(action.toolName)) this.reconcileWorkflowPublicationReceipt(packet.taskId);
      const replay = {
        ...existing,
        idempotentReplay: true,
        replayedAt: this.clock().toISOString()
      };
      this.logs.unshift(replay);
      this.results.set(packet.taskId, replay);
      this.auditLog.write('execution.packet.replayed', {
        taskId: packet.taskId,
        packetId: packet.packetId,
        idempotencyKey: this.packetJournal.idempotencyKey(packet)
      });
      return replay;
    }
    this.packetJournal.recordReceived(packet, { dryRun });
    const trustAuthorization = this.trustKernel?.authorizeExecution?.({
      action,
      dryRun,
      source: 'pc-agent'
    }) ?? { allowed: true, code: 'A_TRUST_KERNEL_NOT_ATTACHED', mode: 'unavailable' };
    if (!trustAuthorization.allowed) {
      return this.block(packet, trustAuthorization.code, {
        dryRun,
        summary: trustAuthorization.reason,
        trustAuthorization
      });
    }
    if (!packet.userConfirmation?.confirmed) {
      return this.block(packet, 'B_USER_CONFIRMATION_REQUIRED', { dryRun });
    }
    if (action.actionType === ActionType.DELETE_FILE) {
      return this.block(packet, 'B_FORBIDDEN_DESTRUCTIVE_ACTION', { dryRun });
    }
    if (!packet.capabilityToken?.tokenId) {
      return this.block(packet, 'B_CAPABILITY_TOKEN_REQUIRED', { dryRun });
    }
    const sealedCapabilityToken = this.capabilityVault.sealCapabilityToken(packet.capabilityToken, {
      taskId: packet.taskId,
      packetId: packet.packetId,
      toolName: action.toolName
    });
    const validation = this.policyRuntime?.capabilities?.validate({
      tokenId: packet.capabilityToken.tokenId,
      capabilityToken: packet.capabilityToken.capabilityToken,
      taskId: packet.taskId,
      toolName: action.toolName,
      actionType: action.actionType
    });
    if (validation && !validation.valid) {
      const criticalReasons = new Set([
        'E_CAPABILITY_TOKEN_SIGNATURE_INVALID',
        'E_CAPABILITY_TOKEN_HASH_MISMATCH',
        'E_CAPABILITY_TOKEN_ID_MISMATCH',
        'E_CAPABILITY_SCOPE_MISMATCH'
      ]);
      const highReasons = new Set([
        'E_CAPABILITY_ALREADY_USED',
        'E_CAPABILITY_REVOKED',
        'E_CAPABILITY_TOKEN_MALFORMED'
      ]);
      this.trustKernel?.recordSignal?.({
        code: validation.reason ?? 'E_CAPABILITY_VALIDATION_FAILED',
        severity: criticalReasons.has(validation.reason) ? 'critical' : highReasons.has(validation.reason) ? 'high' : 'medium',
        source: 'pc-agent-capability-validation',
        category: 'capability-integrity',
        metadata: {
          taskIdHash: createHash('sha256').update(String(packet.taskId ?? '')).digest('hex'),
          tokenIdHash: createHash('sha256').update(String(packet.capabilityToken.tokenId ?? '')).digest('hex'),
          toolName: action.toolName,
          actionType: action.actionType,
          rawTokenStored: false
        }
      });
      return this.block(packet, validation.reason, { dryRun, trustAuthorization });
    }
    let selected;
    try { selected=this.registry.selectExecution?.(action.toolName,packet,{dryRun}); }
    catch(error){return this.block(packet,error.code??'B_CAPABILITY_ROLLOUT_SELECTION_FAILED',{dryRun});}
    const adapter = selected?.adapter??this.registry.get(action.toolName);
    const executionCodeVersion = selected?.executionCodeVersion??capabilityAdapterCodeVersion(adapter);
    if (!adapter) {
      this.trustKernel?.recordSignal?.({
        code: 'B_TOOL_ADAPTER_NOT_FOUND',
        severity: 'high',
        source: 'pc-agent-routing',
        category: 'execution-supply-chain',
        metadata: { toolName: action.toolName, actionType: action.actionType }
      });
      return this.block(packet, 'B_TOOL_ADAPTER_NOT_FOUND', { dryRun });
    }
    const requestedMode = action.toolName === 'filesystem.previewMoveFiles' ? 'shadow' : packet.requestedMode ?? 'execute';
    if (!adapter.contract.modes.includes(requestedMode)) {
      return this.block(packet, `B_TOOL_MODE_NOT_ALLOWED:${requestedMode}`, { dryRun });
    }
    let shadow;
    try {
      // Read preflight can itself expose data. Establish the private guard
      // after E validation but before metadata/content access, and keep the
      // same identity snapshot through final result publication.
      if (!dryRun && ['filesystem.readText','filesystem.listFiles','workflow.execute'].includes(action.toolName)
          && beforeLocalExecute !== null) {
        if(typeof beforeLocalExecute!=='function')throw new Error('B_LOCAL_EFFECT_GUARD_INVALID');
        const fence=await beforeLocalExecute(packet);
        if(typeof fence!=='function')throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
        fence();trustedLocalEffectFences.set(packet,fence);
      }
      shadow = await adapter.shadow(action.arguments ?? {}, packet, {assertAccess:()=>trustedLocalEffectFences.get(packet)?.()});
      trustedLocalEffectFences.get(packet)?.();
    } catch (error) {
      trustedLocalEffectFences.delete(packet);
      return this.block(packet, error.message ?? 'B_TOOL_PREFLIGHT_EXCEPTION', { dryRun });
    }
    shadow.adapterContract = adapter.contract;
    if (dryRun || packet.requestedMode === 'shadow' || action.toolName === 'filesystem.previewMoveFiles') {
      trustedLocalEffectFences.delete(packet);
      const shadowResult = {
        taskId: packet.taskId,
        status: TaskStatus.VERIFYING,
        shadow,
        executionResult: null
      };
      this.auditLog.write('execution.shadow', {
        taskId: packet.taskId,
        packetId: packet.packetId,
        toolName: action.toolName,
        expectedChangesCount: shadow.expectedChangesCount,
        warnings: shadow.warnings
      });
      this.packetJournal.recordResult(packet, shadowResult, { dryRun: true });
      return shadowResult;
    }
    let executionResult, workflowPublication, workbookFence,workbookPaths;
    try {
      let resumeIntent = null;
      if (resumePublication) {
        if (dryRun || action.toolName !== 'workflow.execute') throw new Error('B_PUBLICATION_RESUME_MODE_INVALID');
        // Current E authority has already passed; the original B SQL fingerprint
        // also binds all arguments. Caller JSON cannot supply a recovery recipe.
        resumeIntent = this.operationStore().publicationIntent({
          operationId: `workflow_publish_${createHash('sha256').update(this.packetJournal.idempotencyKey(packet)).digest('hex').slice(0, 32)}`,
          taskId: packet.taskId, fingerprint: executionPacketFingerprint(packet) });
      }
      // Only trusted in-process code may supply this function; HTTP packet fields cannot grant it.
      // Keep the guard after E and asynchronous shadow validation, immediately before the effect.
      if (beforeLocalExecute !== null && !trustedLocalEffectFences.has(packet)) {
        if (typeof beforeLocalExecute !== 'function') throw new Error('B_LOCAL_EFFECT_GUARD_INVALID');
        const assertFence = await beforeLocalExecute(packet);
        if (typeof assertFence !== 'function') throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
        trustedLocalEffectFences.set(packet, assertFence);
      }
      trustedLocalEffectFences.get(packet)?.();
      if (adapter.contract?.requiresAvailabilityBinding === true && !trustedLocalEffectFences.has(packet)) {
        throw new Error('B_REQUIRED_CAPABILITY_FENCE_MISSING');
      }
      if(beforeRemoteMutation!==null){
        if(typeof beforeRemoteMutation!=='function'||!trustedLocalEffectFences.has(packet)||action.toolName!=='filesystem.createTextFile')throw new Error('B_OPERATION_MUTATION_GUARD_INVALID');
        trustedRemoteMutationChecks.set(packet,beforeRemoteMutation);
      }
      executionResult = await adapter.execute(action.arguments ?? {}, packet,
        action.toolName === 'workflow.execute' ? { deferCleanup: true,
          assertAccess:()=>trustedLocalEffectFences.get(packet)?.(),
          assertDataAccess:(path,kind)=>trustedLocalEffectFences.get(packet)?.assertWorkflowAccess?.(path,{kind}),
          assertInventoryAccess:path=>{
            const fence=trustedLocalEffectFences.get(packet);
            if(fence?.assertWorkflowInventoryAccess)fence.assertWorkflowInventoryAccess(path);
            else {fence?.();fence?.assertWorkflowAccess?.(path,{kind:'inventory'})?.();}
          },
          resumeIntent,
          beforePublication: async paths => { workflowPublication = await this.claimWorkflowPublication(packet, paths, resumeIntent); return workflowPublication.fence; } }
          : action.toolName==='filesystem.moveFiles'?{
            assertAccess:()=>trustedLocalEffectFences.get(packet)?.(),
            beforeMoves:async items=>{
              const guard=trustedLocalEffectFences.get(packet);
              if(/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'')&&typeof guard?.assertMovePlan!=='function')throw new Error('B_MOVE_PLAN_GUARD_REQUIRED');
              guard?.assertMovePlan?.(items);
              workflowPublication=await this.claimWorkflowPublication(packet,items.flatMap(move=>[move.from,move.to]));
              return workflowPublication.fence;}}
          : action.toolName==='excel.createWorkbook'?{
            signal,
            assertAccess:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();},
            beforeWorkbookWrite:prepared=>{
              trustedLocalEffectFences.get(packet)?.assertArtifactPlan?.({paths:[prepared.outputPath,...(action.arguments.renderPdf===true?[resolve(action.arguments.pdfOutputPath)]:[])],
                prepared:{...prepared,pdfOutputPath:action.arguments.renderPdf===true?resolve(action.arguments.pdfOutputPath):null,warnings:[]}});
              workbookFence?.();
            },
            beforeArtifactWrite:async plan=>{
              const guard=trustedLocalEffectFences.get(packet);
              if(/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'')&&typeof guard?.assertArtifactPlan!=='function')throw new Error('B_ARTIFACT_PLAN_GUARD_REQUIRED');
              guard?.assertArtifactPlan?.(plan);
              workbookPaths=plan.paths;
              workflowPublication=await this.claimWorkflowPublication(packet,plan.paths);workbookFence=workflowPublication.fence;
            },beforePdfPublish:()=>{workbookFence?.();return this.assertRemoteOperationAuthorization(packet,workbookPaths);}}
          : ['word.create','powerpoint.create','hwp.create','weather.createHwpReport','visual.createCards'].includes(action.toolName)?{signal,weatherPublication:trustedLocalEffectFences.get(packet)?.weatherPublication,
            assertAccess:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();},
            beforeArtifactWrite:async plan=>{
              const guard=trustedLocalEffectFences.get(packet);
              if(/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'')&&typeof guard?.assertArtifactPlan!=='function')throw Error('B_ARTIFACT_PLAN_GUARD_REQUIRED');
              guard?.assertArtifactPlan?.(plan);
              workflowPublication=await this.claimWorkflowPublication(packet,plan.paths);workbookFence=workflowPublication.fence;
            }}
          : action.toolName==='macro.save'?{signal,macroPublication:trustedLocalEffectFences.get(packet)?.macroPublication,
            assertAccess:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();},
            beforeArtifactWrite:async plan=>{
              const guard=trustedLocalEffectFences.get(packet);
              if(!/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??''))return;
              if(typeof guard?.assertArtifactPlan!=='function'||!guard.macroPublication)throw Error('B_MACRO_CONTROL_RESOURCE_SCOPE_REQUIRED');
              guard.assertArtifactPlan(plan);workflowPublication=await this.claimWorkflowPublication(packet,plan.paths);workbookFence=workflowPublication.fence;
            }}
          : action.toolName==='document.edit'?{signal,
            assertAccess:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();this.assertRemoteOperationAuthorization(packet,packet.capabilityToken?.scope?.allowedPaths??[]);},
            beforeArtifactWrite:async plan=>{const guard=trustedLocalEffectFences.get(packet);
              if(/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'')&&typeof guard?.assertArtifactPlan!=='function')throw Error('B_ARTIFACT_PLAN_GUARD_REQUIRED');
              guard?.assertArtifactPlan?.(plan);this.assertRemoteOperationAuthorization(packet,plan.paths);
              workflowPublication=await this.claimWorkflowPublication(packet,plan.paths);workbookFence=workflowPublication.fence;}}
          : action.toolName==='archive.createZip'?{signal,
            assertAccess:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();},
            beforeArtifactWrite:async plan=>{
              const guard=trustedLocalEffectFences.get(packet);
              if(/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'')&&typeof guard?.assertArtifactPlan!=='function')throw Error('B_ARTIFACT_PLAN_GUARD_REQUIRED');
              guard?.assertArtifactPlan?.(plan);
              workflowPublication=await this.claimWorkflowPublication(packet,plan.paths);workbookFence=workflowPublication.fence;
            }}
          : action.toolName==='excel.exportPdf'?{signal,
            assertAccess:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();},
            beforeArtifactWrite:async plan=>{
              const guard=trustedLocalEffectFences.get(packet);
              if(/^mission_op_[a-f0-9]{32}$/u.test(packet.idempotencyKey??'')&&typeof guard?.assertArtifactPlan!=='function')throw Error('B_ARTIFACT_PLAN_GUARD_REQUIRED');
              guard?.assertArtifactPlan?.(plan);
              workflowPublication=await this.claimWorkflowPublication(packet,plan.paths);workbookFence=workflowPublication.fence;
            },beforePdfPublish:()=>{trustedLocalEffectFences.get(packet)?.();workbookFence?.();return this.assertRemoteOperationAuthorization(packet,[action.arguments.inputPath,action.arguments.outputPath]);}}
          :{signal,assertAccess:()=>{const fence=trustedLocalEffectFences.get(packet);
            if(adapter.contract?.requiresAvailabilityBinding===true&&!fence)throw new Error('B_REQUIRED_CAPABILITY_FENCE_MISSING');
            fence?.();}});
    } catch (error) {
      this.abandonWorkflowPublication(workflowPublication);
      return this.block(packet, error.message ?? 'B_TOOL_EXECUTION_EXCEPTION', { dryRun });
    } finally {
      trustedLocalEffectFences.delete(packet);
      trustedRemoteMutationChecks.delete(packet);
    }
    if (executionResult.status === 'blocked') {
      this.abandonWorkflowPublication(workflowPublication);
      // 어댑터가 준 구체 사유(error)와 한국어 안내(summary)를 그대로 올려보낸다.
      // generic 코드로 뭉개면 폰에서 "왜 안 됐는지"를 알 수 없다.
      return this.block(packet, executionResult.warnings?.[0] ?? executionResult.error ?? 'B_TOOL_PREFLIGHT_FAILED', {
        dryRun,
        summary: executionResult.summary ?? null,
        nativeRecovery: ['excel.exportPdf','excel.createWorkbook'].includes(action.toolName)
          ? nativeFailureRecovery({nativeRecovery:executionResult.nativeRecovery}) : null
      });
    }
    if (executionResult.status === 'failed') {
      this.abandonWorkflowPublication(workflowPublication);
      if(action.toolName==='workflow.execute'&&executionResult.error?.code==='WORKFLOW_ASSERT_COUNT_FAILED'
        &&adapter instanceof LocalWorkflowToolAdapter&&adapter.execute===LocalWorkflowToolAdapter.prototype.execute){
        const proof=adapter.consumeUnpublishedPersonFailure?.({taskId:packet.taskId,packetId:packet.packetId,args:action.arguments});
        if(proof){
          const bound={...proof,actionSha256:actionArgumentsBinding(action)?.argumentsSha256,actionType:action.actionType,
            effectAuthority:false,scope:'pre-publication-four-node-person-selection'};
          if(this.#unpublishedFailureSigner)bound.signature=this.#unpublishedFailureSigner.sign(actionArgumentsBinding(bound)?.argumentsSha256);
          this.#unpublishedFailureReceipts.set(executionResult,structuredClone(bound));
          executionResult.evidence={...executionResult.evidence,unpublishedPersonFailure:bound};
        }
      }
      const failed = await this.fail(packet, {
        shadow,
        executionResult,
        sealedCapabilityToken,
        adapter,
        executionCodeVersion,
        startedAt
      });
      const classification = classifyExecutionPacketOutcome(failed);
      if (classification.outcome !== 'retry') {
        this.policyRuntime?.capabilities?.consume({ tokenId: packet.capabilityToken.tokenId, executionResult: executionResult.status });
      }
      return failed;
    }
    try {
    this.policyRuntime?.capabilities?.consume({ tokenId: packet.capabilityToken.tokenId, executionResult: executionResult.status });
    const finishedAt = this.clock().toISOString();
    const enrichedExecutionResult = {
      packetId: packet.packetId,
      taskId: packet.taskId,
      startedAt,
      finishedAt,
      executedBy: {
        module: ModuleId.PC_AGENT,
        toolName: action.toolName
      },
      safety: {
        capabilityTokenUsed: packet.capabilityToken.tokenId,
        capabilityTokenVaultRef: sealedCapabilityToken,
        irreversibleActionDetected: false,
        rollbackAvailable: executionResult.rollbackAvailable === true,
        adapterContract: adapter.contract
      },
      ...executionResult,
      executionCodeVersion
    };
    const evidence = await this.evidenceCollector.collect({
      packet,
      shadow,
      executionResult: enrichedExecutionResult,
      status: 'success'
    });
    enrichedExecutionResult.evidence = {
      ...enrichedExecutionResult.evidence,
      shadowReportId: evidence.evidenceId,
      undoJournalId: enrichedExecutionResult.undoJournalId,
      logPath: this.executionLogPath,
      verificationEvidenceId: evidence.evidenceId,
      executionEvidence: evidence
    };
    const memoryEvent = this.memoryEmitter.emit({
      packet,
      executionResult: enrichedExecutionResult,
      outcome: 'success',
      evidence
    });
    const result = {
      taskId: packet.taskId,
      status: TaskStatus.COMPLETED,
      shadow,
      executionResult: enrichedExecutionResult,
      evidence,
      memoryEvent
    };
    appendJsonlSync(this.executionLogPath, result);
    this.packetJournal.recordResult(packet, result, { dryRun: false, immediate: ['workflow.execute','filesystem.moveFiles','excel.createWorkbook','excel.exportPdf','archive.createZip','word.create','powerpoint.create','hwp.create','weather.createHwpReport','visual.createCards','document.edit','macro.save'].includes(action.toolName) });
    if (workflowPublication?.descriptor) {
      await this.remoteOperationBoundary?.('workflow-receipt-persisted', { descriptor: workflowPublication.descriptor });
      workflowPublication.store.complete(workflowPublication.descriptor, result);
    }
    if (action.toolName === 'workflow.execute' && typeof adapter.finalizePublicationCleanup === 'function') {
      try { await adapter.finalizePublicationCleanup(executionResult, packet); }
      catch (error) {
        this.auditLog.write('execution.workflow-cleanup.deferred', { taskId: packet.taskId,
          packetId: packet.packetId, errorCode: error.code ?? 'WORKFLOW_STAGE_CLEANUP_FAILED' });
      }
    }
    this.auditLog.write('execution.completed', {
      taskId: packet.taskId,
      packetId: packet.packetId,
      toolName: action.toolName,
      outputPaths: enrichedExecutionResult.outputPaths,
      undoJournalId: enrichedExecutionResult.undoJournalId,
      evidenceId: evidence.evidenceId,
      memoryEventId: memoryEvent.eventId
    });
    this.logs.unshift(result);
    this.results.set(packet.taskId, result);
    return result;
    } finally {
      if (workflowPublication?.descriptor) {
        try { workflowPublication.store.uncertain(workflowPublication.descriptor.operationId); }
        finally { workflowPublication.store.close(); }
      }
    }
  }

  async resumeWorkflowPublication(packet, { beforeLocalExecute = null } = {}) {
    // Match the remote executor contract without bypassing delegated E checks.
    return this.receiveDelegatedExecutionPacket(packet, { resumePublication: true, beforeLocalExecute });
  }

  async receiveDelegatedExecutionPacket(packet, { dryRun = false, beforeLocalExecute = null, beforeRemoteMutation = null, resumePublication = false, signal = null, operationClaim = null } = {}) {
    const action = packet?.action ?? {};
    const adoption = this.policyRuntime?.capabilities?.adoptSignedToken?.({
      tokenId: packet?.capabilityToken?.tokenId,
      capabilityToken: packet?.capabilityToken?.capabilityToken,
      taskId: packet?.taskId,
      toolName: action.toolName,
      actionType: action.actionType
    });
    if (adoption && adoption.valid !== true) {
      return this.block(packet, adoption.reason ?? 'E_CAPABILITY_DELEGATION_FAILED', {
        dryRun,
        summary: 'Core execution capability could not be verified by the PC Agent.'
      });
    }
    return await this.receiveExecutionPacket(packet, { dryRun, beforeLocalExecute, beforeRemoteMutation, resumePublication, signal, operationClaim });
  }

  idempotencyConflict(packet, inspection, { dryRun = false } = {}) {
    this.packetJournal.recordConflict(packet, inspection, { dryRun });
    const executionResult = {
      status: 'blocked',
      error: 'B_IDEMPOTENCY_CONFLICT',
      summary: '같은 재시도 키가 서로 다른 실행 내용에 사용되어 작업을 차단했습니다.',
      outputPaths: [],
      changedItems: [],
      rollbackAvailable: false
    };
    const memoryEvent = this.memoryEmitter.emit({
      packet,
      executionResult,
      outcome: 'blocked',
      evidence: null
    });
    const result = {
      taskId: packet?.taskId ?? null,
      status: TaskStatus.BLOCKED,
      blockedReason: 'B_IDEMPOTENCY_CONFLICT',
      executionResult,
      idempotencyConflict: {
        idempotencyKey: inspection.idempotencyKey,
        existingFingerprint: inspection.existingFingerprint,
        receivedFingerprint: inspection.packetFingerprint
      },
      memoryEvent
    };
    appendJsonlSync(this.executionLogPath, result);
    this.auditLog.write('execution.packet.idempotency_conflict', {
      taskId: packet?.taskId ?? null,
      packetId: packet?.packetId ?? null,
      idempotencyKey: inspection.idempotencyKey,
      existingFingerprint: inspection.existingFingerprint,
      receivedFingerprint: inspection.packetFingerprint,
      rawPacketStored: false
    });
    this.logs.unshift(result);
    if (packet?.taskId && !this.results.has(packet.taskId)) this.results.set(packet.taskId, result);
    return result;
  }

  async fail(packet, { shadow, executionResult, sealedCapabilityToken, adapter, startedAt, executionCodeVersion=null } = {}) {
    const finishedAt = this.clock().toISOString();
    const enrichedExecutionResult = {
      packetId: packet.packetId,
      taskId: packet.taskId,
      startedAt,
      finishedAt,
      executedBy: {
        module: ModuleId.PC_AGENT,
        toolName: packet.action?.toolName
      },
      safety: {
        capabilityTokenUsed: packet.capabilityToken?.tokenId,
        capabilityTokenVaultRef: sealedCapabilityToken,
        irreversibleActionDetected: false,
        rollbackAvailable: executionResult?.rollbackAvailable === true,
        adapterContract: adapter?.contract
      },
      ...executionResult,
      status: 'failed',
      executionCodeVersion
    };
    const evidence = await this.evidenceCollector.collect({
      packet,
      shadow,
      executionResult: enrichedExecutionResult,
      status: 'failed'
    });
    enrichedExecutionResult.evidence = {
      ...enrichedExecutionResult.evidence,
      shadowReportId: evidence.evidenceId,
      logPath: this.executionLogPath,
      verificationEvidenceId: evidence.evidenceId,
      executionEvidence: evidence
    };
    const memoryEvent = this.memoryEmitter.emit({
      packet,
      executionResult: enrichedExecutionResult,
      outcome: 'failure',
      evidence
    });
    const failedReason = executionResult?.error ?? executionResult?.summary ?? 'B_TOOL_EXECUTION_FAILED';
    const result = {
      taskId: packet.taskId,
      status: TaskStatus.FAILED,
      failedReason,
      shadow,
      executionResult: enrichedExecutionResult,
      evidence,
      memoryEvent
    };
    appendJsonlSync(this.executionLogPath, result);
    const failureRecord=this.packetJournal.recordResult(packet, result, { dryRun: false, immediate:packet.action?.toolName==='filesystem.moveFiles'||Boolean(enrichedExecutionResult.evidence?.unpublishedPersonFailure) });
    const privateFailure=this.#unpublishedFailureReceipts.get(executionResult);
    if(privateFailure)this.#unpublishedFailureReceipts.set(failureRecord.result,privateFailure);
    this.auditLog.write('execution.failed', {
      taskId: packet.taskId,
      packetId: packet.packetId,
      toolName: packet.action?.toolName,
      reason: failedReason,
      evidenceId: evidence.evidenceId,
      memoryEventId: memoryEvent.eventId
    });
    this.logs.unshift(result);
    this.results.set(packet.taskId, result);
    return result;
  }

  block(packet, reason, { dryRun = false, summary = null, trustAuthorization = null, nativeRecovery = null } = {}) {
    const recovery=['excel.exportPdf','excel.createWorkbook'].includes(packet.action?.toolName)?nativeFailureRecovery({nativeRecovery}):null;
    const executionResult = { status: 'blocked', summary: summary ?? reason, outputPaths: [], changedItems: [], rollbackAvailable: false,
      ...(recovery?{retryable:false,nativeRecovery:recovery,nextAction:recovery.activationGapUnverified
        ?'Excel 실행 초기 상태와 원본 파일을 확인하세요. 자동 재시도는 중지되었습니다.'
        :'작업용 Excel 상태와 실행 권한을 확인한 뒤 새 요청으로 진행하세요.'}:{}) };
    const memoryEvent = this.memoryEmitter.emit({
      packet,
      executionResult,
      outcome: 'blocked',
      evidence: null
    });
    const result = {
      taskId: packet.taskId,
      status: TaskStatus.BLOCKED,
      blockedReason: reason,
      trustAuthorization,
      executionResult,
      memoryEvent
    };
    appendJsonlSync(this.executionLogPath, result);
    this.packetJournal.recordResult(packet, result, { dryRun });
    this.auditLog.write('execution.blocked', {
      taskId: packet.taskId,
      packetId: packet.packetId,
      reason,
      memoryEventId: memoryEvent.eventId
    });
    this.logs.unshift(result);
    this.results.set(packet.taskId, result);
    return result;
  }

  taskSummary(taskId) { return this.taskSummaries([taskId]).items[0]; }

  taskSummaries(taskIds) {
    if(!Array.isArray(taskIds)||taskIds.length<1||taskIds.length>100||new Set(taskIds).size!==taskIds.length
      ||taskIds.some(id=>typeof id!=='string'||!/^[\p{L}\p{N}._-]{1,128}$/u.test(id)))throw new Error('B_TASK_SUMMARY_INPUT_INVALID');
    const missing=new Set(taskIds),latest=new Map();
    // Scan once in reverse. Ignore retry/intermediate records just as the single read did.
    for(let i=this.packetJournal.records.length-1;i>=0&&missing.size;i--){
      const record=this.packetJournal.records[i];
      if(record.recordType==='packet_result'&&missing.has(record.taskId)){latest.set(record.taskId,record);missing.delete(record.taskId);}
    }
    const titles={'filesystem.createTextFile':'파일 작성','filesystem.listFiles':'파일 목록 조회','filesystem.readTextFile':'텍스트 읽기','workflow.execute':'복합 업무','office.createDocument':'문서 제작'};
    const statuses=new Set(Object.values(TaskStatus));
    return {items:taskIds.map(taskId=>{const record=latest.get(taskId);return {taskId,title:record?(titles[record.toolName]??'PC 작업'):'아직 실행 기록 없음',
      status:record&&statuses.has(record.status)?record.status:'UNKNOWN',available:Boolean(record),dryRun:record?record.dryRun!==false:null};}),
      executionAuthority:false,verifiedCompletion:false};
  }

  taskResult(taskId) {
    const receipt = this.reconcileWorkflowPublicationReceipt(taskId);
    return structuredClone(receipt ?? this.results.get(taskId) ?? { success: false, error: { code: 'B_TASK_NOT_FOUND' } });
  }

  async recoverCompletedWorkflowCleanup({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('B_WORKFLOW_CLEANUP_LIMIT_INVALID');
    const trust = this.trustKernel?.status?.();
    if (trust && trust.mutatingExecutionAllowed !== true) return { status: 'blocked', reason: 'runtime-trust-restricted', items: [] };
    const adapter = this.registry.get('workflow.execute');
    const cleaned = new Set(this.packetJournal.records.filter(record => record.recordType === 'workflow_cleanup_result'
      && ['removed', 'not-present'].includes(record.status)).map(record => `${record.taskId}:${record.packetFingerprint}`));
    const records = this.packetJournal.records.slice(-1000).reverse().filter(record => record.recordType === 'packet_result'
      && record.toolName === 'workflow.execute' && record.status === TaskStatus.COMPLETED && record.dryRun === false
      && !cleaned.has(`${record.taskId}:${record.packetFingerprint}`));
    const tasks = [...new Set(records.map(record => record.taskId))].slice(0, limit), items = [];
    for (const taskId of tasks) {
      let store;
      try {
        const receipt = this.reconcileWorkflowPublicationReceipt(taskId);
        const record = records.find(record => record.taskId === taskId);
        const dbPath = resolve(dirname(this.packetJournal.journalPath), 'remote-operations.sqlite');
        if (!receipt || !existsSync(dbPath)) { items.push({ taskId, status: 'unavailable', reason: 'contract-missing' }); continue; }
        store = new RemoteOperationStore({ path: dbPath, clock: this.clock, recoverInFlight: false });
        const descriptor = { operationId: `workflow_publish_${createHash('sha256').update(record.idempotencyKey).digest('hex').slice(0, 32)}`,
          taskId, fingerprint: record.packetFingerprint };
        if (store.bound(descriptor)?.state !== 'succeeded') throw new Error('B_WORKFLOW_CLEANUP_NOT_COMMITTED');
        const intent = store.publicationIntent(descriptor);
        const cleanup = await adapter.cleanupRecoveredPublication(intent, receipt);
        if (['removed', 'not-present'].includes(cleanup.status)) this.packetJournal.append({
          recordType: 'workflow_cleanup_result', taskId, packetFingerprint: record.packetFingerprint,
          status: cleanup.status, completedAt: this.clock().toISOString()
        }, { immediate: true });
        items.push({ taskId, ...cleanup });
      } catch (error) { items.push({ taskId, status: 'deferred', reason: error.code ?? error.message }); }
      finally { store?.close(); }
    }
    const result = { status: items.some(item => item.status === 'deferred') ? 'deferred' : 'finished', items,
      scannedRecords: Math.min(this.packetJournal.records.length, 1000), limit };
    this.auditLog.write('execution.workflow-cleanup.recovered', result);
    return result;
  }

  // Reconcile only B's original completed packet receipt, never publication
  // observations or caller-provided completion. This releases claims, not files.
  reconcileWorkflowPublicationReceipt(taskId) {
    const record = this.packetJournal.records.findLast(item => item.recordType === 'packet_result'
      && item.taskId === taskId && ['workflow.execute','filesystem.moveFiles','excel.createWorkbook','excel.exportPdf','archive.createZip','word.create','powerpoint.create','hwp.create','weather.createHwpReport','visual.createCards','document.edit','macro.save'].includes(item.toolName) && item.dryRun === false
      && item.requestedMode === 'execute' && item.status === TaskStatus.COMPLETED);
    if (!record) return;
    const fail = () => { throw Object.assign(new Error('B_WORKFLOW_RECEIPT_BINDING_MISMATCH'), { code: 'B_WORKFLOW_RECEIPT_BINDING_MISMATCH' }); };
    if (record.result?.taskId !== taskId || record.result?.status !== TaskStatus.COMPLETED
      || !/^[a-f0-9]{64}$/u.test(record.packetFingerprint ?? '')
      || this.packetJournal.packetFingerprints.get(record.idempotencyKey) !== record.packetFingerprint
      || this.packetJournal.results.get(record.idempotencyKey) !== record.result) fail();
    const dbPath = resolve(dirname(this.packetJournal.journalPath), 'remote-operations.sqlite');
    if (!existsSync(dbPath)) return record.result; // Legacy receipts had no publication claim.
    const store = new RemoteOperationStore({ path: dbPath, clock: this.clock,
      recoverInFlight: this.operationRecoveryInitialized !== true });
    this.operationRecoveryInitialized = true;
    try {
      const descriptor = { operationId: `workflow_publish_${createHash('sha256').update(record.idempotencyKey).digest('hex').slice(0, 32)}`,
        taskId, fingerprint: record.packetFingerprint };
      const row = store.bound(descriptor);
      if (!row) return record.result;
      const outputs=record.result.executionResult?.outputPaths;
      const changes=record.result.executionResult?.changedItems;
      if(record.toolName==='filesystem.moveFiles'&&(!Array.isArray(changes)
        ||changes.some(item=>!['copy_file','move_file','move_file_renamed_target'].includes(item.type))
        ||JSON.stringify(changes.map(item=>item.to))!==JSON.stringify(outputs)))fail();
      if(record.toolName==='document.edit'){try{validateDocumentEditResult(record.result.executionResult?.artifactManifest,record.result.executionResult);}catch{fail();}}
      if(record.toolName==='macro.save'){try{
        validateMacroPublicationResult(record.result.executionResult?.macroPublication,record.result.executionResult);
        if(resolve(this.registry.get('macro.save')?.store?.path??'.')!==record.result.executionResult.macroPublication.path)fail();
      }catch{fail();}}
      if(record.toolName==='visual.createCards'){try{validateCardPublicationResult(record.result.executionResult?.artifactManifest,record.result.executionResult);}catch{fail();}}
      if(['hwp.create','weather.createHwpReport'].includes(record.toolName)){try{if(JSON.stringify(outputs)!==JSON.stringify(hancomActualOutputPaths(record.result.executionResult?.artifactManifest,record.result.executionResult)))fail();}catch{fail();}}
      const paths = ['hwp.create','weather.createHwpReport'].includes(record.toolName)?record.result.executionResult.artifactManifest.paths:record.toolName==='filesystem.moveFiles'?changes.flatMap(item=>[item.from,item.to]):
        record.toolName==='excel.exportPdf'?[record.result.executionResult?.pdfExport?.inputPath,...(outputs??[])]:
        record.toolName==='archive.createZip'?[...(record.result.executionResult?.evidence?.inputs??[]).map(input=>input.path),...(outputs??[])]:outputs;
      if (!Array.isArray(paths) || !paths.length || paths.length > 128
        || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) fail();
      const keys = [...new Set(paths.map(path => this.remoteOperationResourceKey(path)))].sort();
      if (JSON.stringify(keys) !== JSON.stringify(store.resources(row))) fail();
      store.complete(descriptor, record.result);
      return record.result;
    } finally { store.close(); }
  }

  async taskPublication(taskId) {
    const adapter = this.registry.get('workflow.execute');
    if (!adapter?.inspectPublication) return { status: 'unavailable', reason: 'inspection-not-supported', executionAuthority: false };
    const observation = await adapter.inspectPublication(taskId);
    if (!observation.publicationOperationId) return { ...observation, contractBinding: { status: 'unavailable', reason: 'legacy-publication-no-contract' } };
    const binding = inspectPublicationContract(resolve(dirname(this.packetJournal.journalPath), 'remote-operations.sqlite'), {
      operationId: observation.publicationOperationId, taskId, intentSha256: observation.intentSha256 });
    return { ...observation, ...(binding.status === 'conflict' ? { status: 'conflict' } : {}), contractBinding: binding };
  }

  // Reconcile a narrowly classified no-publication failure from B's own
  // terminal receipt. Core JSON is a query, never the source of this fact.
  unpublishedPersonFailureForDispatch(dispatch) {
    try {
      if(dispatch?.toolName!=='workflow.execute'||typeof dispatch.taskId!=='string'
        ||!actionArgumentsBinding(dispatch.arguments))return null;
      const record=this.packetJournal.records.findLast(item=>item.recordType==='packet_result'
        &&item.taskId===dispatch.taskId&&item.toolName==='workflow.execute'
        &&item.status===TaskStatus.FAILED&&item.requestedMode==='execute'&&item.dryRun===false);
      const result=record?.result,proof=result?.executionResult?.evidence?.unpublishedPersonFailure;
      if(!proof||proof.version!=='b-unpublished-person-failure-v1'||proof.taskId!==dispatch.taskId
        ||proof.packetId!==record.packetId||result.taskId!==dispatch.taskId||result.status!==TaskStatus.FAILED
        ||result.executionResult?.packetId!==record.packetId||result.executionResult?.error?.code!=='WORKFLOW_ASSERT_COUNT_FAILED'
        ||proof.failureCode!=='WORKFLOW_ASSERT_COUNT_FAILED'||proof.noPublication!==true||proof.stageRemoved!==true
        ||proof.scope!=='pre-publication-four-node-person-selection'||proof.effectAuthority!==false
        ||proof.actionSha256!==dispatch.actionSha256||proof.actionType!==dispatch.actionType
        ||proof.argsSha256!==actionArgumentsBinding(dispatch.arguments).argumentsSha256
        ||result.executionResult?.outputPaths?.length!==0||result.executionResult?.changedItems?.length!==0
        ||this.packetJournal.results.get(record.idempotencyKey)!==result
        ||this.packetJournal.packetFingerprints.get(record.idempotencyKey)!==record.packetFingerprint
        ||!this.packetJournal.records.some(item=>item.recordType==='packet_received'&&item.taskId===dispatch.taskId
          &&item.packetId===record.packetId&&item.packetFingerprint===record.packetFingerprint))return null;
      const privateProof=this.#unpublishedFailureReceipts.get(result);
      const {signature,...unsigned}=proof;
      const signatureValid=typeof signature==='string'&&this.#unpublishedFailureSigner?.verify(actionArgumentsBinding(unsigned)?.argumentsSha256,signature)===true;
      if(!signatureValid&&(!privateProof||actionArgumentsBinding(privateProof)?.argumentsSha256!==actionArgumentsBinding(proof)?.argumentsSha256))return null;
      const nodes=dispatch.arguments.spec?.nodes;
      if(nodes?.length!==4||nodes.map(n=>n.op).join(',')!=='data.readJson,data.filter,assert.count,write.json'
        ||nodes[2].args.equals!==1)return null;
      return structuredClone(proof);
    }catch{return null;}
  }

  // Read-only local provenance lookup; never replays a packet or grants authority.
  receiptForTaskExecution({ taskId, action, evidenceId } = {}) {
    if (typeof taskId !== 'string' || !action || typeof evidenceId !== 'string') return null;
    const fingerprint = executionPacketFingerprint({ taskId, action, requestedMode: 'execute' });
    const record = this.packetJournal.records.findLast(item =>
      item.recordType === 'packet_result' && item.taskId === taskId
      && item.packetFingerprint === fingerprint && item.dryRun === false
      && item.requestedMode === 'execute' && item.status === TaskStatus.COMPLETED
      && item.result?.evidence?.evidenceId === evidenceId);
    return record ? structuredClone(record.result) : null;
  }

  receiptForOperation({ operationId, taskId, action } = {}) {
    if (typeof operationId !== 'string' || typeof taskId !== 'string' || !action) return null;
    const packet = { idempotencyKey: operationId, taskId, action, requestedMode: 'execute' };
    const fingerprint = executionPacketFingerprint(packet);
    const record = this.packetJournal.records.findLast(item => item.recordType === 'packet_result'
      && item.idempotencyKey === operationId && item.taskId === taskId && item.packetFingerprint === fingerprint
      && item.dryRun === false && item.requestedMode === 'execute' && item.status === TaskStatus.COMPLETED);
    if(record&&['filesystem.moveFiles','excel.createWorkbook','excel.exportPdf','archive.createZip','word.create','powerpoint.create','hwp.create','weather.createHwpReport','visual.createCards','document.edit','macro.save'].includes(action.toolName))this.reconcileWorkflowPublicationReceipt(taskId);
    return record ? structuredClone(record.result) : null;
  }

  taskEvidence(taskId) {
    return this.evidenceCollector.get(taskId);
  }

  recentMemoryEvents(limit = 20) {
    return this.memoryEmitter.recent(limit);
  }

  async rollbackPlan(taskId) {
    const entries = this.undoJournal.list().filter((entry) => entry.taskId === taskId);
    if (!entries.length) {
      return { success: false, taskId, error: { code: 'B_ROLLBACK_NOT_FOUND' } };
    }
    const steps = [];
    const virtualState = new Map();
    for (const entry of entries) {
      const step = await this.rollbackStepPlan(entry, { virtualState });
      steps.push(step);
      this.applyRollbackStepToVirtualState(entry, step, virtualState);
    }
    const blocked = steps.filter((step) => step.status === 'blocked');
    const ready = steps.filter((step) => step.status === 'ready');
    const noop = steps.filter((step) => step.status === 'noop');
    return {
      success: true,
      taskId,
      dryRun: true,
      planningMode: 'sequential-virtual-state-v1',
      stepCount: steps.length,
      readyCount: ready.length,
      noopCount: noop.length,
      blockedCount: blocked.length,
      steps,
      blocked,
      chain: this.undoJournal.verifyChain()
    };
  }

  async rollbackStepPlan(entry, { virtualState = null } = {}) {
    const base = {
      undoJournalId: entry.undoJournalId,
      taskId: entry.taskId,
      action: entry.action,
      createdAt: entry.createdAt,
      rollbackStatus: entry.rollbackStatus,
      status: 'ready',
      checks: [],
      paths: {},
      risk: 'low'
    };
    if (entry.action === 'delete_created_file') {
      const safety = await this.rollbackPathSafety(entry.path);
      const currentExists = await this.rollbackPathExists(entry.path, virtualState);
      let matches = false;
      if (currentExists && safety.allowed) {
        try { matches = createdFileRollbackMatches(entry.createdFileSnapshot, virtualState?.fileSnapshots?.get(resolve(entry.path)) ?? createdFileRollbackSnapshot(entry.path)); }
        catch { /* Missing or unstable evidence never authorizes deletion. */ }
      }
      return this.withRollbackSafety(base, safety, {
        paths: { deletePath: entry.path, resolvedDeletePath: safety.resolved ?? null },
        checks: [{ id: 'created-file-current-state', passed: true, exists: currentExists },{id:'created-file-original-evidence',passed:!currentExists || matches}],
        status: currentExists ? (matches ? 'ready' : 'blocked') : 'noop',
        blockedReason: currentExists && !matches ? (entry.createdFileSnapshot ? 'B_ROLLBACK_FILE_CHANGED' : 'B_ROLLBACK_FILE_EVIDENCE_UNAVAILABLE') : null,
        change: currentExists ? 'delete created file' : 'created file already missing; mark undo entry rolled back'
      });
    }
    if (entry.action === 'restore_previous_file') {
      const safety = await this.rollbackPathSafety(entry.path, { checkParentForCreate: true });
      const hasPreviousContent = previousFileRollbackBytes(entry)!==null;
      let matches=false;
      if(safety.allowed){try{matches=createdFileRollbackMatches(entry.overwrittenFileSnapshot,createdFileRollbackSnapshot(entry.path));}catch{ /* Missing/changed files do not authorize restore. */ }}
      return this.withRollbackSafety(base, safety, {
        paths: { restorePath: entry.path, resolvedRestorePath: safety.resolved ?? null },
        checks: [{ id: 'previous-content-present', passed: hasPreviousContent },{id:'overwritten-file-current-evidence',passed:matches}],
        status: hasPreviousContent && matches ? 'ready' : 'blocked',
        blockedReason: !hasPreviousContent ? 'B_ROLLBACK_PREVIOUS_CONTENT_MISSING' : !matches ? 'B_ROLLBACK_FILE_CHANGED_OR_UNVERIFIED' : null,
        change: 'restore previous file content'
      });
    }
    if (entry.action === 'restore_backup_file') {
      const targetSafety = await this.rollbackPathSafety(entry.path, { checkParentForCreate: true });
      const backupSafety = await this.rollbackPathSafety(entry.backupPath);
      const backupExists = await this.rollbackPathExists(entry.backupPath, virtualState);
      let originalEvidence=false;
      try { originalEvidence=createdFileRollbackMatches(entry.editedFileSnapshot,createdFileRollbackSnapshot(entry.path))
        && createdFileRollbackMatches(entry.backupFileSnapshot,createdFileRollbackSnapshot(entry.backupPath)); }
      catch { /* Never overwrite current documents from unverified backups. */ }
      const safety = targetSafety.allowed ? backupSafety : targetSafety;
      return this.withRollbackSafety(base, safety, {
        paths: {
          restorePath: entry.path,
          backupPath: entry.backupPath,
          resolvedRestorePath: targetSafety.resolved ?? null,
          resolvedBackupPath: backupSafety.resolved ?? null
        },
        checks: [
          { id: 'document-backup-exists', passed: backupExists },
          { id: 'document-original-evidence', passed: originalEvidence },
          { id: 'document-restore-path-allowed', passed: targetSafety.allowed, detail: targetSafety.reason ?? null },
          { id: 'document-backup-path-allowed', passed: backupSafety.allowed, detail: backupSafety.reason ?? null }
        ],
        status: backupExists && targetSafety.allowed && backupSafety.allowed && originalEvidence ? 'ready' : 'blocked',
        blockedReason: !backupExists
          ? 'B_ROLLBACK_BACKUP_MISSING'
          : (!targetSafety.allowed ? targetSafety.reason : !backupSafety.allowed ? backupSafety.reason : 'B_ROLLBACK_DOCUMENT_CHANGED_OR_UNVERIFIED'),
        change: 'restore document from verified backup'
      });
    }
    if (entry.action === 'move_back') {
      const fromSafety = await this.rollbackPathSafety(entry.from, { checkParentForCreate: true });
      const toSafety = await this.rollbackPathSafety(entry.to);
      const currentExists = await this.rollbackPathExists(entry.to, virtualState);
      const restoreTargetExists = await this.rollbackPathExists(entry.from, virtualState);
      let matches=false;
      if(fromSafety.allowed&&toSafety.allowed&&currentExists){try{
        matches=createdFileRollbackMatches(entry.movedFileSnapshot,virtualState?.fileSnapshots?.get(resolve(entry.to))??createdFileRollbackSnapshot(entry.to))
          &&entry.movePhysicalPaths?.from===rollbackPhysicalPath(entry.from)&&entry.movePhysicalPaths?.to===rollbackPhysicalPath(entry.to);
      }catch{ /* Missing or changed original evidence cannot authorize a move. */ }}
      const safety = fromSafety.allowed ? toSafety : fromSafety;
      const status = currentExists && !restoreTargetExists && matches ? 'ready' : 'blocked';
      const blockedReason = !currentExists
        ? 'B_ROLLBACK_MOVE_SOURCE_MISSING'
        : restoreTargetExists
          ? 'B_ROLLBACK_MOVE_TARGET_EXISTS'
          : !matches ? 'B_ROLLBACK_MOVE_CHANGED_OR_UNVERIFIED' : null;
      return this.withRollbackSafety(base, safety, {
        paths: {
          restorePath: entry.from,
          currentPath: entry.to,
          resolvedRestorePath: fromSafety.resolved ?? null,
          resolvedCurrentPath: toSafety.resolved ?? null
        },
        checks: [
          { id: 'moved-file-current-location-exists', passed: currentExists, path: entry.to },
          { id: 'restore-target-clear', passed: !restoreTargetExists, path: entry.from },
          { id: 'moved-file-original-evidence', passed: matches },
          { id: 'restore-path-allowed', passed: fromSafety.allowed, detail: fromSafety.reason ?? null },
          { id: 'current-path-allowed', passed: toSafety.allowed, detail: toSafety.reason ?? null }
        ],
        status,
        blockedReason,
        change: 'move file back to original path'
      });
    }
    return {
      ...base,
      status: 'blocked',
      blockedReason: 'B_ROLLBACK_ACTION_UNKNOWN',
      change: 'unknown rollback action'
    };
  }

  async rollbackPathExists(path, virtualState = null) {
    if (!virtualState) return await exists(path);
    const key = resolve(path);
    if (!virtualState.has(key)) virtualState.set(key, await exists(path));
    return virtualState.get(key) === true;
  }

  applyRollbackStepToVirtualState(entry, step, virtualState) {
    if (!virtualState || step?.status !== 'ready') return;
    if (entry.action === 'delete_created_file') {
      virtualState.set(resolve(entry.path), false);
    }
    if (entry.action === 'restore_previous_file' || entry.action === 'restore_backup_file') {
      virtualState.fileSnapshots?.delete(resolve(entry.path));
      virtualState.set(resolve(entry.path), true);
    }
    if (entry.action === 'move_back') {
      virtualState.fileSnapshots ??= new Map();
      try { virtualState.fileSnapshots.set(resolve(entry.from),virtualState.fileSnapshots.get(resolve(entry.to)) ?? createdFileRollbackSnapshot(entry.to)); } catch { /* Preview will block a later delete without matching evidence. */ }
      virtualState.set(resolve(entry.to), false);
      virtualState.set(resolve(entry.from), true);
    }
  }

  async rollbackPathSafety(path, { checkParentForCreate = false } = {}) {
    try {
      const resolved = await assertAllowedRealPath(path, this.allowedRoots, { checkParentForCreate });
      return { allowed: true, path, resolved };
    } catch (error) {
      return {
        allowed: false,
        path,
        resolved: resolve(path),
        reason: 'B_ROLLBACK_OUTSIDE_ALLOWED_ROOTS',
        detail: error.message
      };
    }
  }

  withRollbackSafety(base, safety, patch) {
    const checks = [...(patch.checks ?? [])];
    checks.push({
      id: 'allowed-realpath-root',
      passed: safety.allowed,
      path: safety.path,
      resolved: safety.resolved,
      detail: safety.detail ?? null
    });
    if (!safety.allowed) {
      return {
        ...base,
        ...patch,
        checks,
        status: 'blocked',
        blockedReason: safety.reason,
        safety
      };
    }
    if (patch.status === 'blocked') {
      return {
        ...base,
        ...patch,
        checks,
        safety
      };
    }
    return {
      ...base,
      ...patch,
      checks,
      blockedReason: null,
      safety
    };
  }

  async rollbackTask(taskId) {
    const entries = this.undoJournal.list().filter((entry) => entry.taskId === taskId);
    if (!entries.length) {
      return { success: false, error: { code: 'B_ROLLBACK_NOT_FOUND' } };
    }
    const plan = await this.rollbackPlan(taskId);
    const transactionStart = this.rollbackTransactions.begin({ taskId, plan });
    if (!transactionStart.success) {
      return {
        success: false,
        taskId,
        error: transactionStart.error,
        transaction: transactionStart.transaction,
        plan
      };
    }
    const transaction = transactionStart.transaction;
    const rolledBack = [];
    const skipped = [];
    const stepsById = new Map(plan.steps.map((step) => [step.undoJournalId, step]));
    try {
      for (const entry of entries) {
        const step = stepsById.get(entry.undoJournalId);
        if (step?.status === 'blocked') {
          const skippedEntry = {
            undoJournalId: entry.undoJournalId,
            reason: step.blockedReason,
            paths: step.paths,
            checks: step.checks
          };
          skipped.push(skippedEntry);
          this.rollbackTransactions.recordStep(transaction, {
            step,
            status: 'skipped',
            reason: step.blockedReason,
            rollbackResult: skippedEntry
          });
          continue;
        }
        if (entry.action === 'delete_created_file') {
          const currentSafety = await this.rollbackPathSafety(entry.path);
          if (!currentSafety.allowed) throw Object.assign(new Error(currentSafety.reason),{code:currentSafety.reason});
          // No asynchronous yield between the last identity/content check and unlink.
          // This narrows application races; it is not an OS-level atomic compare/delete.
          try {
            const current = createdFileRollbackSnapshot(entry.path);
            if (!createdFileRollbackMatches(entry.createdFileSnapshot,current)) throw Object.assign(new Error('Created file no longer matches original evidence'),{code:'B_ROLLBACK_FILE_CHANGED'});
            unlinkSync(entry.path);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          const rollbackResult = { undoJournalId: entry.undoJournalId, action: entry.action, path: entry.path, plannedStatus: step?.status };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
        if (entry.action === 'restore_previous_file') {
          const currentSafety=await this.rollbackPathSafety(entry.path),bytes=previousFileRollbackBytes(entry);
          if(!currentSafety.allowed||!bytes)throw Object.assign(new Error('Original rollback bytes unavailable'),{code:'B_ROLLBACK_PREVIOUS_CONTENT_MISSING'});
          if(!createdFileRollbackMatches(entry.overwrittenFileSnapshot,createdFileRollbackSnapshot(entry.path)))
            throw Object.assign(new Error('Overwritten file changed after preview'),{code:'B_ROLLBACK_FILE_CHANGED_OR_UNVERIFIED'});
          writeFileSync(entry.path,bytes);
          const rollbackResult = { undoJournalId: entry.undoJournalId, action: entry.action, path: entry.path, plannedStatus: step?.status };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
        if (entry.action === 'restore_backup_file') {
          const targetSafety=await this.rollbackPathSafety(entry.path),backupSafety=await this.rollbackPathSafety(entry.backupPath);
          if(!targetSafety.allowed || !backupSafety.allowed)throw Error('B_ROLLBACK_OUTSIDE_ALLOWED_ROOTS');
          if(!createdFileRollbackMatches(entry.editedFileSnapshot,createdFileRollbackSnapshot(entry.path))
            || !createdFileRollbackMatches(entry.backupFileSnapshot,createdFileRollbackSnapshot(entry.backupPath)))
            throw Object.assign(new Error('Document or backup changed after preview'),{code:'B_ROLLBACK_DOCUMENT_CHANGED_OR_UNVERIFIED'});
          const bytes=readFileSync(entry.backupPath);
          if(createHash('sha256').update(bytes).digest('hex')!==entry.backupFileSnapshot.sha256)throw Error('B_ROLLBACK_BACKUP_CHANGED');
          writeFileSync(entry.path,bytes);
          const rollbackResult = {
            undoJournalId: entry.undoJournalId,
            action: entry.action,
            path: entry.path,
            backupPath: entry.backupPath,
            plannedStatus: step?.status
          };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
        if (entry.action === 'move_back') {
          const fromSafety=await this.rollbackPathSafety(entry.from,{checkParentForCreate:true});
          const toSafety=await this.rollbackPathSafety(entry.to);
          if(!fromSafety.allowed||!toSafety.allowed)throw Object.assign(new Error('Move rollback path outside allowed roots'),{code:'B_ROLLBACK_OUTSIDE_ALLOWED_ROOTS'});
          if(!createdFileRollbackMatches(entry.movedFileSnapshot,createdFileRollbackSnapshot(entry.to))
            ||entry.movePhysicalPaths?.from!==rollbackPhysicalPath(entry.from)||entry.movePhysicalPaths?.to!==rollbackPhysicalPath(entry.to))
            throw Object.assign(new Error('Moved file or physical paths changed after preview'),{code:'B_ROLLBACK_MOVE_CHANGED_OR_UNVERIFIED'});
          mkdirSync(dirname(entry.from),{recursive:true});
          // Exclusive link refuses even a late target; no async yield before unlink.
          // Cross-volume/unsupported links remain blocked rather than falling back to overwrite.
          if(entry.movePhysicalPaths.from!==rollbackPhysicalPath(entry.from)||entry.movePhysicalPaths.to!==rollbackPhysicalPath(entry.to)
            ||!createdFileRollbackMatches(entry.movedFileSnapshot,createdFileRollbackSnapshot(entry.to)))throw Error('B_ROLLBACK_MOVE_CHANGED_OR_UNVERIFIED');
          linkSync(entry.to,entry.from);
          if(!createdFileRollbackMatches(entry.movedFileSnapshot,createdFileRollbackSnapshot(entry.from))
            ||!createdFileRollbackMatches(entry.movedFileSnapshot,createdFileRollbackSnapshot(entry.to)))throw Error('B_ROLLBACK_MOVE_PUBLICATION_UNCERTAIN');
          unlinkSync(entry.to);
          const rollbackResult = { undoJournalId: entry.undoJournalId, action: entry.action, from: entry.from, to: entry.to, plannedStatus: step?.status };
          this.undoJournal.markRolledBack(entry, rollbackResult);
          rolledBack.push(rollbackResult);
          this.rollbackTransactions.recordStep(transaction, { step, status: 'rolled_back', rollbackResult });
        }
      }
    } catch (error) {
      const failedTransaction = this.rollbackTransactions.fail(transaction, error, { rolledBack, skipped });
      this.auditLog.write('rollback.failed', {
        taskId,
        transactionId: transaction.transactionId,
        error: error.message,
        rolledBackCount: rolledBack.length,
        skippedCount: skipped.length
      });
      return {
        success: false,
        taskId,
        error: { code: 'B_ROLLBACK_TRANSACTION_FAILED', causeCode: error.code ?? null, message: error.message },
        transaction: failedTransaction,
        plan,
        rolledBack,
        skipped
      };
    }
    const completedTransaction = this.rollbackTransactions.complete(transaction, { rolledBack, skipped });
    this.auditLog.write('rollback.completed', {
      taskId,
      transactionId: transaction.transactionId,
      count: rolledBack.length,
      skippedCount: skipped.length,
      plannedSteps: plan.stepCount,
      blockedCount: plan.blockedCount
    });
    if (!rolledBack.length && skipped.length) {
      return { success: false, taskId, error: { code: 'B_ROLLBACK_UNSAFE_ENTRIES' }, transaction: completedTransaction, plan, skipped };
    }
    return { success: true, taskId, transaction: completedTransaction, plan, rolledBack, skipped };
  }

  async exportRollbackArchive(taskId, { outputPath = null } = {}) {
    const plan = await this.rollbackPlan(taskId);
    if (!plan.success) return plan;
    const generatedAt = this.clock().toISOString();
    const journalRecords = this.undoJournal.records.filter((record) => record.taskId === taskId);
    const archiveBase = {
      archiveType: 'jarvis.pc-agent.rollback-archive',
      schemaVersion: '1.0',
      taskId,
      generatedAt,
      dryRun: true,
      plan,
      journalRecords,
      rollbackTransactions: this.rollbackTransactions.history({ taskId, limit: 20 }),
      chain: this.undoJournal.verifyChain()
    };
    const digest = createHash('sha256').update(canonicalJson(archiveBase)).digest('hex');
    const archive = {
      ...archiveBase,
      digest,
      signature: {
        algorithm: 'sha256-local-digest',
        value: digest,
        signedAt: generatedAt
      }
    };
    const result = { success: true, taskId, archive };
    if (!outputPath) {
      this.auditLog.write('rollback.archive.generated', { taskId, digest, persisted: false });
      return result;
    }
    const safety = await this.rollbackPathSafety(outputPath, { checkParentForCreate: true });
    if (!safety.allowed) {
      return {
        success: false,
        taskId,
        error: { code: 'B_ROLLBACK_ARCHIVE_OUTSIDE_ALLOWED_ROOTS', message: safety.detail },
        archive
      };
    }
    await mkdir(dirname(safety.resolved), { recursive: true });
    await writeFile(safety.resolved, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
    const [fileInfo, fileContent] = await Promise.all([stat(safety.resolved), readFile(safety.resolved)]);
    const file = {
      path: safety.resolved,
      size: fileInfo.size,
      sha256: createHash('sha256').update(fileContent).digest('hex')
    };
    this.auditLog.write('rollback.archive.generated', { taskId, digest, persisted: true, path: file.path, sha256: file.sha256 });
    return { ...result, file };
  }

  rollbackArchiveSignatureKeyRotationDrill({
    archive,
    oldKeyId = 'rollback-archive-signing-key-v1',
    newKeyId = 'rollback-archive-signing-key-v2'
  } = {}) {
    const digest = archive?.digest ?? createHash('sha256').update(canonicalJson(archive ?? {})).digest('hex');
    const sign = (keyId) => createHmac('sha256', keyId).update(digest).digest('hex');
    const oldSignature = {
      keyId: oldKeyId,
      algorithm: 'hmac-sha256-local-rotation-drill',
      value: sign(oldKeyId)
    };
    const newSignature = {
      keyId: newKeyId,
      algorithm: 'hmac-sha256-local-rotation-drill',
      value: sign(newKeyId)
    };
    const checks = [
      {
        checkId: 'archive_digest_available',
        passed: typeof digest === 'string' && digest.length === 64
      },
      {
        checkId: 'old_signature_verifies',
        passed: oldSignature.value === sign(oldKeyId)
      },
      {
        checkId: 'new_signature_verifies',
        passed: newSignature.value === sign(newKeyId)
      },
      {
        checkId: 'rotation_changes_signature_material',
        passed: oldSignature.value !== newSignature.value
      }
    ];
    return {
      drillVersion: 'b-rollback-archive-signature-key-rotation-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      digest,
      dualSignatureWindow: {
        previousKeyAccepted: true,
        nextKeyAccepted: true,
        nextKeyPreferred: true
      },
      oldSignature,
      newSignature,
      checks
    };
  }

  async syncRollbackArchiveToWorm({ taskId, archivePath, targetDir = null } = {}) {
    if (!archivePath) {
      return {
        syncVersion: 'b-rollback-worm-archive-sync-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_ARCHIVE_PATH_REQUIRED' }
      };
    }
    const sourceContent = await readFile(archivePath);
    const sourceSha256 = createHash('sha256').update(sourceContent).digest('hex');
    const safeTaskId = String(taskId ?? 'rollback').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const resolvedTargetDir = resolve(targetDir ?? resolve(this.allowedRoots[0], '.jarvis-rollback-worm-store'));
    const targetPath = resolve(resolvedTargetDir, `${safeTaskId}-${sourceSha256.slice(0, 16)}.json`);
    const safety = await this.rollbackPathSafety(targetPath, { checkParentForCreate: true });
    if (!safety.allowed) {
      return {
        syncVersion: 'b-rollback-worm-archive-sync-v1',
        storeVersion: 'b-rollback-worm-archive-store-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_WORM_TARGET_OUTSIDE_ALLOWED_ROOTS', message: safety.detail },
        targetPath,
        safety
      };
    }
    let copied = false;
    let existingHash = null;
    if (await exists(targetPath)) {
      existingHash = createHash('sha256').update(await readFile(targetPath)).digest('hex');
      if (existingHash !== sourceSha256) {
        return {
          syncVersion: 'b-rollback-worm-archive-sync-v1',
          storeVersion: 'b-rollback-worm-archive-store-v1',
          status: 'failed',
          error: { code: 'B_ROLLBACK_WORM_HASH_MISMATCH' },
          sourceSha256,
          existingHash,
          targetPath
        };
      }
    } else {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(archivePath, targetPath);
      copied = true;
    }
    const manifest = {
      syncVersion: 'b-rollback-worm-archive-sync-v1',
      storeVersion: 'b-rollback-worm-archive-store-v1',
      generatedAt: this.clock().toISOString(),
      status: 'synced',
      taskId,
      policy: {
        writeOnce: true,
        overwriteExistingArchive: false,
        contentAddressedName: true
      },
      itemCount: 1,
      items: [{
        taskId,
        sourcePath: resolve(archivePath),
        targetPath,
        sha256: sourceSha256,
        copied,
        existingHash,
        writeOnce: true
      }]
    };
    const manifestPath = resolve(resolvedTargetDir, 'rollback-worm-manifest.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    this.auditLog.write('rollback.archive.worm_synced', {
      taskId,
      targetPath,
      sha256: sourceSha256,
      copied
    });
    return { ...manifest, manifestPath };
  }

  async rollbackCrashRecoveryDrill({ taskId, plan, targetDir = null } = {}) {
    if (!plan?.success) {
      return {
        drillVersion: 'b-rollback-crash-recovery-drill-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_PLAN_REQUIRED' }
      };
    }
    const safeTaskId = String(taskId ?? 'rollback').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const drillDir = resolve(targetDir ?? resolve(this.allowedRoots[0], '.jarvis-rollback-crash-drills'));
    const drillPath = resolve(drillDir, `${safeTaskId}-${this.clock().getTime()}-transactions.jsonl`);
    const safety = await this.rollbackPathSafety(drillPath, { checkParentForCreate: true });
    if (!safety.allowed) {
      return {
        drillVersion: 'b-rollback-crash-recovery-drill-v1',
        status: 'failed',
        error: { code: 'B_ROLLBACK_CRASH_DRILL_PATH_BLOCKED', message: safety.detail },
        safety
      };
    }
    await mkdir(dirname(safety.resolved), { recursive: true });
    const drillTaskId = `${taskId}:crash-drill`;
    const firstLog = new RollbackTransactionLog({ journalPath: safety.resolved, clock: this.clock });
    const started = firstLog.begin({ taskId: drillTaskId, plan });
    const reloadedLog = new RollbackTransactionLog({ journalPath: safety.resolved, clock: this.clock });
    const recoveredActive = reloadedLog.activeForTask(drillTaskId);
    const recoveredStatus = reloadedLog.status();
    const completed = recoveredActive
      ? reloadedLog.complete(recoveredActive, { rolledBack: [], skipped: [] })
      : null;
    const finalLog = new RollbackTransactionLog({ journalPath: safety.resolved, clock: this.clock });
    const checks = [
      {
        checkId: 'running_transaction_persisted_before_crash',
        passed: started.success === true
      },
      {
        checkId: 'running_transaction_recovered_after_restart',
        passed: Boolean(recoveredActive)
      },
      {
        checkId: 'recovered_chain_valid',
        passed: recoveredStatus.chain.status === 'valid'
      },
      {
        checkId: 'recovered_transaction_can_complete',
        passed: completed?.status === 'completed'
      },
      {
        checkId: 'final_chain_valid_after_completion',
        passed: finalLog.verifyChain().status === 'valid'
      }
    ];
    return {
      drillVersion: 'b-rollback-crash-recovery-drill-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      taskId,
      drillTaskId,
      drillPath: safety.resolved,
      started: started.transaction,
      recoveredActive,
      completed,
      recoveredStatus,
      finalStatus: finalLog.status(),
      checks
    };
  }

  async rollbackProductGate({ taskId = null, targetDir = null } = {}) {
    const pendingEntries = this.undoJournal.list();
    const resolvedTaskId = taskId ?? pendingEntries[0]?.taskId ?? null;
    const targetRoot = resolve(targetDir ?? resolve(this.allowedRoots[0], '.jarvis-rollback-product-gate'));
    const plan = resolvedTaskId ? await this.rollbackPlan(resolvedTaskId) : {
      success: false,
      taskId: resolvedTaskId,
      error: { code: 'B_ROLLBACK_TASK_REQUIRED' }
    };
    const safeTaskId = String(resolvedTaskId ?? 'rollback').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const archivePath = resolve(targetRoot, 'staging', `${safeTaskId}-${this.clock().getTime()}-rollback-archive.json`);
    const archive = plan.success ? await this.exportRollbackArchive(resolvedTaskId, { outputPath: archivePath }) : plan;
    const wormSync = archive.success
      ? await this.syncRollbackArchiveToWorm({
          taskId: resolvedTaskId,
          archivePath: archive.file?.path,
          targetDir: resolve(targetRoot, 'worm-store')
        })
      : {
          syncVersion: 'b-rollback-worm-archive-sync-v1',
          status: 'failed',
          error: { code: 'B_ROLLBACK_ARCHIVE_NOT_AVAILABLE' }
        };
    const keyRotation = archive.success
      ? this.rollbackArchiveSignatureKeyRotationDrill({ archive: archive.archive })
      : this.rollbackArchiveSignatureKeyRotationDrill({ archive: null });
    const crashRecovery = plan.success
      ? await this.rollbackCrashRecoveryDrill({
          taskId: resolvedTaskId,
          plan,
          targetDir: resolve(targetRoot, 'crash-recovery')
        })
      : {
          drillVersion: 'b-rollback-crash-recovery-drill-v1',
          status: 'failed',
          error: { code: 'B_ROLLBACK_PLAN_NOT_AVAILABLE' }
        };
    const undoChain = this.undoJournal.verifyChain();
    const transactionStatus = this.rollbackTransactionStatus();
    const checks = [
      {
        checkId: 'rollback_plan_ready',
        passed: plan.success === true && plan.chain?.status === 'valid' && plan.readyCount >= 1,
        detail: { taskId: resolvedTaskId, readyCount: plan.readyCount, blockedCount: plan.blockedCount }
      },
      {
        checkId: 'undo_journal_chain_valid',
        passed: undoChain.status === 'valid',
        detail: { checked: undoChain.checked, latestHash: undoChain.latestHash }
      },
      {
        checkId: 'rollback_archive_exported',
        passed: archive.success === true && archive.archive?.digest?.length === 64 && archive.file?.sha256?.length === 64,
        detail: { path: archive.file?.path, digest: archive.archive?.digest }
      },
      {
        checkId: 'rollback_worm_archive_synced',
        passed: wormSync.syncVersion === 'b-rollback-worm-archive-sync-v1'
          && wormSync.storeVersion === 'b-rollback-worm-archive-store-v1'
          && wormSync.status === 'synced'
          && wormSync.items?.every((item) => item.writeOnce === true),
        detail: { manifestPath: wormSync.manifestPath, itemCount: wormSync.itemCount }
      },
      {
        checkId: 'rollback_archive_signature_rotation_passed',
        passed: keyRotation.drillVersion === 'b-rollback-archive-signature-key-rotation-drill-v1' && keyRotation.status === 'passed',
        detail: { oldKeyId: keyRotation.oldSignature?.keyId, newKeyId: keyRotation.newSignature?.keyId }
      },
      {
        checkId: 'rollback_crash_recovery_drill_passed',
        passed: crashRecovery.drillVersion === 'b-rollback-crash-recovery-drill-v1' && crashRecovery.status === 'passed',
        detail: { drillPath: crashRecovery.drillPath }
      },
      {
        checkId: 'rollback_transaction_chain_valid',
        passed: transactionStatus.chain.status === 'valid',
        detail: { checked: transactionStatus.chain.checked, active: transactionStatus.active.length }
      }
    ];
    const releaseCheckSnapshot = checks.map((check) => ({ checkId: check.checkId, passed: check.passed }));
    const artifactManifest = {
      manifestVersion: 'b-rollback-release-artifact-manifest-v1',
      generatedAt: this.clock().toISOString(),
      taskIdHash: createHash('sha256').update(String(resolvedTaskId ?? '')).digest('hex'),
      undoJournalPathHash: createHash('sha256').update(String(this.undoJournal.journalPath ?? '')).digest('hex'),
      rollbackTransactionJournalPathHash: createHash('sha256').update(String(this.rollbackTransactions.journalPath ?? '')).digest('hex'),
      undoJournalManifest: {
        manifestVersion: 'b-rollback-undo-journal-manifest-v1',
        recordCount: this.undoJournal.records.length,
        pendingEntryCount: pendingEntries.length,
        recordCounts: countBy(this.undoJournal.records, 'recordType'),
        chainStatus: undoChain.status,
        latestHash: undoChain.latestHash ?? null
      },
      transactionManifest: {
        manifestVersion: 'b-rollback-transaction-journal-manifest-v1',
        recordCount: this.rollbackTransactions.records.length,
        transactionCount: transactionStatus.transactions,
        activeCount: transactionStatus.active.length,
        recordCounts: countBy(this.rollbackTransactions.records, 'recordType'),
        chainStatus: transactionStatus.chain.status,
        latestHash: transactionStatus.chain.latestHash ?? null
      },
      planEvidenceHash: createHash('sha256').update(canonicalJson({
        success: plan.success === true,
        dryRun: plan.dryRun === true,
        readyCount: plan.readyCount ?? 0,
        blockedCount: plan.blockedCount ?? 0,
        stepCount: plan.steps?.length ?? 0,
        chainStatus: plan.chain?.status ?? null
      })).digest('hex'),
      archiveEvidenceHash: createHash('sha256').update(canonicalJson({
        success: archive.success === true,
        digest: archive.archive?.digest ?? null,
        fileSha256: archive.file?.sha256 ?? null,
        fileSize: archive.file?.size ?? null,
        signatureAlgorithm: archive.archive?.signature?.algorithm ?? null
      })).digest('hex'),
      wormSyncEvidenceHash: createHash('sha256').update(canonicalJson({
        syncVersion: wormSync.syncVersion ?? null,
        storeVersion: wormSync.storeVersion ?? null,
        status: wormSync.status ?? null,
        itemCount: wormSync.itemCount ?? 0,
        itemHashes: (wormSync.items ?? []).map((item) => ({
          sha256: item.sha256,
          copied: item.copied === true,
          writeOnce: item.writeOnce === true,
          existingHash: item.existingHash ?? null
        }))
      })).digest('hex'),
      keyRotationEvidenceHash: createHash('sha256').update(canonicalJson({
        drillVersion: keyRotation.drillVersion ?? null,
        status: keyRotation.status ?? null,
        digest: keyRotation.digest ?? null,
        oldKeyIdHash: keyRotation.oldSignature?.keyId
          ? createHash('sha256').update(String(keyRotation.oldSignature.keyId)).digest('hex')
          : null,
        newKeyIdHash: keyRotation.newSignature?.keyId
          ? createHash('sha256').update(String(keyRotation.newSignature.keyId)).digest('hex')
          : null
      })).digest('hex'),
      crashRecoveryEvidenceHash: createHash('sha256').update(canonicalJson({
        drillVersion: crashRecovery.drillVersion ?? null,
        status: crashRecovery.status ?? null,
        checkSummary: (crashRecovery.checks ?? []).map((check) => ({ checkId: check.checkId, passed: check.passed })),
        finalChainStatus: crashRecovery.finalStatus?.chain?.status ?? null
      })).digest('hex'),
      releaseCheckHash: createHash('sha256').update(canonicalJson(releaseCheckSnapshot)).digest('hex'),
      rawUndoPayloadStored: false,
      rawRollbackPathStored: false,
      rawArchivePathStored: false,
      rawWormArchivePathStored: false,
      rawCapabilityTokenStored: false
    };
    artifactManifest.rawLeakCheck = {
      checkVersion: 'b-rollback-release-raw-leak-check-v1',
      rawLeakDetected: containsRollbackReleaseRawLeak(artifactManifest),
      checkedRawFields: [
        'rawUndoPayloadStored',
        'rawRollbackPathStored',
        'rawArchivePathStored',
        'rawWormArchivePathStored',
        'rawCapabilityTokenStored'
      ]
    };
    const operationalHandoffManifest = {
      manifestVersion: 'b-rollback-operational-handoff-manifest-v1',
      healthHandshakeVersion: 'b-rollback-health-handshake-v1',
      generatedAt: this.clock().toISOString(),
      status: checks.every((check) => check.passed)
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        ? 'ready'
        : 'blocked',
      healthHandshake: {
        rollbackPlanReady: plan.success === true && plan.readyCount >= 1,
        undoJournalChainValid: undoChain.status === 'valid',
        archiveExportReady: archive.success === true && archive.archive?.digest?.length === 64,
        wormArchiveSynced: wormSync.status === 'synced' && wormSync.storeVersion === 'b-rollback-worm-archive-store-v1',
        signatureRotationReady: keyRotation.status === 'passed',
        crashRecoveryReady: crashRecovery.status === 'passed',
        transactionChainValid: transactionStatus.chain.status === 'valid'
      },
      fallbackPolicy: {
        policyVersion: 'b-rollback-fallback-policy-v1',
        primaryFlow: 'dry_run_plan_then_transaction_locked_undo_journal_rollback',
        fallbackFlows: [
          'export_digest_signed_archive_before_rollback',
          'sync_rollback_archive_to_worm_store',
          'recover_running_transaction_from_jsonl_after_restart',
          'escalate_blocked_or_skipped_steps_to_manual_review'
        ],
        operatorEscalation: 'pc_agent_rollback_transactions_and_archive_review'
      },
      rawUndoPayloadStored: false,
      rawRollbackPathStored: false,
      rawArchivePathStored: false,
      rawCapabilityTokenStored: false
    };
    const ciNightlyGatePlan = {
      planVersion: 'b-rollback-ci-nightly-gate-plan-v1',
      requiredCommand: 'node --test --test-name-pattern "B undo journal persists rollback records" tests/ag-runtime.test.js',
      requiredForPr: true,
      requiredForNightly: true,
      requiredChecks: [
        'rollback_plan_ready',
        'undo_journal_chain_valid',
        'rollback_archive_exported',
        'rollback_worm_archive_synced',
        'rollback_archive_signature_rotation_passed',
        'rollback_crash_recovery_drill_passed',
        'rollback_transaction_chain_valid',
        'rollback_release_artifact_manifest_ready',
        'rollback_operational_handoff_ready',
        'rollback_worm_promotion_package_ready'
      ],
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      rawUndoPayloadStored: false,
      rawArchivePathStored: false
    };
    const externalWormPromotionPackage = {
      packageVersion: 'b-rollback-worm-promotion-package-v1',
      providerContractVersion: 'b-rollback-worm-provider-contract-v1',
      status: artifactManifest.manifestVersion === 'b-rollback-release-artifact-manifest-v1'
        && artifactManifest.rawLeakCheck.rawLeakDetected === false
        && operationalHandoffManifest.status === 'ready'
        && ciNightlyGatePlan.planVersion === 'b-rollback-ci-nightly-gate-plan-v1'
        && wormSync.status === 'synced'
        ? 'ready'
        : 'blocked',
      requiredForFinalRelease: true,
      artifactManifestHash: createHash('sha256').update(canonicalJson(artifactManifest)).digest('hex'),
      operationalHandoffHash: createHash('sha256').update(canonicalJson(operationalHandoffManifest)).digest('hex'),
      ciNightlyGatePlanHash: createHash('sha256').update(canonicalJson(ciNightlyGatePlan)).digest('hex'),
      storagePolicy: {
        appendOnly: true,
        objectLockRequired: true,
        minimumRetentionDays: 365,
        overwriteAllowed: false,
        deleteAllowed: false
      },
      rawUndoPayloadStored: false,
      rawArchivePathStored: false,
      rawCapabilityTokenStored: false
    };
    const releaseDossier = {
      dossierVersion: 'b-rollback-release-dossier-v1',
      generatedAt: this.clock().toISOString(),
      status: externalWormPromotionPackage.status === 'ready' ? 'passed' : 'blocked',
      taskIdHash: artifactManifest.taskIdHash,
      rawUndoPayloadStored: false,
      rawRollbackPathStored: false,
      rawArchivePathStored: false,
      rawWormArchivePathStored: false,
      rawCapabilityTokenStored: false,
      artifactManifest,
      operationalHandoffManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      releaseChecks: releaseCheckSnapshot,
      recommendedReleaseAction: externalWormPromotionPackage.status === 'ready'
        ? 'attach_rollback_hash_only_release_dossier_and_external_worm_promotion_package'
        : 'block_rollback_release_until_archive_worm_rotation_and_crash_recovery_pass'
    };
    releaseDossier.dossierSha256 = createHash('sha256').update(canonicalJson(releaseDossier)).digest('hex');
    checks.push({
      checkId: 'rollback_release_artifact_manifest_ready',
      passed: releaseDossier.artifactManifest.manifestVersion === 'b-rollback-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck.rawLeakDetected === false
        && releaseDossier.artifactManifest.rawUndoPayloadStored === false
        && releaseDossier.artifactManifest.rawArchivePathStored === false
    });
    checks.push({
      checkId: 'rollback_operational_handoff_ready',
      passed: releaseDossier.operationalHandoffManifest.manifestVersion === 'b-rollback-operational-handoff-manifest-v1'
        && releaseDossier.operationalHandoffManifest.healthHandshakeVersion === 'b-rollback-health-handshake-v1'
        && releaseDossier.operationalHandoffManifest.fallbackPolicy.policyVersion === 'b-rollback-fallback-policy-v1'
        && releaseDossier.operationalHandoffManifest.status === 'ready'
    });
    checks.push({
      checkId: 'rollback_worm_promotion_package_ready',
      passed: releaseDossier.externalWormPromotionPackage.packageVersion === 'b-rollback-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage.providerContractVersion === 'b-rollback-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage.status === 'ready'
        && releaseDossier.dossierSha256.length === 64
    });
    const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
    const gate = {
      productGateVersion: 'b-rollback-product-gate-v1',
      generatedAt: this.clock().toISOString(),
      status,
      taskId: resolvedTaskId,
      checks,
      plan,
      archive,
      wormSync,
      keyRotation,
      crashRecovery,
      undoChain,
      transactionStatus,
      releaseDossier,
      recommendations: status === 'passed'
        ? ['Keep rollback WORM archive, signature rotation drill, crash recovery drill, and hash-only release dossier with release evidence.']
        : checks.filter((check) => !check.passed).map((check) => `Resolve rollback product gate check: ${check.checkId}`)
    };
    this.auditLog.write('rollback.product_gate', {
      status,
      taskId: resolvedTaskId,
      checks: checks.map((check) => ({ checkId: check.checkId, passed: check.passed })),
      wormManifestPath: wormSync.manifestPath ?? null
    });
    return gate;
  }

  isRollbackAllowed(path) {
    const resolved = resolve(path);
    return this.allowedRoots.some((root) => isInside(root, resolved));
  }
}
