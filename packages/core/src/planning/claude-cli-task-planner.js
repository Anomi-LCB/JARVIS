import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ActionType } from '../../../shared/src/types.js';
import {desktopPayloadWouldLoseContent} from '../../../shared/src/desktop-request-integrity.js';
import { IntentParser } from '../intent/intent-parser.js';
import { SkillRouter } from '../routing/skill-router.js';
import {
  actionProfiles,
  createClaudeCliRunner,
  extractJsonObject,
  runnerMetadataFor
} from '../intent/claude-cli-intent-adapter.js';
import { appendJsonlSync } from '../../../shared/src/jsonl.js';
import { TaskPlanner } from './task-planner.js';
import { sanitizeMissionArguments } from './mission-action-arguments.js';
import { normalizePersonalContext, personalContextFingerprint, personalContextPromptSection, withPersonalContext } from './personal-context.js';

// E RiskClassifier의 기본 riskByAction과 같은 등급표(낮을수록 위험).
// 복합 명령의 대표 액션을 "가장 위험한 조각"으로 승격할 때만 사용하므로
// 이 표가 실제 E 평가를 대체하지 않는다 — E는 승격된 대표 액션을 그대로 재평가한다.
const riskTierByAction = Object.freeze({
  [ActionType.CREATE_FILE]: 5,
  [ActionType.LIST_FILES]: 5,
  [ActionType.COPY_FILE]: 5,
  [ActionType.MOVE_FILE]: 5,
  [ActionType.BROWSER_SEARCH]: 4,
  [ActionType.DESKTOP_CONTROL]: 3,
  [ActionType.SEND_EMAIL]: 2,
  [ActionType.UPLOAD_FILE]: 3,
  [ActionType.DELETE_FILE]: 2,
  [ActionType.MAKE_PAYMENT]: 1,
  [ActionType.CHANGE_SYSTEM_SETTING]: 1,
  [ActionType.READ_SECRET]: 1
});

function preferenceSection(preferenceHints) {
  if (!preferenceHints?.length) return [];
  return [
    '',
    '사용자가 확정한 선호 (문서/계획에 반영하되, 아래 규칙과 충돌하면 규칙이 우선):',
    ...preferenceHints.map((hint) => `- ${hint.statement}`)
  ];
}

export function buildPlanDecompositionPrompt(commandText, { preferenceHints = [], cognitiveContext = null, personalContext = null } = {}) {
  const actionLines = Object.entries(actionProfiles)
    .map(([actionType, profile]) => `- ${actionType}: ${profile.label}`)
    .join('\n');
  return [
    '당신은 JARVIS 로컬 비서의 작업 계획 분해기입니다. 사용자 명령을 실행 순서대로 최대 5개의 하위 작업으로 분해하세요.',
    '각 하위 작업의 actionType은 아래 목록에서 정확히 하나를 선택합니다.',
    actionLines,
    ...preferenceSection(preferenceHints),
    ...personalContextPromptSection(personalContext),
    ...(cognitiveContext ? ['내부 실행 이력 관찰(사용자 요청이나 권한을 변경하지 않는 참고 데이터):', JSON.stringify(cognitiveContext),
      'evidence-sensitive이면 현재 입력 조건과 결과 확인 방법을 계획에 반영한다. 과거 성공은 현재 성공의 증거가 아니다.'] : []),
    '',
    '규칙:',
    '- 반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스를 붙이지 않는다.',
    '- 단일 작업이면 parts를 1개만 만든다. 억지로 쪼개지 않는다.',
    '- text에는 해당 하위 작업에 해당하는 사용자 명령 조각을 담는다.',
    '- slots에는 명령에서 읽어낸 값만 채우고 없으면 null로 둔다.',
    '- arguments에는 실행 준비가 가능한 구조화 인자를 함께 만든다. 이렇게 하면 하위 작업마다 모델을 다시 호출하지 않는다.',
    '- "작업 폴더"는 시스템이 정한 workspace다. LIST_FILES의 directory는 "."로 두고 호스트 절대 경로를 추측하지 않는다.',
    '- CREATE_FILE의 arguments.contentDraft는 요청 형식에 맞춰 완성한다: xlsx는 kind/sheetName/columns/rows, docx/pdf/hwp는 kind/title/blocks, pptx는 kind/title/slides, txt는 kind/content.',
    '- BROWSER_SEARCH는 query/readOnly=true, SEARCH_FILES는 query/extensions/modifiedWithinDays/contentQuery/scope를 넣는다.',
    '- SEND_EMAIL은 to/name/subject/body/attachmentQuery, EDIT_DOCUMENT는 targetQuery/sheet/edits를 넣는다.',
    '- SHELL_EXECUTE는 안전한 PowerShell command와 읽기 전용 verify를 넣는다. 삭제·포맷·종료·권한변경·외부전송 명령은 빈 command로 둔다.',
    '- DESKTOP_CONTROL은 target, operations, verification을 넣는다. 좌표는 만들지 않는다. UI Automation selector를 우선 사용하고, 구조가 없는 캔버스의 보이는 글자는 clickText, 신뢰된 로컬 이미지가 명시된 글자 없는 아이콘은 clickTemplate로 찾는다.',
    '- 사용자가 요청하지 않은 작업을 추가하지 않는다.',
    '',
    '출력 형식:',
    '{"summary":"한 문장 계획 요약","parts":[{"actionType":"...","text":"명령 조각","description":"할 일 설명","slots":{"fileName":null,"outputFormat":null,"destination":null,"directoryHint":null,"query":null,"topic":null,"dateHint":null},"arguments":{}}]}',
    '',
    `오늘 날짜: ${new Date().toISOString().slice(0, 10)}`,
    `사용자 명령: ${commandText}`
  ].join('\n');
}

export function buildDesktopControlPrompt({ text }) {
  return [
    '사용자의 Windows 화면 조작 요청을 구조화된 UI Automation 계획 JSON으로 변환하세요.',
    '임의 PowerShell이나 좌표 클릭을 만들지 말고 아래 허용된 연산만 사용하세요.',
    '',
    '대상 창 target 필드:',
    '- processName, title, titleContains, className 중 확인 가능한 값만 사용한다.',
    '- 앱 이름만 알면 processName을 사용한다. 창 제목 일부가 명시되면 titleContains를 사용한다.',
    '',
    '허용 operations:',
    '- launch: {"op":"launch","filePath":"notepad.exe","arguments":[]}',
    '- wait: {"op":"wait","timeoutMs":500}',
    '- focusWindow: {"op":"focusWindow"}',
    '- setFocus: selector가 가리키는 요소에 포커스',
    '- setValue: selector와 value로 입력란 값을 설정',
    '- sendKeys: selector와 Windows SendKeys 문법의 keys로 단축키 입력',
    '- invoke 또는 clickElement: 버튼/메뉴 요소의 InvokePattern 실행',
    '- toggle, select, expand, collapse: 해당 UI Automation 패턴 실행',
    '- clickText: UI Automation 요소가 없는 캔버스에서만 {"op":"clickText","text":"화면에 보이는 정확한 문구","matchMode":"exact"}. 좌표는 넣지 않는다.',
    '- clickTemplate: UI Automation 이름과 글자가 없는 아이콘에만 {"op":"clickTemplate","targetLabel":"확인 아이콘","templatePath":"사용자가 제공했거나 작업 문맥에 실제 존재하는 로컬 PNG 경로","minConfidence":0.9}. 경로를 추측하거나 만들지 않는다.',
    '- inspect: 창 존재와 메타데이터만 관찰',
    '',
    'selector 필드: automationId, name, nameContains, className, controlType, index 중 필요한 값만 사용한다.',
    '모든 조작에는 결과를 확인할 verification을 넣는다.',
    'verification type: windowExists, windowTitleContains, elementExists, elementValueEquals, elementNameEquals, elementNameContains, elementEnabled.',
    '비밀번호·인증코드·결제·삭제·전역 권한 버튼은 clickText나 clickTemplate로 계획하지 않는다. 프로그램을 열 때 cmd, powershell, 스크립트 파일은 사용하지 않는다.',
    '일반 앱 매핑: 메모장=notepad.exe, 계산기=calc.exe, 파일 탐색기=explorer.exe.',
    '요청에 없는 저장·전송·종료 동작은 추가하지 않는다.',
    '',
    'JSON 객체 하나만 출력하고 설명이나 코드펜스를 붙이지 않는다.',
    '형식: {"target":{"processName":"","titleContains":""},"operations":[{"op":"..."}],"verification":[{"type":"..."}],"timeoutMs":5000}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

// 명령에 "실제로 채워 넣을 내용/주제"가 있는지 판별한다.
// "메모 만들어"처럼 생성 동사와 파일 종류만 있는 명령은 LLM이 만들어봐야
// 플레이스홀더 템플릿뿐이므로, 로컬 기본 템플릿으로 즉시 처리하고 CLI 왕복(수십 초)을 건너뛴다.
// 구체 주제·수치·항목이 담긴 명령만 콘텐츠 LLM을 태운다.
const contentStopWords = new Set([
  '메모', '문서', '파일', '엑셀', '시트', '표', '보고서', '회의록', '노트', '텍스트',
  '만들어', '만들어줘', '만들기', '생성', '생성해', '생성해줘', '작성', '작성해', '작성해줘',
  '해줘', '해', '줘', '좀', '하나', '새', '새로', '새로운', 'please', '만들', '적어', '적어줘',
  '기록', '기록해', '남겨', '남겨줘', 'txt', 'xlsx', 'csv',
  '워드', '파워포인트', '프레젠테이션', '피피티', 'ppt', 'pptx', 'docx', 'pdf', '한글', 'hwp',
  '슬라이드', '발표', '발표자료', '자료', 'ppt로', '워드로'
]);

export function commandHasDraftableContent(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const contentText = raw
    .replace(/["'“”][^"'“”]+\.(?:xlsx|docx|pptx|ppt|pdf|txt|hwpx?|csv|png|jpe?g|mp4|zip)["'“”]/gi, ' ')
    .replace(/(?:[a-z]:[\\/])?(?:[^\s"'<>|]+[\\/])*[^\s"'<>|]+\.(?:xlsx|docx|pptx|ppt|pdf|txt|hwpx?|csv|png|jpe?g|mp4|zip)\b/gi, ' ');
  // 수치·기간·비율 등 구체 데이터가 있으면 내용이 있다고 본다.
  // 파일명/경로 안의 버전·날짜 숫자는 문서 본문 데이터가 아니므로 먼저 제거한다.
  if (/\d/.test(contentText)) return true;
  const tokens = contentText
    .replace(/[.,!?~…()[\]{}'"'"「」·:/\\-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/(으로|로|를|을|이|가|는|은|의|에|와|과|도|만)$/u, ''))
    .filter(Boolean)
    .filter((token) => !contentStopWords.has(token) && !contentStopWords.has(token.toLowerCase()));
  // 생성어/파일종류어를 걷어낸 뒤 남는 유의미 토큰이 있으면 구체 주제가 있는 것.
  return tokens.some((token) => token.length >= 2);
}

export function buildSearchCriteriaPrompt({ text }) {
  return [
    '사용자의 파일 찾기 요청을 검색 조건 JSON으로 변환하세요.',
    '- query: 파일명에 포함될 핵심 단어(공백 구분, 없으면 빈 문자열)',
    '- extensions: 확장자 배열(예 ["xlsx","pdf"]). 특정 안 하면 빈 배열',
    '- modifiedWithinDays: "어제/최근/이번주" 같은 표현을 일수로(없으면 null)',
    '- contentQuery: 파일 "내용"에서 찾아야 하면 그 문자열(파일명 검색이면 빈 문자열)',
    '- scope: "workspace"(작업 폴더) | "home"(사용자 폴더 전체) | "desktop" | "documents" | "downloads" 중 하나(작업 폴더가 명시되면 "workspace", 그 밖에 모르면 "home")',
    '',
    'JSON 객체 하나만 출력한다. 설명/코드펜스 금지.',
    '형식: {"query":"","extensions":[],"modifiedWithinDays":null,"contentQuery":"","scope":"home"}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildEmailPrompt({ text }) {
  return [
    '사용자의 메일 전송 요청을 JSON으로 변환하세요. 실제 발송은 사용자 승인 후에만 이뤄집니다.',
    '- to: 수신자 이메일 주소(요청에 있으면). 이름만 있으면 name에 넣고 to는 빈 문자열',
    '- name: 수신자 이름(있으면)',
    '- subject: 제목(추론해서 자연스럽게)',
    '- body: 본문(요청 맥락에 맞는 정중한 한국어 본문. 서명은 넣지 않는다)',
    '- attachmentQuery: 첨부할 파일을 찾을 이름 키워드(첨부 언급 없으면 빈 문자열)',
    '',
    'JSON 객체 하나만 출력한다. 설명/코드펜스 금지.',
    '형식: {"to":"","name":"","subject":"","body":"","attachmentQuery":""}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildDocumentEditPrompt({ text }) {
  return [
    '사용자의 문서 수정 요청을 JSON으로 변환하세요. 지금은 엑셀(xlsx) 편집만 지원합니다.',
    '- targetQuery: 수정할 파일을 찾을 이름 키워드',
    '- sheet: 시트명(모르면 null → 첫 시트)',
    '- edits: 편집 배열. 두 형태를 쓸 수 있다:',
    '  · 셀 주소를 알면 {"cell":"B2","value":"새 값"}',
    '  · 값으로 찾아 바꾸려면 {"findText":"찾을 값","value":"바꿀 값","scope":"..."}',
    '- scope(찾아바꾸기에서만): 사용자가 "모두/전부/다 바꿔"라고 하면 "all",',
    '  "첫 번째만/하나만/처음 것"이라고 하면 "first", 몇 개를 바꿀지 불명확하면 "ask".',
    '  범위를 지레짐작하지 말고, 명시가 없으면 반드시 "ask"로 둔다(시스템이 사용자에게 되묻는다).',
    '',
    'JSON 객체 하나만 출력한다. 설명/코드펜스 금지.',
    '형식: {"targetQuery":"","sheet":null,"edits":[{"findText":"","value":"","scope":"ask"}]}',
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

export function buildShellCommandPrompt({ text, locale = 'ko-KR' }) {
  return [
    '당신은 사용자의 자연어 요청을 Windows PowerShell 스크립트로 정확히 번역하는 어시스턴트입니다.',
    '간단한 일은 한 줄, 여러 단계가 필요한 일은 여러 줄 스크립트로 만듭니다.',
    '',
    '할 수 있는 일의 예:',
    '- 파일/폴더 조회·정리·집계, 시스템 정보 확인',
    '- 프로그램 실행(Start-Process), 앱 창 제어',
    '- COM 자동화: Excel(New-Object -ComObject Excel.Application), 한글(HWPFrame.HwpObject) 등 설치된 앱 조작',
    '- UI 자동화(Add-Type -AssemblyName UIAutomationClient, System.Windows.Forms.SendKeys)로 GUI 프로그램 조작',
    '- 여러 단계를 순서대로 수행하는 자동화 스크립트',
    '',
    '한글(HWP/HWPX) 편집 표준 패턴(참고):',
    '  $hwp = New-Object -ComObject HWPFrame.HwpObject',
    '  try { $hwp.RegisterModule("FilePathCheckDLL","FilePathCheckerModule") } catch {}  # 보안 팝업 억제',
    '  $hwp.Open("전체경로")',
    '  $act = $hwp.CreateAction("AllReplace"); $set = $act.CreateSet(); $act.GetDefault($set)',
    '  $set.SetItem("FindString","기존값"); $set.SetItem("ReplaceString","새값"); $set.SetItem("ReplaceMode",1); $set.SetItem("IgnoreMessage",1)',
    '  $act.Execute($set); $hwp.Save(); $hwp.Quit()',
    '',
    '안전 규칙(엄격히 준수):',
    '- 파일 삭제(Remove-Item/rm/del), 포맷, 디스크 초기화, 시스템 종료/재시작, 레지스트리 삭제,',
    '  권한 변경(icacls/takeown), 계정 변경, 외부 전송(업로드/메일/ftp)은 절대 만들지 않는다.',
    '- 요청이 위 금지 항목이면 command를 빈 문자열로 둔다.',
    '- 경로가 필요하면 $HOME, $env:USERPROFILE 등 표준 변수를 쓴다.',
    '- COM 객체는 작업 후 반드시 정리하고(Quit/ReleaseComObject), 변경 작업은 대상이 존재할 때만 한다.',
    '',
    '출력 규칙:',
    '- JSON 객체 하나만 출력한다: {"command":"<powershell 스크립트>", "verify":"<검증 셸>"}',
    '- verify: 작업이 실제로 성공했는지 확인하는 "읽기 전용" 셸 한 줄. 결과를 텍스트로 출력해야 한다.',
    '  예) 파일 생성이면 "Test-Path \\"$HOME\\Desktop\\report.txt\\"", 값 변경이면 그 값을 다시 읽어 출력.',
    '  파괴적 명령을 verify에 넣지 말 것. 검증이 무의미하면 verify는 빈 문자열.',
    '- 설명, 마크다운, 코드펜스 금지.',
    `- 응답 언어 기준: ${locale}`,
    '',
    `사용자 요청: ${text}`
  ].join('\n');
}

// 포맷군을 정한다: 스프레드시트(xlsx) / 리치문서(docx·pdf·hwp) / 슬라이드(pptx) / 평문(txt)
export function contentFamilyOf(outputFormat) {
  const f = String(outputFormat ?? '').toLowerCase();
  if (f === 'xlsx') return 'xlsx';
  if (['docx', 'pdf', 'hwp', 'hwpx'].includes(f)) return 'doc';
  if (['pptx', 'ppt'].includes(f)) return 'slides';
  return 'txt';
}

const contentSchemaByFamily = {
  xlsx: '- xlsx 형식: {"kind":"xlsx","sheetName":"시트명","columns":["열1","열2"],"rows":[["값","값"]]} — 열 최대 20개, 행은 보통 8~20개(최대 60). 합계/소계 행이 자연스러우면 포함한다.',
  doc: [
    '- 문서 형식: {"kind":"doc","title":"문서 제목","blocks":[ ... ]} — blocks는 순서대로 렌더된다. 블록 종류:',
    '    {"type":"heading","level":1,"text":"대제목"}  (level 1~3)',
    '    {"type":"paragraph","text":"문단 본문"}',
    '    {"type":"bullets","items":["항목1","항목2"]}',
    '    {"type":"table","columns":["열1","열2"],"rows":[["값","값"]]}',
    '  섹션 제목(heading)과 본문(paragraph)을 적절히 섞고, 비교·목록성 정보는 표/불릿으로 구조화한다. 블록 8~25개면 충분. 표는 8~20행.',
  ].join('\n'),
  slides: [
    '- 슬라이드 형식: {"kind":"slides","title":"발표 제목","slides":[{"title":"슬라이드 제목","bullets":["요점1","요점2"],"notes":"발표자 노트(선택)"}]} —',
    '  첫 슬라이드는 표지 성격, 이후 슬라이드는 제목+핵심 불릿 3~6개. 슬라이드 5~12장. 불릿은 완결된 짧은 문장. notes에 부연 설명을 담아도 좋다.',
  ].join('\n'),
  txt: '- txt 형식: {"kind":"txt","content":"문서 본문"} — 제목·섹션 구분·항목을 갖춘 완성된 본문. 간결하게, 보통 1500자 이내(최대 8000자).'
};

export function buildContentDraftPrompt({ text, outputFormat, fileName, locale = 'ko-KR', preferenceHints = [], personalContext = null }) {
  const family = contentFamilyOf(outputFormat);
  const formatLabel = { xlsx: 'xlsx(엑셀)', doc: `${outputFormat}(워드/문서)`, slides: `${outputFormat}(프레젠테이션)`, txt: 'txt' }[family];
  return [
    '당신은 실무 문서를 작성하는 전문 어시스턴트입니다. 사용자 명령이 요구하는 문서를 실제 업무에 바로 쓸 수 있는 프로 수준으로 완성하세요.',
    '초안이 아니라 완성본을 목표로 합니다. 형식적이거나 뼈대만 있는 결과는 금지합니다.',
    ...preferenceSection(preferenceHints),
    ...personalContextPromptSection(personalContext),
    '',
    '품질 기준:',
    '- 실무에서 통용되는 구조와 항목을 갖춘다(적절한 섹션/슬라이드, 표 머리글, 요약/합계, 단위 표기 등).',
    '- 사용자가 명시하지 않았어도 그 문서 유형에서 일반적으로 포함되는 표준 항목·행/열을 충실히 채운다.',
    '- 다만 사용자만 아는 사실(고유명사, 실제 수치, 개인정보)은 지어내지 않고 채울 자리(빈 값 또는 "(입력)" 같은 안내)로 남긴다.',
    '- 날짜가 필요하면 오늘 기준으로 계산해 실제 날짜를 넣는다.',
    '- 분량은 간결하고 충실하게. 형식만 보여주는 1~2줄은 금지하되, 핵심만 담아 빠르게 완성한다. 불필요하게 늘리지 않는다.',
    '',
    '출력 규칙:',
    '- 반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스를 붙이지 않는다.',
    `- 문서 언어는 ${locale.startsWith('ko') ? '한국어' : locale}를 기본으로 한다.`,
    contentSchemaByFamily[family],
    '',
    `요청 형식: ${formatLabel}`,
    `오늘 날짜: ${new Date().toISOString().slice(0, 10)}`,
    fileName ? `파일명 힌트: ${fileName}` : null,
    `사용자 명령: ${text}`
  ].filter((line) => line !== null).join('\n');
}

export class ClaudeCliTaskPlanner extends TaskPlanner {
  constructor({
    parser = new IntentParser(),
    skillRouter = new SkillRouter(),
    command = 'claude',
    model = null,
    timeoutMs = 45000,
    maxCommandLength = 2000,
    contentEnabled = false,
    contentModel = 'haiku',
    contentTimeoutMs = 90000,
    contentSmartSkip = true,
    clarifyEnabled = true,
    clarifyConfidenceThreshold = 0.7,
    runner = null,
    contentRunner = null,
    apiKey = process.env.JARVIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    openAiApiKey = process.env.JARVIS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    openAiApi = process.env.JARVIS_OPENAI_API ?? 'chat-completions',
    openAiModel = process.env.JARVIS_OPENAI_MODEL,
    workspaceRoot = './workspace',
    clock = () => new Date(),
    adapterId = 'claude-cli-task-planner-v1'
  } = {}) {
    super({ workspaceRoot });
    this.parser = parser;
    this.skillRouter = skillRouter;
    this.model = model;
    this.contentModel = contentModel;
    this.maxCommandLength = maxCommandLength;
    this.contentEnabled = contentEnabled;
    this.contentSmartSkip = contentSmartSkip;
    this.clarifyEnabled = clarifyEnabled;
    this.clarifyConfidenceThreshold = clarifyConfidenceThreshold;
    this.clock = clock;
    this.adapterId = adapterId;
    this.runner = runner ?? createClaudeCliRunner({ command, model, timeoutMs, apiKey, openAiApiKey, openAiApi, openAiModel });
    // 콘텐츠 작성은 프로 품질을 위해 더 강한 모델(기본 sonnet)과 긴 타임아웃을 쓴다.
    this.contentRunner = contentRunner ?? runner ?? createClaudeCliRunner({ command, model: contentModel, timeoutMs: contentTimeoutMs, apiKey, openAiApiKey, openAiApi, openAiModel });
    const runnerMetadata = runnerMetadataFor(this.runner, model ?? 'cli-default');
    const contentRunnerMetadata = runnerMetadataFor(this.contentRunner, contentModel ?? model ?? 'cli-default');
    this.runnerProvider = runnerMetadata.provider;
    this.runnerExternalService = runnerMetadata.externalService;
    this.runnerModel = runnerMetadata.model;
    this.contentRunnerProvider = contentRunnerMetadata.provider;
    this.contentRunnerExternalService = contentRunnerMetadata.externalService;
    this.contentRunnerModel = contentRunnerMetadata.model;
    this.contentDraftCache = new Map();
    // 콘텐츠 초안도 파일에 남겨 재시작 후에도 같은 요청이면 즉시 재현한다.
    // 키에 날짜가 들어가므로(초안 본문에 오늘 날짜가 박힘) 하루 단위로만 재사용된다.
    this.contentCachePath = process.env.JARVIS_CONTENT_CACHE_PATH
      ?? (process.env.JARVIS_BRIDGE_STATE_DIR ? `${process.env.JARVIS_BRIDGE_STATE_DIR}/content-draft-cache.jsonl` : 'logs/content-draft-cache.jsonl');
    // 작업 결정화: 한 번 성공적으로 만든 (자연어→셸명령) 매핑을 파일에 남겨,
    // 같은 요청이 오면 LLM 호출 없이 즉시 재현한다(반복 업무의 속도·일관성).
    this.shellCommandCache = new Map();
    this.shellCachePath = process.env.JARVIS_SHELL_CACHE_PATH
      ?? (process.env.JARVIS_BRIDGE_STATE_DIR ? `${process.env.JARVIS_BRIDGE_STATE_DIR}/shell-command-cache.jsonl` : 'logs/shell-command-cache.jsonl');
    this.decompositionCache = new Map();
    this.decompositionCachePath = process.env.JARVIS_PLAN_CACHE_PATH
      ?? (process.env.JARVIS_BRIDGE_STATE_DIR ? `${process.env.JARVIS_BRIDGE_STATE_DIR}/plan-decomposition-cache.jsonl` : 'logs/plan-decomposition-cache.jsonl');
    this.loadShellCache();
    this.loadContentCache();
    this.loadDecompositionCache();
  }

  loadDecompositionCache() {
    try {
      if (!existsSync(this.decompositionCachePath)) return;
      for (const line of readFileSync(this.decompositionCachePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const record = JSON.parse(line);
          if (record?.key && this.isValidDecomposition(record.decomposition)) {
            this.decompositionCache.set(record.key, record.decomposition);
          }
        } catch { /* skip bad line */ }
      }
    } catch { /* cache is optional */ }
  }

  loadContentCache() {
    try {
      if (!existsSync(this.contentCachePath)) return;
      for (const line of readFileSync(this.contentCachePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const rec = JSON.parse(line);
          if (rec?.key && rec?.draft) this.contentDraftCache.set(rec.key, rec.draft);
        } catch { /* skip bad line */ }
      }
    } catch { /* cache is optional */ }
  }

  loadShellCache() {
    try {
      if (!existsSync(this.shellCachePath)) return;
      for (const line of readFileSync(this.shellCachePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const rec = JSON.parse(line);
          if (rec?.key && rec?.command) this.shellCommandCache.set(rec.key, { command: rec.command, verify: rec.verify ?? '' });
        } catch { /* skip bad line */ }
      }
    } catch { /* cache is optional */ }
  }

  createPlan(taskRequest, intent, options = {}) {
    this.pendingPreferenceHints = this.preferenceHintsFrom(options.planningContext);
    this.pendingCognitiveContext = options.planningContext?.cognition ?? null;
    this.pendingPersonalContext = normalizePersonalContext(options.personalContext);
    try {
      if (this.canUseTrustedDeterministicRoute(taskRequest, intent, options)) {
        const plan = super.createPlan(taskRequest, intent, {
          ...options,
          deterministicArgumentsOnly: true
        });
        return {
          ...plan,
          planExplanation: `상위 임무 계획에서 확정한 ${options.route.skill.toolName} 경로를 로컬 규칙으로 계획했습니다.`,
          clarification: {
            adapterId: this.adapterId,
            ambiguous: false,
            confidence: Number(intent.confidence ?? 1),
            questions: [],
            resolvedBy: 'trusted-mission-route'
          },
          llmPlanning: {
            adapterId: this.adapterId,
            mode: 'trusted-deterministic-route',
            model: 'local-rules',
            modelRoundTrips: 0,
            rawCommandSharedWithModel: false,
            trustedToolName: options.trustedRouteHint.toolName
          }
        };
      }
      const plan = this.createPlanWithLlm(taskRequest, intent, options);
      return this.attachClarification(plan, taskRequest, intent);
    } finally {
      this.pendingPreferenceHints = null;
      this.pendingCognitiveContext = null;
      this.pendingPersonalContext = null;
    }
  }

  canUseTrustedDeterministicRoute(taskRequest, intent, options) {
    const hint = options.trustedRouteHint;
    const routedToolName = options.route?.skill?.toolName;
    if (hint?.source !== 'mission-executive'
      || hint?.skipExternalPlanning !== true
      || !hint.toolName
      || hint.toolName !== routedToolName) {
      return false;
    }
    // Mission supplies a tool-bound atomic action. If its arguments pass the
    // registered capability schema, a second semantic model call cannot improve
    // the dispatch contract and would only add latency or reinterpret the action.
    if (sanitizeMissionArguments(routedToolName, options.preparedMissionArguments)) return true;
    // Without prepared arguments, only routes whose full arguments can be
    // recovered from local parser slots or safe defaults qualify.
    if (intent.actionType === ActionType.LIST_FILES && routedToolName === 'filesystem.listFiles') return true;
    if (intent.actionType === ActionType.SEARCH_FILES) {
      return typeof intent.slots?.fileName === 'string' && intent.slots.fileName.trim().length > 0;
    }
    if (intent.actionType === ActionType.BROWSER_SEARCH) {
      return typeof intent.slots?.query === 'string' && intent.slots.query.trim().length > 0;
    }
    return false;
  }

  // 계획을 어떻게 세웠는지 사람이 읽을 설명 + 애매하면 물어볼 질문을 붙인다.
  attachClarification(plan, taskRequest, intent) {
    const partCount = plan.planGraph?.nodes?.filter((node) => node.nodeId?.startsWith('action_')).length ?? 1;
    const planExplanation = plan.llmPlanning?.summary
      ? `명령을 "${plan.llmPlanning.summary}"(으)로 이해하고 ${partCount}단계로 계획했습니다.`
      : `명령을 "${intent.title ?? intent.label}" 작업으로 이해하고 ${partCount}단계로 계획했습니다.`;
    // 복합 명령은 분해 단계에서, 셸 명령은 실제 명령이 승인 카드에 노출되므로 확인 질문(느린 LLM)을 만들지 않는다.
    const isCompound = Number(plan.llmPlanning?.partCount ?? 1) > 1;
    const isShell = plan.action?.actionType === ActionType.SHELL_EXECUTE;
    // 단, 미분류 폴백(unknown)으로 셸에 온 모호한 명령은 첫 실행에 한해 확인 질문을 한다.
    // 결정화 캐시에 있는 반복 요청은 즉시 실행 경로이므로 다시 묻지 않는다.
    const shellCacheKey = this.shellCacheKey(taskRequest.command?.rawText);
    const shellSkipsClarify = isShell && (intent.unknown !== true || this.shellCommandCache.has(shellCacheKey));
    const ambiguous = !isCompound && !shellSkipsClarify && (
      intent.unknown === true
      || Number(intent.confidence ?? 1) < this.clarifyConfidenceThreshold
      || (Array.isArray(intent.missingSlots) && intent.missingSlots.includes('intent'))
    );
    const clarifyingQuestions = (this.clarifyEnabled && ambiguous)
      ? this.clarifyingQuestionsFor(taskRequest.command.rawText, intent)
      : [];
    return {
      ...plan,
      planExplanation,
      clarification: {
        adapterId: this.adapterId,
        ambiguous,
        confidence: Number(intent.confidence ?? 1),
        questions: clarifyingQuestions
      }
    };
  }

  clarifyingQuestionsFor(rawText, intent) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength);
    if (!text) return [];
    const prompt = [
      '당신은 작업 실행 전 요구사항을 확인하는 어시스턴트입니다.',
      '아래 사용자 명령을 실행하기에 애매하거나 정보가 부족한 부분이 있으면, 진행 전에 물어볼 핵심 질문을 최대 3개 만드세요.',
      '충분히 명확하면 빈 배열을 반환합니다. 불필요한 질문은 만들지 않습니다.',
      '반드시 JSON 객체 하나만 출력합니다: {"questions":["질문1","질문2"]}',
      `사용자 명령: ${text}`
    ].join('\n');
    let stdout;
    try {
      stdout = this.runner(withPersonalContext(prompt, this.pendingPersonalContext));
    } catch {
      return [];
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    if (!Array.isArray(payload?.questions)) return [];
    return payload.questions
      .filter((question) => typeof question === 'string' && question.trim())
      .slice(0, 3)
      .map((question) => question.trim().slice(0, 200));
  }

  preferenceHintsFrom(planningContext) {
    return (planningContext?.confirmedPreferenceHints ?? [])
      .filter((hint) => typeof hint?.statement === 'string' && hint.statement.trim())
      .sort((a, b) => (b.planningWeight ?? 0) - (a.planningWeight ?? 0))
      .slice(0, 5)
      .map((hint) => ({
        preferenceId: hint.preferenceId ?? null,
        statement: hint.statement.trim().slice(0, 200)
      }));
  }

  createPlanWithLlm(taskRequest, intent, options = {}) {
    const decomposition = this.decomposeWithLlm(taskRequest.command.rawText, intent);
    if (!decomposition) {
      const plan = super.createPlan(taskRequest, intent, options);
      return this.pendingPreferenceHints?.length && plan.action.arguments.contentDraft
        ? { ...plan, llmPlanning: { adapterId: this.adapterId, preferenceHintsApplied: this.pendingPreferenceHints.length, ...(plan.llmPlanning ?? {}) } }
        : plan;
    }
    // 대표 액션을 가장 위험한 조각으로 승격한다. E evaluatePlan은 plan.action만 보므로
    // 이 승격이 있어야 복합 명령 속의 위험 조각(삭제/외부전송 등)이 정책 평가를 우회하지 못한다.
    const riskiest = [...decomposition.parts].sort(
      (a, b) => (riskTierByAction[a.actionType] ?? 4) - (riskTierByAction[b.actionType] ?? 4)
    )[0];
    const actionRerouted = riskiest.actionType !== intent.actionType;
    const riskEscalated = actionRerouted
      && (riskTierByAction[riskiest.actionType] ?? 4) < (riskTierByAction[intent.actionType] ?? 4);
    const primaryIntent = actionRerouted
      ? {
          ...intent,
          actionType: riskiest.actionType,
          title: actionProfiles[riskiest.actionType].label,
          label: actionProfiles[riskiest.actionType].label,
          category: actionProfiles[riskiest.actionType].category,
          riskHint: actionProfiles[riskiest.actionType].riskHint,
          slots: { ...intent.slots, ...riskiest.slots },
          reasons: [
            ...(intent.reasons ?? []),
            `llm_plan_action_reroute:${intent.actionType}->${riskiest.actionType}`,
            ...(riskEscalated ? [`llm_plan_risk_escalation:${riskiest.actionType}`] : [])
          ]
        }
      : intent;
    const route = actionRerouted ? this.skillRouter.route(primaryIntent) : options.route;
    this.pendingDecomposition = decomposition;
    try {
      const plan = super.createPlan(taskRequest, primaryIntent, { ...options, route });
      return {
        ...plan,
        interpretedIntent: decomposition.summary
          ? `${decomposition.summary} (${decomposition.parts.length}단계)`
          : plan.interpretedIntent,
        riskNotes: [
          ...plan.riskNotes,
          ...(actionRerouted && !riskEscalated
            ? [`[LLM 계획] 명령 맥락에 맞게 대표 작업을 ${actionProfiles[riskiest.actionType].label}(으)로 조정했습니다.`]
            : []),
          ...(riskEscalated
            ? [`[LLM 계획] 복합 명령에 더 위험한 하위 작업(${actionProfiles[riskiest.actionType].label})이 있어 대표 위험도를 승격했습니다.`]
            : []),
          ...decomposition.parts.map((part, index) => `[LLM 계획 ${index + 1}/${decomposition.parts.length}] ${actionProfiles[part.actionType].label}: ${part.description}`)
        ],
        llmPlanning: {
          adapterId: this.adapterId,
          model: decomposition.model ?? this.runnerModel,
          summary: decomposition.summary ?? null,
          latencyMs: decomposition.latencyMs,
          partCount: decomposition.parts.length,
          heterogeneous: new Set(decomposition.parts.map((part) => part.actionType)).size > 1,
          actionRerouted,
          riskEscalated,
          preferenceHintsApplied: this.pendingPreferenceHints?.length ?? 0,
          externalService: decomposition.externalService ?? this.runnerExternalService,
          runnerProvider: decomposition.runnerProvider ?? this.runnerProvider,
          providerChain: decomposition.providerChain ?? [this.runnerProvider],
          providerFallbackCount: decomposition.providerFallbackCount ?? 0,
          providerUsage: decomposition.providerUsage ?? null,
          providerCostUsd: decomposition.providerCostUsd ?? null,
          rawCommandSharedWithModel: decomposition.rawCommandSharedWithModel !== false,
          fromCache: decomposition.fromCache === true,
          modelRoundTrips: decomposition.fromCache === true ? 0 : 1,
          preparedArgumentCount: decomposition.preparedArgumentCount ?? 0,
          avoidedFollowupModelCalls: decomposition.preparedArgumentCount ?? 0
        }
      };
    } finally {
      this.pendingDecomposition = null;
    }
  }

  decomposeWithLlm(rawText, intent) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength);
    if (!text) return null;
    // 한 데스크톱 작업 안의 여러 클릭/입력은 desktop.control 전용 계획기가 한 번에 구조화한다.
    // 일반 복합 작업 분해까지 먼저 호출하면 같은 명령이 모델을 두 번 왕복한다.
    if (intent?.actionType === ActionType.DESKTOP_CONTROL) return null;
    // 단순 명령은 LLM 왕복 지연을 만들지 않는다. 접속어/복수 액션이 감지된 복합 명령만 분해한다.
    if (intent?.complexity?.needsPlanDecomposition !== true) return null;
    const cacheKey = this.decompositionCacheKey(text);
    const cached = this.decompositionCache.get(cacheKey);
    if (cached) {
      return {
        ...structuredClone(cached),
        latencyMs: 0,
        runnerProvider: 'local-plan-cache',
        externalService: 'local-cache',
        model: 'cached-result',
        providerChain: ['local-plan-cache'],
        providerFallbackCount: 0,
        providerUsage: null,
        providerCostUsd: null,
        rawCommandSharedWithModel: false,
        fromCache: true
      };
    }
    const startedAt = Date.now();
    let stdout;
    try {
      stdout = this.runner(buildPlanDecompositionPrompt(text, {
        preferenceHints: this.pendingPreferenceHints ?? [], cognitiveContext: this.pendingCognitiveContext,
        personalContext: this.pendingPersonalContext
      }));
    } catch {
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    const rawParts = Array.isArray(payload?.parts) ? payload.parts.slice(0, 5) : [];
    const parts = rawParts
      .filter((part) => actionProfiles[part?.actionType])
      .map((part, index) => ({
        actionType: part.actionType,
        text: typeof part.text === 'string' && part.text.trim() ? part.text.trim().slice(0, 400) : text,
        description: typeof part.description === 'string' && part.description.trim()
          ? part.description.trim().slice(0, 200)
          : `${actionProfiles[part.actionType].label} 실행`,
        slots: this.sanitizeSlots(part.slots),
        arguments: this.sanitizePreparedArguments(part.actionType, part.arguments),
        sequenceIndex: index
      }));
    if (parts.length === 0 || parts.length !== rawParts.length) return null;
    const decomposition = {
      parts,
      summary: typeof payload.summary === 'string' ? payload.summary.trim().slice(0, 300) : null,
      preparedArgumentCount: parts.filter((part) => part.arguments).length
    };
    this.decompositionCache.set(cacheKey, decomposition);
    try {
      appendJsonlSync(this.decompositionCachePath, {
        key: cacheKey,
        decomposition,
        at: this.clock().toISOString()
      });
    } catch { /* optional */ }
    return {
      ...structuredClone(decomposition),
      latencyMs: Date.now() - startedAt,
      runnerProvider: this.runner.lastProvider ?? this.runnerProvider,
      externalService: this.runner.lastExternalService ?? this.runnerExternalService,
      model: this.runner.lastModel ?? this.runnerModel,
      providerChain: (this.runner.providerChain ?? [{ provider: this.runnerProvider }]).map((item) => item.provider),
      providerFallbackCount: this.runner.lastFailures?.length ?? 0,
      providerUsage: this.runner.lastUsage ?? null,
      providerCostUsd: this.runner.lastCostUsd ?? null,
      rawCommandSharedWithModel: true,
      fromCache: false
    };
  }

  decompositionCacheKey(text) {
    const preferences = (this.pendingPreferenceHints ?? []).map((hint) => hint.statement).join('|');
    const normalized = `${this.clock().toISOString().slice(0, 10)}|${String(text).toLowerCase().replace(/\s+/g, ' ')}|${preferences}|${JSON.stringify(this.pendingCognitiveContext ?? null)}|${personalContextFingerprint(this.pendingPersonalContext)}`;
    return createHash('sha256').update(normalized).digest('hex');
  }

  isValidDecomposition(value) {
    return Array.isArray(value?.parts)
      && value.parts.length > 0
      && value.parts.length <= 5
      && value.parts.every((part) => actionProfiles[part?.actionType] && typeof part?.text === 'string');
  }

  argumentsFor(intent, taskRequest, contextSnapshot) {
    const base = super.argumentsFor(intent, taskRequest, contextSnapshot);
    // 매크로 저장: 원문만 넘기면 어댑터가 규칙으로 이름·명령을 뽑는다(LLM 불필요).
    if (intent.actionType === ActionType.MACRO_SAVE) {
      return { ...base, rawText: taskRequest.command.rawText };
    }
    if (intent.actionType === ActionType.DESKTOP_CONTROL) {
      const drafted = this.draftJsonFor(buildDesktopControlPrompt, {
        text: intent.slots?.rawCommand ?? taskRequest.command.rawText
      });
      const plan = this.sanitizeDesktopControlPlan(drafted);
      return {
        rawText: taskRequest.command.rawText,
        ...(plan ?? { target: base.target ?? {}, operations: [], verification: [] })
      };
    }
    // 셸 실행: 자연어를 안전한 PowerShell 한 줄 명령으로 LLM 변환한다. 실제 명령은 승인 카드에 노출된다.
    if (intent.actionType === ActionType.SHELL_EXECUTE) {
      const drafted = this.draftShellCommandFor({
        text: intent.slots?.rawCommand ?? taskRequest.command.rawText,
        locale: taskRequest.command?.locale ?? 'ko-KR'
      });
      if (!drafted) return { ...base, shell: 'powershell' };
      return {
        ...base,
        command: drafted.command,
        verifyCommand: drafted.verify || null,
        shell: 'powershell',
        rawText: taskRequest.command.rawText,
        shellDraft: { adapterId: this.adapterId, draftedByLlm: true }
      };
    }
    // 파일 검색: 자연어에서 검색 조건(이름/확장자/기간/내용)을 뽑는다.
    if (intent.actionType === ActionType.SEARCH_FILES) {
      const criteria = this.draftJsonFor(buildSearchCriteriaPrompt, { text: intent.slots?.rawCommand ?? taskRequest.command.rawText });
      return { ...base, rawText: taskRequest.command.rawText, ...(criteria ?? {}) };
    }
    // 메일 전송: 수신자/제목/본문/첨부 힌트를 뽑는다. 실제 전송은 승인 후 B가 수행.
    if (intent.actionType === ActionType.SEND_EMAIL) {
      const mail = this.draftJsonFor(buildEmailPrompt, { text: intent.slots?.rawCommand ?? taskRequest.command.rawText });
      return { ...base, rawText: taskRequest.command.rawText, ...(mail ?? {}) };
    }
    // 문서 편집: 대상 파일과 편집 지시(셀/값)를 뽑는다.
    if (intent.actionType === ActionType.EDIT_DOCUMENT) {
      const edit = this.draftJsonFor(buildDocumentEditPrompt, { text: intent.slots?.rawCommand ?? taskRequest.command.rawText });
      return { ...base, rawText: taskRequest.command.rawText, ...(edit ?? {}) };
    }
    if (!this.contentEnabled || intent.actionType !== ActionType.CREATE_FILE) return base;
    const sourceText = intent.slots?.llmPartText ?? taskRequest.command.rawText;
    // 채울 내용이 없는 단순 생성 명령은 콘텐츠 LLM을 건너뛰고 로컬 기본 템플릿을 쓴다(수십 초 절감).
    if (this.contentSmartSkip && !commandHasDraftableContent(sourceText)) return base;
    const draft = this.draftContentFor({
      text: sourceText,
      outputFormat: base.outputFormat ?? intent.slots?.outputFormat ?? 'txt',
      fileName: base.fileName ?? intent.slots?.fileName ?? null,
      locale: taskRequest.command?.locale ?? 'ko-KR'
    });
    if (!draft) return base;
    const family = contentFamilyOf(base.outputFormat ?? intent.slots?.outputFormat ?? 'txt');
    const appliedPreferences = (this.pendingPreferenceHints ?? []).map((hint) => hint.preferenceId).filter(Boolean);
    const stamp = (kind) => ({ contentDraft: { adapterId: this.adapterId, kind, draftedByLlm: true, appliedPreferences } });
    if (draft.kind === 'xlsx' && family === 'xlsx') {
      return { ...base, sheetName: draft.sheetName ?? base.sheetName, columns: draft.columns, rows: draft.rows, ...stamp('xlsx') };
    }
    // 워드/PDF/한글: 제목+블록(헤딩/문단/불릿/표) 구조를 그대로 넘긴다. 어댑터가 COM으로 렌더한다.
    if (draft.kind === 'doc' && family === 'doc') {
      return { ...base, docTitle: draft.title ?? null, blocks: Array.isArray(draft.blocks) ? draft.blocks : [], ...stamp('doc') };
    }
    // 프레젠테이션: 슬라이드 배열을 넘긴다.
    if (draft.kind === 'slides' && family === 'slides') {
      return { ...base, deckTitle: draft.title ?? null, slides: Array.isArray(draft.slides) ? draft.slides : [], ...stamp('slides') };
    }
    // 평문 폴백(포맷이 무엇이든 txt 초안이 왔으면 본문으로).
    if (draft.kind === 'txt' && family !== 'xlsx') {
      return { ...base, content: draft.content, ...stamp('txt') };
    }
    return base;
  }

  // 프롬프트 빌더로 LLM을 호출하고 JSON 객체를 돌려준다(검색/메일/편집 인자 추출용 공통 경로).
  draftJsonFor(promptBuilder, args) {
    const trimmed = String(args?.text ?? '').trim().slice(0, this.maxCommandLength);
    if (!trimmed) return null;
    let stdout;
    try {
      stdout = this.runner(withPersonalContext(promptBuilder({ ...args, text: trimmed }), this.pendingPersonalContext));
    } catch {
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    return payload && typeof payload === 'object' ? payload : null;
  }

  draftShellCommandFor({ text, locale }) {
    const trimmed = String(text ?? '').trim().slice(0, this.maxCommandLength);
    if (!trimmed) return null;
    // 결정화 캐시: 같은 요청이면 LLM을 부르지 않고 이전에 만든 명령을 즉시 재현한다.
    const key = this.shellCacheKey(trimmed);
    if (this.shellCommandCache.has(key)) {
      return { ...this.shellCommandCache.get(key), fromCache: true };
    }
    let stdout;
    try {
      stdout = this.runner(withPersonalContext(buildShellCommandPrompt({ text: trimmed, locale }), this.pendingPersonalContext));
    } catch {
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
    // 여러 단계 자동화(COM/GUI/멀티스텝)를 위해 여러 줄 스크립트를 허용한다.
    // 안전은 어댑터의 정적 차단(classifyShellCommand)이 줄 단위로 담당한다.
    if (!command || command.length > 8000) return null;
    // 자기검증: LLM이 "성공을 확인하는 읽기 전용 셸"도 함께 낸다. 실행 후 이걸로 결과를 형식 검증한다.
    const verify = typeof payload?.verify === 'string' ? payload.verify.trim().slice(0, 1000) : '';
    const result = { command, verify };
    // 결정화 저장: 다음 같은 요청부터 LLM 없이 즉시 재현.
    this.shellCommandCache.set(key, result);
    try { appendJsonlSync(this.shellCachePath, { key, command, verify, at: this.clock().toISOString() }); } catch { /* optional */ }
    return result;
  }

  draftContentFor({ text, outputFormat, fileName, locale }) {
    const trimmed = String(text ?? '').trim().slice(0, this.maxCommandLength);
    if (!trimmed) return null;
    const preferenceHints = this.pendingPreferenceHints ?? [];
    const today = this.clock().toISOString().slice(0, 10);
    const cacheKey = createHash('sha256').update(JSON.stringify({
      today, outputFormat, fileName, locale, text: trimmed,
      preferences: preferenceHints.map(hint => hint.statement),
      personalContext: personalContextFingerprint(this.pendingPersonalContext)
    })).digest('hex');
    if (this.contentDraftCache.has(cacheKey)) return this.contentDraftCache.get(cacheKey);
    let stdout;
    try {
      stdout = this.contentRunner(buildContentDraftPrompt({
        text: trimmed, outputFormat, fileName, locale, preferenceHints,
        personalContext: this.pendingPersonalContext
      }));
    } catch {
      this.contentDraftCache.set(cacheKey, null);
      return null;
    }
    const wrapper = extractJsonObject(stdout);
    const payload = wrapper && typeof wrapper.result === 'string' ? extractJsonObject(wrapper.result) : wrapper;
    const draft = this.sanitizeContentDraft(payload);
    this.contentDraftCache.set(cacheKey, draft);
    // 실패(null)는 영속하지 않는다 — 다음 기회에 다시 시도해야 하므로.
    if (draft) {
      try { appendJsonlSync(this.contentCachePath, { key: cacheKey, draft, at: this.clock().toISOString() }); } catch { /* optional */ }
    }
    return draft;
  }

  shellCacheKey(rawText) {
    const text = String(rawText ?? '').trim().slice(0, this.maxCommandLength).toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256').update(JSON.stringify({ text,
      personalContext: personalContextFingerprint(this.pendingPersonalContext)
    })).digest('hex');
  }

  sanitizeContentDraft(payload) {
    if (payload?.kind === 'xlsx') {
      const columns = Array.isArray(payload.columns)
        ? payload.columns.slice(0, 20).map((column) => String(column).slice(0, 120))
        : [];
      const rows = Array.isArray(payload.rows)
        ? payload.rows
            .slice(0, 200)
            .filter((row) => Array.isArray(row))
            .map((row) => row.slice(0, columns.length || 20).map((cell) => (
              typeof cell === 'number' ? cell : String(cell ?? '').slice(0, 500)
            )))
        : [];
      if (columns.length === 0 || rows.length === 0) return null;
      return {
        kind: 'xlsx',
        sheetName: typeof payload.sheetName === 'string' && payload.sheetName.trim()
          ? payload.sheetName.trim().slice(0, 30)
          : null,
        columns,
        rows
      };
    }
    if (payload?.kind === 'txt' && typeof payload.content === 'string' && payload.content.trim()) {
      return { kind: 'txt', content: payload.content.trim().slice(0, 20000) };
    }
    if (payload?.kind === 'doc') {
      const title = this.sanitizeText(payload.title, 200);
      const blocks = (Array.isArray(payload.blocks) ? payload.blocks : [])
        .slice(0, 40)
        .map((block) => this.sanitizeDocumentBlock(block))
        .filter(Boolean);
      if (!title && blocks.length === 0) return null;
      return { kind: 'doc', title, blocks };
    }
    if (payload?.kind === 'slides') {
      const title = this.sanitizeText(payload.title, 200);
      const slides = (Array.isArray(payload.slides) ? payload.slides : [])
        .slice(0, 20)
        .map((slide) => {
          const slideTitle = this.sanitizeText(slide?.title, 200);
          const bullets = (Array.isArray(slide?.bullets) ? slide.bullets : [])
            .slice(0, 10)
            .map((item) => this.sanitizeText(item, 500))
            .filter(Boolean);
          const notes = this.sanitizeText(slide?.notes, 2000);
          return slideTitle || bullets.length ? { title: slideTitle, bullets, ...(notes ? { notes } : {}) } : null;
        })
        .filter(Boolean);
      if (!title && slides.length === 0) return null;
      return { kind: 'slides', title, slides };
    }
    return null;
  }

  sanitizeDocumentBlock(block) {
    if (!block || typeof block !== 'object') return null;
    const type = String(block.type ?? '').toLowerCase();
    if (type === 'heading') {
      const text = this.sanitizeText(block.text, 500);
      return text ? { type, level: Math.min(3, Math.max(1, Number(block.level) || 1)), text } : null;
    }
    if (type === 'paragraph') {
      const text = this.sanitizeText(block.text, 4000);
      return text ? { type, text } : null;
    }
    if (type === 'bullets') {
      const items = (Array.isArray(block.items) ? block.items : [])
        .slice(0, 30)
        .map((item) => this.sanitizeText(item, 1000))
        .filter(Boolean);
      return items.length ? { type, items } : null;
    }
    if (type === 'table') {
      const columns = (Array.isArray(block.columns) ? block.columns : [])
        .slice(0, 20)
        .map((item) => this.sanitizeText(item, 200))
        .filter(Boolean);
      const rows = (Array.isArray(block.rows) ? block.rows : [])
        .slice(0, 100)
        .filter(Array.isArray)
        .map((row) => row.slice(0, columns.length || 20).map((cell) => this.sanitizeText(cell, 1000)));
      return columns.length && rows.length ? { type, columns, rows } : null;
    }
    return null;
  }

  sanitizeText(value, maxLength) {
    if (value === undefined || value === null) return '';
    return String(value).trim().slice(0, maxLength);
  }

  sanitizePreparedArguments(actionType, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const text = (key, max = 1000) => this.sanitizeText(value[key], max);
    if (actionType === ActionType.CREATE_FILE) {
      const contentDraft = this.sanitizeContentDraft(value.contentDraft ?? value.draft);
      const result = {
        fileName: text('fileName', 240) || undefined,
        outputFormat: text('outputFormat', 16).toLowerCase() || undefined,
        path: text('path', 1000) || undefined,
        outputPath: text('outputPath', 1000) || undefined,
        contentDraft
      };
      return Object.values(result).some(Boolean) ? result : null;
    }
    if (actionType === ActionType.MOVE_FILE) {
      const sanitizeMove = (move) => {
        if (!move || typeof move !== 'object' || Array.isArray(move)) return null;
        const from = this.sanitizeText(move.from ?? move.source ?? move.sourcePath, 1000);
        const to = this.sanitizeText(move.to ?? move.destination ?? move.target ?? move.targetPath, 1000);
        return from && to ? { from, to } : null;
      };
      const moves = (Array.isArray(value.moves) ? value.moves : [])
        .slice(0, 20)
        .map(sanitizeMove)
        .filter(Boolean);
      if (moves.length) return { moves };
      return sanitizeMove(value);
    }
    if (actionType === ActionType.BROWSER_SEARCH) {
      return { query: text('query', 500), searchEngine: ['duckduckgo', 'bing'].includes(text('searchEngine', 30).toLowerCase()) ? text('searchEngine', 30).toLowerCase() : 'duckduckgo', maxResults: Math.min(10, Math.max(1, Number(value.maxResults) || 5)), readOnly: true };
    }
    if (actionType === ActionType.SEARCH_FILES) {
      return {
        query: text('query', 300),
        extensions: (Array.isArray(value.extensions) ? value.extensions : []).slice(0, 12).map((item) => this.sanitizeText(item, 16).replace(/^\./, '')).filter(Boolean),
        modifiedWithinDays: Number.isFinite(Number(value.modifiedWithinDays)) ? Math.min(3650, Math.max(0, Number(value.modifiedWithinDays))) : null,
        contentQuery: text('contentQuery', 500),
        scope: ['workspace', 'home', 'desktop', 'documents', 'downloads'].includes(text('scope', 30).toLowerCase()) ? text('scope', 30).toLowerCase() : 'home'
      };
    }
    if (actionType === ActionType.SEND_EMAIL) {
      return { to: text('to', 320), name: text('name', 200), subject: text('subject', 500), body: text('body', 10000), attachmentQuery: text('attachmentQuery', 500) };
    }
    if (actionType === ActionType.EDIT_DOCUMENT) {
      const edits = (Array.isArray(value.edits) ? value.edits : []).slice(0, 100).map((edit) => ({
        ...(this.sanitizeText(edit?.cell, 30) ? { cell: this.sanitizeText(edit.cell, 30) } : {}),
        ...(this.sanitizeText(edit?.findText, 500) ? { findText: this.sanitizeText(edit.findText, 500) } : {}),
        value: edit?.value === null || edit?.value === undefined ? '' : String(edit.value).slice(0, 2000),
        scope: ['first', 'all', 'ask'].includes(String(edit?.scope ?? '').toLowerCase()) ? String(edit.scope).toLowerCase() : 'ask'
      })).filter((edit) => edit.cell || edit.findText);
      return { targetQuery: text('targetQuery', 500), targetPath: text('targetPath', 1000), sheet: text('sheet', 200) || null, edits };
    }
    if (actionType === ActionType.SHELL_EXECUTE) {
      const command = text('command', 8000);
      return command ? { command, verifyCommand: text('verify', 1000), shell: 'powershell' } : null;
    }
    if (actionType === ActionType.DESKTOP_CONTROL) {
      return this.sanitizeDesktopControlPlan(value);
    }
    const allowed = {};
    for (const key of ['path', 'directory', 'destination', 'source', 'target']) {
      const item = text(key, 1000);
      if (item) allowed[key] = item;
    }
    return Object.keys(allowed).length ? allowed : null;
  }

  sanitizeSlots(slots) {
    const sanitized = {};
    for (const key of ['fileName', 'outputFormat', 'destination', 'directoryHint', 'query', 'topic', 'dateHint', 'appName', 'windowTitle']) {
      const value = slots?.[key];
      if (typeof value === 'string' && value.trim()) sanitized[key] = value.trim().slice(0, 200);
    }
    return sanitized;
  }

  decomposeActions(rawText, intent) {
    if (!this.pendingDecomposition) return super.decomposeActions(rawText, intent);
    return this.pendingDecomposition.parts.map((part) => ({
      text: part.text,
      description: part.description
    }));
  }

  actionNodesFor({ taskRequest, intent, action, affectedItems, skill }) {
    if (!this.pendingDecomposition) {
      return super.actionNodesFor({ taskRequest, intent, action, affectedItems, skill });
    }
    // 노드 간 데이터 흐름: 앞 노드가 만든 파일을 뒤의 전송/편집 노드가 이어받게 한다.
    let lastProducedFile = null;
    return this.pendingDecomposition.parts.map((part, index) => {
      const partIntent = {
        actionType: part.actionType,
        label: actionProfiles[part.actionType].label,
        title: part.description,
        category: actionProfiles[part.actionType].category,
        riskHint: actionProfiles[part.actionType].riskHint,
        slots: {
          ...this.parser.extractSlots(part.text, part.actionType),
          ...part.slots,
          ...(part.arguments?.fileName ? { fileName: part.arguments.fileName } : {}),
          ...(part.arguments?.outputFormat ? { outputFormat: part.arguments.outputFormat } : {}),
          llmPartText: part.text
        }
      };
      const partRoute = part.actionType === action.actionType
        ? { skill: { skillId: action.skillId, toolName: action.toolName, version: action.skillVersion } }
        : this.skillRouter.route(partIntent);
      const partSkill = partRoute?.skill ?? skill;
      const partArguments = this.argumentsForDecomposedPart(part, partIntent, taskRequest);
      // 파일을 만드는 노드면 그 이름을 기억한다.
      if (part.actionType === ActionType.CREATE_FILE) {
        lastProducedFile = partArguments.fileName ?? partArguments.path ?? null;
      }
      // 메일/편집 노드에 첨부·대상이 비어 있으면 앞에서 만든 파일로 연결한다.
      if (lastProducedFile) {
        const stem = String(lastProducedFile).split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.[^.]+$/, '') ?? lastProducedFile;
        if (part.actionType === ActionType.SEND_EMAIL && !partArguments.attachmentQuery) {
          partArguments.attachmentQuery = stem;
        }
        if (part.actionType === ActionType.EDIT_DOCUMENT && !partArguments.targetQuery && !partArguments.targetPath) {
          partArguments.targetQuery = stem;
        }
      }
      const partAffected = this.affectedItemsFor(partIntent, partArguments);
      return {
        nodeId: `action_${index + 1}`,
        order: 100 + index + 1,
        module: partSkill.module ?? 'B_PC_AGENT',
        actionType: part.actionType,
        toolName: partSkill.toolName ?? action.toolName,
        skillId: partSkill.skillId ?? action.skillId,
        description: part.description,
        llmPlanned: true,
        argumentsPreparedInDecomposition: Boolean(part.arguments),
        arguments: {
          ...partArguments,
          rawText: part.text,
          ...(['source.readSelectedInbox','case.readLocalRecord','source.collectMicrosoftMetadata'].includes(partSkill.toolName ?? action.toolName) ? {} : { sequenceIndex: index })
        },
        affectedItems: partAffected,
        preconditions: ['ApprovalDecision.approved', 'CapabilityToken.valid'],
        postconditions: ['ExecutionEvidence.available'],
        compensationRef: part.actionType === ActionType.BROWSER_SEARCH || part.actionType === ActionType.LIST_FILES
          ? null
          : `compensate_action_${index + 1}`
      };
    });
  }

  argumentsForDecomposedPart(part, partIntent, taskRequest) {
    const prepared = part.arguments;
    if (!prepared) return this.argumentsFor(partIntent, taskRequest, null);
    const base = super.argumentsFor(partIntent, taskRequest, null);
    if (part.actionType === ActionType.LIST_FILES) {
      return {
        ...base,
        ...prepared,
        directory: this.workspaceDirectoryFor(prepared.directory ?? base.directory)
      };
    }
    if (part.actionType === ActionType.DESKTOP_CONTROL) {
      return {
        rawText: part.text,
        ...(prepared ?? this.argumentsFor(partIntent, taskRequest, null))
      };
    }
    if (part.actionType === ActionType.MOVE_FILE) {
      const moves = prepared.moves ?? (prepared.from && prepared.to ? [{ from: prepared.from, to: prepared.to }] : []);
      return {
        moves: moves.map((move) => ({
          from: this.workspacePathFor(move.from),
          to: this.workspacePathFor(move.to)
        }))
      };
    }
    if (part.actionType !== ActionType.CREATE_FILE) return { ...base, ...prepared };
    const draft = prepared.contentDraft;
    const outputFormat = prepared.outputFormat ?? base.outputFormat ?? partIntent.slots?.outputFormat ?? 'txt';
    const merged = {
      ...base,
      ...(prepared.fileName ? { fileName: prepared.fileName } : {}),
      ...(prepared.outputFormat ? { outputFormat: prepared.outputFormat } : {})
    };
    const preparedPath = prepared.path ?? prepared.outputPath;
    if (preparedPath) {
      const safePath = this.workspacePathFor(preparedPath);
      if (contentFamilyOf(outputFormat) === 'xlsx') merged.outputPath = safePath;
      else merged.path = safePath;
    }
    if (!draft && this.contentEnabled && commandHasDraftableContent(part.text)) {
      return this.argumentsFor(partIntent, taskRequest, null);
    }
    if (!draft || !this.contentEnabled) return merged;
    const family = contentFamilyOf(outputFormat);
    const marker = {
      contentDraft: {
        adapterId: this.adapterId,
        kind: draft.kind,
        draftedByLlm: true,
        preparedInDecomposition: true,
        appliedPreferences: (this.pendingPreferenceHints ?? []).map((hint) => hint.preferenceId).filter(Boolean)
      }
    };
    if (draft.kind === 'xlsx' && family === 'xlsx') return { ...merged, sheetName: draft.sheetName ?? base.sheetName, columns: draft.columns, rows: draft.rows, ...marker };
    if (draft.kind === 'doc' && family === 'doc') return { ...merged, docTitle: draft.title ?? null, blocks: draft.blocks, ...marker };
    if (draft.kind === 'slides' && family === 'slides') return { ...merged, deckTitle: draft.title ?? null, slides: draft.slides, ...marker };
    if (draft.kind === 'txt' && family !== 'xlsx') return { ...merged, content: draft.content, ...marker };
    return this.argumentsFor(partIntent, taskRequest, null);
  }

  sanitizeDesktopControlPlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (desktopPayloadWouldLoseContent(value) || !Array.isArray(value.operations) || value.operations.length>16
      || value.verification !== undefined && (!Array.isArray(value.verification) || value.verification.length>12)) return null;
    const target = this.sanitizeDesktopTarget(value.target);
    const operations = (Array.isArray(value.operations) ? value.operations : [])
      .slice(0, 16)
      .map((operation) => this.sanitizeDesktopOperation(operation))
      .filter(Boolean);
    if (operations.length === 0 || operations.length !== value.operations.length) return null;
    const verification = (Array.isArray(value.verification) ? value.verification : [])
      .slice(0, 12)
      .map((check) => this.sanitizeDesktopVerification(check))
      .filter(Boolean);
    if (verification.length !== (value.verification?.length ?? 0)) return null;
    return {
      target,
      operations,
      verification,
      timeoutMs: Math.min(15000, Math.max(500, Number(value.timeoutMs) || 5000))
    };
  }

  sanitizeDesktopTarget(value = {}) {
    const target = {};
    const processId = Number(value?.processId);
    if (Number.isInteger(processId) && processId > 0) target.processId = processId;
    for (const [key, max] of [['processName', 120], ['title', 300], ['titleContains', 300], ['className', 200]]) {
      const item = this.sanitizeText(value?.[key], max);
      if (item) target[key] = item;
    }
    return target;
  }

  sanitizeDesktopSelector(value = {}) {
    const selector = {};
    for (const [key, max] of [['automationId', 240], ['name', 500], ['nameContains', 500], ['className', 200], ['controlType', 80]]) {
      const item = this.sanitizeText(value?.[key], max);
      if (item) selector[key] = item;
    }
    const index = Number(value?.index);
    if (Number.isInteger(index) && index >= 0) selector.index = Math.min(index, 100);
    return selector;
  }

  sanitizeDesktopOperation(value = {}) {
    const operationNames = new Map([
      ['launch', 'launch'], ['wait', 'wait'], ['inspect', 'inspect'], ['focuswindow', 'focusWindow'],
      ['setfocus', 'setFocus'], ['setvalue', 'setValue'], ['sendkeys', 'sendKeys'], ['invoke', 'invoke'],
      ['clickelement', 'clickElement'], ['toggle', 'toggle'], ['select', 'select'], ['expand', 'expand'], ['collapse', 'collapse'],
      ['clicktext', 'clickText'], ['clicktemplate', 'clickTemplate']
    ]);
    const op = operationNames.get(this.sanitizeText(value?.op, 40).toLowerCase());
    if (!op) return null;
    const operation = { op };
    const target = this.sanitizeDesktopTarget(value?.target);
    if (Object.keys(target).length) operation.target = target;
    const selector = this.sanitizeDesktopSelector(value?.selector);
    if (Object.keys(selector).length) operation.selector = selector;
    const filePath = this.sanitizeText(value?.filePath, 500);
    if (filePath) operation.filePath = filePath;
    if (Array.isArray(value?.arguments)) {
      operation.arguments = value.arguments.slice(0, 16).map((item) => this.sanitizeText(item, 500)).filter(Boolean);
    }
    if (value?.value !== undefined && value?.value !== null) operation.value = String(value.value).slice(0, 8000);
    const keys = this.sanitizeText(value?.keys, 2000);
    if (keys) operation.keys = keys;
    const visualText = this.sanitizeText(value?.text, 500);
    if (visualText) operation.text = visualText;
    const targetLabel = this.sanitizeText(value?.targetLabel, 300);
    if (targetLabel) operation.targetLabel = targetLabel;
    const templatePath = this.sanitizeText(value?.templatePath, 1000);
    if (templatePath) operation.templatePath = templatePath;
    const minConfidence = Number(value?.minConfidence);
    if (Number.isFinite(minConfidence)) operation.minConfidence = Math.min(0.995, Math.max(0.8, minConfidence));
    const scaleTolerance = Number(value?.scaleTolerance);
    if (Number.isFinite(scaleTolerance)) operation.scaleTolerance = Math.min(0.35, Math.max(0, scaleTolerance));
    const ambiguityGap = Number(value?.ambiguityGap);
    if (Number.isFinite(ambiguityGap)) operation.ambiguityGap = Math.min(0.25, Math.max(0.01, ambiguityGap));
    const matchMode = this.sanitizeText(value?.matchMode, 20).toLowerCase();
    if (['exact', 'contains'].includes(matchMode)) operation.matchMode = matchMode;
    const occurrence = Number(value?.occurrence);
    if (Number.isInteger(occurrence) && occurrence >= 0) operation.occurrence = Math.min(occurrence, 20);
    const timeoutMs = Number(value?.timeoutMs);
    if (Number.isFinite(timeoutMs)) operation.timeoutMs = Math.min(15000, Math.max(0, timeoutMs));
    return operation;
  }

  sanitizeDesktopVerification(value = {}) {
    const types = new Map([
      ['windowexists', 'windowExists'], ['windowtitlecontains', 'windowTitleContains'],
      ['elementexists', 'elementExists'], ['elementvalueequals', 'elementValueEquals'],
      ['elementnameequals', 'elementNameEquals'], ['elementnamecontains', 'elementNameContains'],
      ['elementenabled', 'elementEnabled']
    ]);
    const type = types.get(this.sanitizeText(value?.type, 60).toLowerCase());
    if (!type) return null;
    const check = { type };
    const target = this.sanitizeDesktopTarget(value?.target);
    if (Object.keys(target).length) check.target = target;
    const selector = this.sanitizeDesktopSelector(value?.selector);
    if (Object.keys(selector).length) check.selector = selector;
    if (value?.expected !== undefined && value?.expected !== null) check.expected = String(value.expected).slice(0, 8000);
    const timeoutMs = Number(value?.timeoutMs);
    if (Number.isFinite(timeoutMs)) check.timeoutMs = Math.min(15000, Math.max(0, timeoutMs));
    return check;
  }
}

export function createTaskPlannerFromEnv({ env = process.env, runner = null, workspaceRoot = './workspace', clock = () => new Date() } = {}) {
  const enabled = env.JARVIS_LLM_PLANNER === '1' || env.JARVIS_LLM_PLANNER === 'true';
  if (!enabled) return null;
  const anthropicApiKey = env.JARVIS_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? '';
  const openAiApiKey = env.JARVIS_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? '';
  return new ClaudeCliTaskPlanner({
    command: env.JARVIS_LLM_PLANNER_COMMAND ?? env.JARVIS_LLM_INTENT_COMMAND ?? 'claude',
    model: env.JARVIS_LLM_PLANNER_MODEL ?? env.JARVIS_LLM_INTENT_MODEL ?? 'haiku',
    timeoutMs: Number(env.JARVIS_LLM_PLANNER_TIMEOUT_MS ?? 45000),
    apiKey: anthropicApiKey,
    openAiApiKey,
    openAiApi: env.JARVIS_OPENAI_API ?? 'chat-completions',
    openAiModel: env.JARVIS_OPENAI_MODEL ?? null,
    workspaceRoot,
    contentEnabled: env.JARVIS_LLM_CONTENT === '1' || env.JARVIS_LLM_CONTENT === 'true',
    // 콘텐츠 모델 기본 haiku(프로 프롬프트로 이미 실무 품질, ~35s로 폰 타임아웃 안전).
    // 최고 품질을 원하면 JARVIS_LLM_CONTENT_MODEL=sonnet (지연 편차 큼, 타임아웃도 함께 늘릴 것).
    contentModel: env.JARVIS_LLM_CONTENT_MODEL ?? 'haiku',
    contentTimeoutMs: Number(env.JARVIS_LLM_CONTENT_TIMEOUT_MS ?? 90000),
    // 내용 없는 단순 생성 명령은 콘텐츠 LLM을 건너뛴다(기본 ON). 끄려면 JARVIS_LLM_CONTENT_SMART_SKIP=0.
    contentSmartSkip: env.JARVIS_LLM_CONTENT_SMART_SKIP !== '0' && env.JARVIS_LLM_CONTENT_SMART_SKIP !== 'false',
    runner,
    clock
  });
}
