import { ActionType, createIntentCandidate, stableId } from '../../../shared/src/types.js';
import { findNewsPublisherFeed } from '../routing/news-publisher-catalog.js';
import {parseSearchDirectoryRequest} from '../planning/search-directory-request.js';

const namedTextWritePattern = /\.(?:txt|csv|json|md|html?)(?:["'”’])?\s*(?:으로|로|에)\s*[^.\n]{0,24}(?:저장|기록|써|쓰|작성|만들)/i;
const fileOpenPattern = /^(?![\s\S]*(?:만들|작성|생성))(?=[\s\S]*\.(?:xlsx|docx|pptx|ppt|pdf|txt|hwpx?|csv|png|jpe?g|mp4|zip)\b)[\s\S]*(?:열어|띄워|실행|재생)/i;
const directTextFileReadPattern = /\.(?:txt|csv|json|jsonl|md|html?|xml|ya?ml|log)\b[^.\n]{0,80}(?:파일\s*)?(?:을|를)?(?:\s*UTF-?8\s*(?:로|으로)?)?\s*읽(?:어|고|어서|는다|어줘)/iu;

const rules = [
  {
    label: '공개 게시자 RSS 읽기',
    actionType: ActionType.BROWSER_SEARCH,
    category: 'browser',
    riskHint: 'read-only-web',
    patterns: [/(?:게시자|언론사|원문사).{0,24}(?:RSS|피드)|(?:RSS|피드).{0,30}https:\/\//iu,
      /(?:연합뉴스\s*TV|연합뉴스티비).{0,20}(?:뉴스|속보|기사|피드)|(?:뉴스|속보|기사).{0,20}(?:연합뉴스\s*TV|연합뉴스티비)/iu]
  },
  {
    label: '뉴스 기사 본문 읽기',
    actionType: ActionType.BROWSER_SEARCH,
    category: 'browser',
    riskHint: 'read-only-web',
    patterns: [/기사.{0,24}(?:본문|원문|읽|요약)|(?:본문|원문).{0,24}(?:뉴스|기사)/iu]
  },
  {
    label: '삭제 요청',
    actionType: ActionType.DELETE_FILE,
    category: 'filesystem',
    riskHint: 'destructive',
    patterns: [
      /삭제|휴지통/i,
      /(?:\b(?:delete|remove)\b.{0,40}\b(?:file|folder|directory|document)\b|\b(?:file|folder|directory|document)\b.{0,40}\b(?:delete|remove)\b)/i,
      /(?:^|[\s;&|])(?:del|erase|remove-item|rm)(?=\s|$)/i,
      /(?:(?:디스크|드라이브|파티션|볼륨|USB|SD\s*카드).{0,24}(?:포맷|format)|(?:포맷|format).{0,24}(?:디스크|드라이브|파티션|볼륨|USB|SD\s*카드))/i,
      /(?:^|[\s;&|])format(?:\.com)?(?=\s|$)/i
    ]
  },
  {
    label: '매크로 저장',
    actionType: ActionType.MACRO_SAVE,
    category: 'system',
    riskHint: 'read-only-local',
    patterns: [/(으로|로)\s*(저장|기억)(해|하기|할래|해\s*줘)?|(저장|기억)\s*[:：]/i],
    // 위치(드라이브/폴더/경로)로의 저장은 매크로가 아니다.
    antiPatterns: [
      /(드라이브|폴더|디렉[터토]리|경로|바탕화면|다운로드|문서함|desktop|downloads|documents)\s*(으로|로)\s*(저장|기억)/i,
      /\.(?:txt|csv|json|md|html?|xlsx?|docx?|pptx?|hwpx?|pdf)(?:["'”’])?\s*(?:으로|로|에)\s*저장/i,
      /(?=[\s\S]*\.(?:txt|csv|json|md|html?|xlsx?|docx?|pptx?|hwpx?|pdf)\b)(?=[\s\S]*(?:(?:새로\s*)?(?:파일|문서).{0,30}(?:만들|작성|생성)|(?:만들|작성|생성).{0,30}(?:파일|문서)))/iu,
      /powershell|파워\s*쉘|명령어\s*실행/i
    ]
  },
  {
    label: '능력 조회',
    actionType: ActionType.CAPABILITY_QUERY,
    category: 'system',
    riskHint: 'read-only-local',
    patterns: [/(뭘|무엇을|뭐를?|어떤 것을?|어떤 걸).*(할 수|해줄 수|가능)|기능.*(뭐|알려|목록)|능력.*(뭐|알려)|할 수 있는 (게|것)|무슨 일을/i]
  },
  {
    label: '메일 전송',
    actionType: ActionType.SEND_EMAIL,
    category: 'external',
    riskHint: 'external-transfer',
    // 메일 특정(카톡/밴드는 아래 외부 전송 리뷰로 간다).
    patterns: [/(?:메일|이메일|email|mail).*(?:보내|전송|첨부|발송)|(?:보내|전송|첨부|발송).*(?:메일|이메일|email|mail)/i]
  },
  {
    label: '외부 전송 요청',
    actionType: ActionType.UPLOAD_FILE,
    category: 'external',
    riskHint: 'external-transfer',
    patterns: [/업로드|공유/i, /카톡|카카오톡|밴드|드라이브/i]
  },
  {
    label: 'PDF 읽기',
    actionType: ActionType.SEARCH_FILES,
    category:'filesystem',riskHint:'read-only-local',
    patterns:[/\.pdf\b[^.\n]{0,80}(?:읽|내용\s*확인)/iu],
    antiPatterns:[/만들|작성|생성|수정|삭제/iu]
  },
  {
    label:'엑셀 읽기',actionType:ActionType.SEARCH_FILES,category:'filesystem',riskHint:'read-only-local',
    patterns:[/\.xlsx\b[^.\n]{0,140}(?:읽|내용\s*확인|셀[^.\n]{0,20}확인)/iu],antiPatterns:[/만들|작성|생성|수정|삭제/iu]
  },
  {
    label: '텍스트 파일 읽기',
    // Text-only extensions deliberately exclude binary Office files.
    actionType: ActionType.SEARCH_FILES,
    category: 'filesystem',
    riskHint: 'read-only-local',
    patterns: [
      directTextFileReadPattern,
      /\.(?:txt|csv|json|jsonl|md|html?|xml|ya?ml|log)\b[^.\n]{0,100}(?:(?:내용|본문|원문)\s*(?:을|를)?\s*(?:읽|확인)|열어서\s*(?:내용|본문|원문)?\s*(?:을|를)?\s*읽)/iu,
      /(?:(?:내용|본문|원문)\s*(?:을|를)?\s*(?:읽|확인)|열어서\s*(?:내용|본문|원문)?\s*(?:을|를)?\s*읽)[^.\n]{0,100}\.(?:txt|csv|json|jsonl|md|html?|xml|ya?ml|log)\b/iu
    ],
    antiPatterns: [/(?:만들(?:어|기|고|자)|작성(?:해|하|할)|생성(?:해|하|할)|수정(?:해|하|할)|편집(?:해|하|할)|변경(?:해|하|할)|이동(?:해|하|할)|옮겨|삭제(?:해|하|할))/iu]
  },
  {
    label: '파일 검색',
    actionType: ActionType.SEARCH_FILES,
    category: 'filesystem',
    riskHint: 'read-only-local',
    // 명시적인 로컬 대상이나 위치가 있는 경우만 PC 파일 검색으로 분류한다.
    // "자료를 검색해" 같은 일반 정보 요청은 아래 브라우저 조사로 보낸다.
    patterns: [
      /(?:(?:파일|문서|폴더|사진|이미지|엑셀|한글|hwp|pdf).*(?:찾|검색|어디)|(?:찾|검색|어디).*(?:파일|문서|폴더|사진|이미지|엑셀|한글|hwp|pdf))/i,
      /(?:(?:로컬|내\s*(?:PC|컴퓨터)|이\s*(?:PC|컴퓨터)|저장된|드라이브|경로|디렉[터토]리|다운로드|바탕화면|문서함|작업공간|workspace|desktop|downloads).*(?:찾|검색|어디)|(?:찾|검색|어디).*(?:로컬|내\s*(?:PC|컴퓨터)|이\s*(?:PC|컴퓨터)|저장된|드라이브|경로|디렉[터토]리|다운로드|바탕화면|문서함|작업공간|workspace|desktop|downloads))/i,
      /\.(?:xlsx|docx|pptx|ppt|pdf|txt|hwpx?|csv|png|jpe?g|mp4|zip)\b.*(?:찾|검색|어디)/i
    ],
    antiPatterns: [namedTextWritePattern, /^(?!.*(?:내\s*PC|작업\s*폴더|로컬\s*파일)).*(?:웹에서|웹\s*(?:검색|조사)|인터넷|\bMDN\b)/i]
  },
  {
    label: '문서 내용 편집',
    actionType: ActionType.EDIT_DOCUMENT,
    category: 'document',
    riskHint: 'local-change',
    // 기존 파일 수정. 새로 만드는 생성과 구분한다.
    patterns: [/(수정|고쳐|바꿔|편집|변경|채워|덮어).*(파일|문서|엑셀|표|셀|한글|내용)|(파일|문서|엑셀|표|셀).*(수정|고쳐|바꿔|편집|채워)/i],
    // "최근 수정한 파일을 보여줘"의 수정한은 편집 명령이 아니라 파일 조건이다.
    antiPatterns: [/(?:최근|마지막|오늘|어제|이번)?\s*(?:수정|변경)(?:한|된)?\s*(?:파일|문서|엑셀|한글).*(?:보여|목록|리스트|찾|검색|어디|알려)/i]
  },
  {
    label: 'Windows 데스크톱 제어',
    actionType: ActionType.DESKTOP_CONTROL,
    category: 'desktop',
    riskHint: 'interactive-desktop-control',
    patterns: [
      /(?:창|화면|버튼|메뉴|탭|입력란|체크박스|목록).*(?:클릭|눌러|선택|입력|타이핑|포커스|전환)/i,
      /(?:클릭|눌러|선택|입력|타이핑|포커스|전환).*(?:창|화면|버튼|메뉴|탭|입력란|체크박스|목록)/i,
      /(?:메모장|계산기|탐색기|브라우저|워드|엑셀|파워포인트|한글).*(?:열고|켜고|실행하고).*(?:입력|클릭|선택|눌러)/i,
      /(?:ui\s*automation|desktop\s*control|데스크톱\s*제어|화면\s*제어)/i
    ]
  },
  {
    label: '셸 명령 실행',
    actionType: ActionType.SHELL_EXECUTE,
    category: 'system',
    riskHint: 'system-command',
    // '실행'처럼 모호한 단어 대신 명확한 셸/시스템 지칭만 매칭한다.
    patterns: [/cmd|command\s*line|명령어|명령 프롬프트|터미널|파워\s*쉘|powershell|셸\b|쉘\b/i, /프로그램.*(실행|열어|켜)|(실행|열어|켜).*프로그램|앱.*(실행|열어)|스크립트.*실행/i]
  },
  {
    label: '브라우저 조사',
    actionType: ActionType.BROWSER_SEARCH,
    category: 'browser',
    riskHint: 'read-only-web',
    patterns: [
      /검색|조사|찾아|브라우저|뉴스|헤드라인|속보/i,
      /(?:(?:웹|인터넷|온라인).{0,50}조회|조회.{0,50}(?:웹|인터넷|온라인))/i
    ],
    antiPatterns: [namedTextWritePattern]
  },
  {
    label: '파일 목록 조회',
    actionType: ActionType.LIST_FILES,
    category: 'filesystem',
    riskHint: 'read-only-local',
    patterns: [/목록|리스트|나열|열거|\blist\b|폴더.*봐|파일.*보여/i],
    antiPatterns: [namedTextWritePattern, /파일.*(?:만들|생성|작성)|(?:만들|생성|작성).*파일/i]
  },
  {
    label: '파일 이동',
    actionType: ActionType.MOVE_FILE,
    category: 'filesystem',
    riskHint: 'local-change',
    patterns: [/이동|옮겨|move/i]
  },
  {
    label: '파일 열기',
    actionType: ActionType.SHELL_EXECUTE,
    category: 'system',
    riskHint: 'system-command',
    // 확장자와 열기 동사가 모두 있을 때만 셸(Start-Process)로 처리한다.
    patterns: [fileOpenPattern]
  },
  {
    label: '로컬 산출물 생성',
    actionType: ActionType.CREATE_FILE,
    category: 'document',
    riskHint: 'local-reversible',
    patterns: [/엑셀|xlsx|스프레드시트/i, /보고서|안내문|문서|메모/i, /만들|작성|생성|압축|묶어/i, namedTextWritePattern],
    antiPatterns: [/powershell\s*명령\s*실행|파워\s*쉘\s*명령\s*실행/i, fileOpenPattern]
  }
];

const outputFormatPatterns = [
  { format: 'xlsx', pattern: /엑셀|xlsx|스프레드시트/i },
  { format: 'hwp', pattern: /한글|hwp|hwpx|아래아/i },
  { format: 'pptx', pattern: /파워포인트|프레젠테이션|피피티|슬라이드|발표\s*자료|pptx?|keynote/i },
  { format: 'docx', pattern: /워드|docx|word\b/i },
  { format: 'pdf', pattern: /pdf/i },
  { format: 'png', pattern: /png|이미지\s*카드|뉴스\s*카드|시각화\s*카드/i },
  { format: 'zip', pattern: /zip|압축|묶음|번들/i },
  { format: 'txt', pattern: /메모|텍스트|txt/i }
];

const destinationPatterns = [
  { destination: 'email', pattern: /메일|이메일/i },
  { destination: 'kakaotalk', pattern: /카톡|카카오톡/i },
  { destination: 'band', pattern: /밴드/i },
  { destination: 'web', pattern: /웹|사이트|업로드/i }
];

const directoryHints = [
  { hint: 'downloads', pattern: /다운로드|download/i },
  { hint: 'desktop', pattern: /바탕화면|desktop/i },
  { hint: 'documents', pattern: /문서함|문서 폴더|documents/i },
  { hint: 'archive', pattern: /보관|archive/i },
  { hint: 'workspace', pattern: /작업공간|workspace/i }
];

const commandTailPattern = /\s*(해줘|해주세요|해|줘|만들어줘|작성해줘|보여줘|알려줘|정리해줘|전송해줘|공유해줘|옮겨줘|이동해줘)\s*$/i;
const fileNameStopwords = new Set(['이', '그', '저', '새', '신규', '엑셀', '보고서', '문서', '파일', '안내문', '메모', '다음', '이번', '오늘', '내일', '주', '월', '년', '로', '으로', '메일', '이메일', '카톡', '카카오톡', '밴드', '보관함', '폴더']);

export class IntentParser {
  parse(rawText, { requestId = 'request', createdAt = new Date().toISOString() } = {}) {
    const text = String(rawText ?? '').trim();
    if (!text) {
      return {
        actionType: null,
        title: '빈 명령',
        label: '빈 명령',
        confidence: 0,
        candidates: [],
        blockedReason: 'empty-command'
      };
    }
    const candidates = rules
      .map((rule) => {
        // A format keyword or a quoted title alone must not manufacture a write
        // intent when the request explicitly asks only to read a local document.
        if (rule.actionType === ActionType.CREATE_FILE
          && /\.(?:xlsx|pdf|txt|md)\b[^\n]{0,140}(?:읽|내용\s*확인)/iu.test(text)
          && !/(?:만들|작성|생성|수정|삭제|저장|옮겨|이동|보내|전송|업로드)/iu.test(text)) return null;
        const matches = matchingPatterns(rule, text);
        if (!matches.length) return null;
        const confidence = Math.min(0.95, 0.55 + matches.length * 0.25 + Math.min(text.length, 40) / 400);
        return createIntentCandidate({
          intentId: stableId('intent', `${requestId}:${rule.actionType}`, createdAt),
          label: rule.label,
          actionType: rule.actionType,
          category: rule.category,
          confidence,
          reasons: matches.map((pattern) => `keyword:${pattern.source}`),
          riskHint: rule.riskHint,
          slots: this.extractSlots(text, rule.actionType),
          entities: this.extractEntities(text),
          missingSlots: this.missingSlots(text, rule.actionType),
          complexity: this.complexity(text)
        });
      })
      .filter(Boolean)
      .sort((a, b) => {
        // A file extension or quoted sheet title is not a creation request.
        const explicitRead=candidate=>['엑셀 읽기','PDF 읽기','텍스트 파일 읽기'].includes(candidate.label)
          &&!/(?:만들|작성|생성|수정|삭제|저장|옮겨|이동|보내|전송|업로드)/iu.test(text);
        return Number(explicitRead(b))-Number(explicitRead(a))||b.confidence-a.confidence;
      });
    // 자기확장 폴백: 전용 도구로 분류되지 않는 요청은 셸(만능)로 즉석 처리한다.
    // planner가 안전한 셸 명령을 생성하고, 승인 카드에 실제 명령이 노출되므로 위험은 통제된다.
    const selected = candidates[0] ?? createIntentCandidate({
      intentId: stableId('intent', `${requestId}:shellfallback`, createdAt),
      label: '자동 처리(셸)',
      actionType: ActionType.SHELL_EXECUTE,
      category: 'system',
      confidence: 0.4,
      reasons: ['unclassified_shell_fallback'],
      riskHint: 'system-command',
      slots: this.extractSlots(text, ActionType.SHELL_EXECUTE),
      entities: this.extractEntities(text),
      missingSlots: [],
      complexity: this.complexity(text)
    });
    return {
      ...selected,
      title: selected.label,
      candidates: candidates.length ? candidates : [selected],
      unknown: candidates.length === 0
    };
  }

  extractSlots(text, actionType) {
    if(actionType===ActionType.CREATE_FILE&&/\.xlsx\b[\s\S]*\.pdf\b[\s\S]*(?:변환|내보내|출력)/iu.test(text)){
      const paths=[...text.matchAll(/["'“‘]([^"'”’\r\n]+\.(?:xlsx|pdf))["'”’]|([^\s"'“”‘’]+\.(?:xlsx|pdf))\b/giu)].map(match=>match[1]??match[2]);
      const sources=paths.filter(path=>path.toLowerCase().endsWith('.xlsx')),outputs=paths.filter(path=>path.toLowerCase().endsWith('.pdf'));
      return {workflow:'export-existing-xlsx-pdf',inputPath:sources.length===1?sources[0]:null,outputPath:outputs.length===1?outputs[0]:null};
    }
    // Archive/card commands commonly enumerate heterogeneous input files before
    // naming the final output. Prefer the explicit operation/output over the first
    // input extension (for example: "a.xlsx, b.md를 package.zip으로 압축").
    const explicitOutputFormat = /(?:\.zip\b|압축|묶음|번들)/iu.test(text)
      ? 'zip'
      : /(?:png\s*카드|이미지\s*카드|뉴스\s*카드|시각화\s*카드)/iu.test(text) ? 'png' : null;
    const outputFormat = explicitOutputFormat ?? outputFormatPatterns.find((item) => item.pattern.test(text))?.format;
    const destination = destinationPatterns.find((item) => item.pattern.test(text))?.destination;
    const fileName = this.extractFileName(actionType === ActionType.SEARCH_FILES
      ? parseSearchDirectoryRequest(text).remainingText : text, outputFormat);
    const dateHint = this.extractDateHint(text);
    const topic = this.extractTopic(text, fileName);
    if (actionType === ActionType.BROWSER_SEARCH) {
      const newsHeadlines = /(?:뉴스|헤드라인|속보)/iu.test(text);
      const registeredPublisher = findNewsPublisherFeed(text);
      const explicitPublisherFeed = /(?:게시자|언론사|원문사).{0,24}(?:RSS|피드)|(?:RSS|피드).{0,30}https:\/\//iu.test(text);
      const publisherFeed = explicitPublisherFeed || (newsHeadlines && Boolean(registeredPublisher));
      const newsArticleBody = /기사.{0,24}(?:본문|원문|읽|요약)|(?:본문|원문).{0,24}(?:뉴스|기사)/iu.test(text);
      const query = this.cleanupCommandText(text.replace(/검색|조사|조회|가져와|가져오|찾아|브라우저|알아봐|찾아봐|보여|요약|정리/giu, '')) || text;
      return {
        query,
        ...(newsHeadlines ? { newsQuery: this.extractNewsQuery(text) } : {}),
        ...(publisherFeed ? { feedUrl: text.match(/https:\/\/[^\s"'<>]+/iu)?.[0]?.replace(/[),.;]+$/u, '') ?? registeredPublisher?.feedUrl ?? null } : {}),
        ...(registeredPublisher && publisherFeed ? { publisherId: registeredPublisher.id } : {}),
        dateHint,
        topic,
        workflow: newsArticleBody ? 'news-article-read' : publisherFeed ? 'publisher-news-feed' : newsHeadlines ? 'news-headlines' : null,
        newsCategory: newsHeadlines ? this.extractNewsCategory(text) : null,
        maxResults: newsHeadlines || publisherFeed ? this.extractRequestedCount(text, 5) : null
      };
    }
    if (actionType === ActionType.LIST_FILES) {
      return { directoryHint: this.extractDirectoryHint(text) };
    }
    if (actionType === ActionType.SHELL_EXECUTE) {
      // 실제 셸 명령은 planner가 LLM으로 생성한다. 여기서는 원문을 넘긴다.
      return { rawCommand: text, dateHint, topic };
    }
    if (actionType === ActionType.DESKTOP_CONTROL) {
      return {
        rawCommand: text,
        appName: this.extractAppName(text),
        windowTitle: this.extractWindowTitle(text),
        topic
      };
    }
    if (actionType === ActionType.SEARCH_FILES) {
      if(/\.xlsx\b[^.\n]{0,140}(?:읽|내용\s*확인|셀[^.\n]{0,20}확인)/iu.test(text)){
        const sheet=/["'“‘]([^"'”’\r\n]{1,31})["'”’]\s*시트/iu.exec(text)?.[1]??/시트\s*["'“‘]([^"'”’\r\n]{1,31})["'”’]/iu.exec(text)?.[1];
        // Preserve explicit invalid ranges for the bounded reader to reject;
        // never quietly replace A0:B1 or A1 with the default region.
        const regionRequest=text.slice(text.toLowerCase().lastIndexOf('.xlsx')+5);
        const range=/\b[A-Z]{1,4}[0-9]+(?::[A-Z]{1,4}[0-9]+)?\b/iu.exec(regionRequest)?.[0]?.toUpperCase();
        return {rawCommand:text,fileName,dateHint,topic,workflow:'read-xlsx-file',sheetName:sheet??(/시트/iu.test(text)?'':undefined),range};
      }
      if(/\.pdf\b[^.\n]{0,80}(?:읽|내용\s*확인)/iu.test(text))return {rawCommand:text,fileName,dateHint,topic,workflow:'read-pdf-file'};
      const readTextFile = directTextFileReadPattern.test(text)
        || /(?:내용|본문|원문)\s*(?:을|를)?\s*(?:읽|확인)|(?:파일|문서)\s*(?:을|를)?\s*열어서\s*(?:내용|본문|원문)?\s*(?:을|를)?\s*읽/iu.test(text);
      return { rawCommand: text, fileName, dateHint, topic, workflow: readTextFile ? 'read-text-file' : null };
    }
    if (actionType === ActionType.SEND_EMAIL) {
      const recipient = this.extractRecipient(text, 'email');
      return {
        rawCommand: text,
        destination: 'email',
        recipient,
        recipientHint: recipient,
        fileName,
        dateHint,
        topic,
        externalTransfer: true
      };
    }
    if (actionType === ActionType.EDIT_DOCUMENT) {
      return { rawCommand: text, fileName, dateHint, topic };
    }
    if (actionType === ActionType.MOVE_FILE) {
      return {
        sourceHint: this.extractDirectoryHint(text, { role: 'source' }),
        destinationHint: this.extractDirectoryHint(text, { role: 'destination' }),
        fileName,
        dateHint,
        topic
      };
    }
    if (actionType === ActionType.UPLOAD_FILE) {
      return {
        destination,
        fileName,
        recipientHint: this.extractRecipient(text, destination),
        externalTransfer: true,
        dateHint,
        topic
      };
    }
    if (actionType === ActionType.CREATE_FILE) {
      const weatherReport = /(?:날씨|기상|예보)/iu.test(text)
        && /(?:통계|표|보고서|문서|시각)/iu.test(text)
        && outputFormat === 'hwp';
      return {
        outputFormat: outputFormat ?? 'txt',
        fileName,
        targetDirectoryHint: this.extractDirectoryHint(text),
        dateHint,
        topic,
        workflow: weatherReport ? 'weekly-weather-hwp-report' : null,
        weatherLocation: weatherReport ? this.extractWeatherLocation(text) : null
      };
    }
    return {};
  }

  extractNewsCategory(text) {
    const categories = [
      ['business', /경제|금융|증시|비즈니스/iu],
      ['technology', /기술|테크|\bIT\b|인공지능|\bAI\b/iu],
      ['science', /과학|우주|연구/iu],
      ['health', /건강|의료|의학/iu],
      ['entertainment', /연예|문화|영화|음악/iu],
      ['sports', /스포츠|축구|야구|농구/iu],
      ['world', /세계|국제|해외/iu]
    ];
    return categories.find(([, pattern]) => pattern.test(String(text ?? '')))?.[0] ?? 'top';
  }

  extractRequestedCount(text, fallback = 5) {
    const value = Number(String(text ?? '').match(/(?:뉴스|헤드라인|기사)?\s*(\d{1,2})\s*(?:개|건|꼭지)/iu)?.[1]);
    return Number.isFinite(value) ? Math.min(10, Math.max(1, Math.floor(value))) : fallback;
  }

  extractNewsQuery(text) {
    const cleaned = String(text ?? '')
      .replace(/(?:오늘|금일|현재|최신|실시간|핫)\s*/giu, ' ')
      .replace(/(?:뉴스|헤드라인|속보|기사)\s*\d{0,2}\s*(?:개|건|꼭지)?/giu, ' ')
      .replace(/(?:검색|조사|조회|가져와|가져오|찾아|알아봐|보여|요약|정리|해줘|해주세요|줘)/giu, ' ')
      .replace(/(?:경제|금융|증시|비즈니스|기술|테크|과학|건강|의료|연예|문화|스포츠|세계|국제|해외)\s*(?:분야|카테고리)?/giu, ' ');
    return this.cleanupCommandText(cleaned
      .replace(/(?:구글\s*)?RSS(?:\s*피드)?(?:에서|로|를|을)?/giu, ' ')
      .replace(/(?:주요|종합|공개|실제|가장|요즘)/giu, ' ')
      .replace(/(?:^|\s)(?:을|를|이|가|은|는|의|에서|으로|로)(?=\s|$)/gu, ' ')
      .replace(/[:：,;()[\]{}]+/g, ' '));
  }

  extractAppName(text) {
    const aliases = [
      ['notepad', /메모장|notepad/i],
      ['calculator', /계산기|calculator|calc/i],
      ['explorer', /파일\s*탐색기|탐색기|explorer/i],
      ['browser', /브라우저|크롬|chrome|웨일|whale|엣지|edge/i],
      ['word', /워드|word/i],
      ['excel', /엑셀|excel/i],
      ['powerpoint', /파워포인트|powerpoint|ppt/i],
      ['hwp', /한글|hwp|hwpx/i]
    ];
    return aliases.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  }

  extractWindowTitle(text) {
    const quoted = String(text).match(/["'“”‘’]([^"'“”‘’]{1,200})["'“”‘’]/u)?.[1];
    return quoted?.trim() || null;
  }

  extractEntities(text) {
    return {
      hasPhoneNumber: /\b01[016789]-?\d{3,4}-?\d{4}\b/.test(text),
      hasEmailAddress: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text),
      hasMoneyAmount: /\d+\s*(원|만원|달러|usd|krw)/i.test(text),
      hasDate: /\d{4}[-./]\d{1,2}[-./]\d{1,2}|오늘|내일|이번 주|다음 주/.test(text),
      mentionsExternalDestination: destinationPatterns.some((item) => item.pattern.test(text))
    };
  }

  missingSlots(text, actionType) {
    if (actionType === ActionType.UPLOAD_FILE && !destinationPatterns.some((item) => item.pattern.test(text))) {
      return ['destination'];
    }
    if (actionType === ActionType.MOVE_FILE && !/(에서|from).+(로|to)|옮겨|이동/.test(text)) {
      return ['sourcePath', 'destinationPath'];
    }
    return [];
  }

  complexity(text) {
    const connectors = text.match(/그리고|하고|또|후에|그다음|한 뒤|and|then/gi) ?? [];
    const matchedActions = rules.filter((rule) => matchingPatterns(rule, text).length > 0).map((rule) => rule.actionType);
    return {
      multiStepHint: connectors.length > 0,
      matchedActionTypes: [...new Set(matchedActions)],
      needsPlanDecomposition: connectors.length > 0 || new Set(matchedActions).size > 1
    };
  }

  extractFileName(text, outputFormat) {
    const artifactReference = String(text).match(/jarvis-artifact:\/\/\d+\/([^\s"'<>]+)/iu)?.[1];
    if (artifactReference) {
      try {
        const decoded = decodeURIComponent(artifactReference);
        const candidate = decoded.split(/[\\/]/).filter(Boolean).at(-1);
        if (/^[^\\/:*?"<>|]+\.(?:xlsx|docx|pptx|ppt|pdf|txt|hwp|hwpx|png|zip)$/iu.test(candidate ?? '')) {
          return candidate;
        }
      } catch {
        // Invalid artifact references are rejected later by the exact attachment parser.
      }
    }
    const extension = text.match(/([가-힣\w-]+)\.(xlsx|docx|pptx|ppt|pdf|txt|hwp|hwpx|md|csv|json|html|png|zip)\b/i);
    if (extension) return extension[0];
    const quoted = text.match(/["'“”](.+?)["'“”]/)?.[1];
    if (quoted) return this.normalizeFileName(quoted, outputFormat);
    const descriptor = text.match(/((?:[가-힣\w-]+\s*){1,5})(파일|문서|보고서|엑셀|안내문|메모)/);
    if (descriptor) {
      const phrase = descriptor[1]
        .trim()
        .split(/\s+/)
        .map((word) => this.normalizeFileToken(word))
        .filter((word) => word && !fileNameStopwords.has(word))
        .slice(-3)
        .join('-');
      if (phrase) return this.normalizeFileName(phrase, outputFormat);
    }
    return null;
  }

  normalizeFileName(name, outputFormat) {
    const cleaned = String(name ?? '')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!cleaned) return null;
    if (/\.(xlsx|docx|pptx|ppt|pdf|txt|hwp|hwpx|png|zip)$/i.test(cleaned)) return cleaned;
    return `${cleaned}.${outputFormat ?? 'txt'}`;
  }

  extractDirectoryHint(text, { role = 'any' } = {}) {
    if (role === 'destination') {
      const destinationWord = text
        .split(/\s+/)
        .map((word) => word.replace(/(으로|로|에)$/u, '').replace(/(폴더|문서함)$/u, ''))
        .filter((word) => word && !/(에서|부터)$/.test(word))
        .reverse()
        .find((word) => directoryHints.some((item) => item.pattern.test(word)));
      if (destinationWord) {
        const matched = directoryHints.find((item) => item.pattern.test(destinationWord));
        if (matched) return matched.hint;
      }
    }
    if (role === 'source') {
      const directional = text.match(/([가-힣\w-]+)\s*(?:폴더|문서함)?(?:에서|부터)/);
      if (directional) {
        const matched = directoryHints.find((item) => item.pattern.test(directional[1]));
        if (matched) return matched.hint;
      }
    }
    return directoryHints.find((item) => item.pattern.test(text))?.hint ?? 'workspace';
  }

  extractRecipient(text, destination) {
    if (!destination) return null;
    const recipient = text.match(/([가-힣\w.-]+)\s*(?:에게|한테|로|으로)\s*(?:메일|이메일|카톡|카카오톡|밴드)/i)?.[1];
    if (recipient && !destinationPatterns.some((item) => item.pattern.test(recipient))) return recipient;
    return null;
  }

  extractDateHint(text) {
    return text.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}|오늘|내일|이번 주|다음 주|이번 달|다음 달/)?.[0] ?? null;
  }

  extractTopic(text, fileName) {
    if (fileName) return fileName.replace(/\.(xlsx|docx|pptx|ppt|pdf|txt|hwp|hwpx|png|zip)$/i, '');
    const cleaned = this.cleanupCommandText(text.replace(/검색|조사|찾아|브라우저|목록|리스트|파일|폴더|보여|만들|작성|생성|전송|공유|업로드/gi, ''));
    return cleaned || null;
  }

  cleanupCommandText(text) {
    return String(text ?? '').replace(commandTailPattern, '').replace(/\s+/g, ' ').trim();
  }

  normalizeFileToken(word) {
    const raw = String(word ?? '').trim();
    if (!raw || /(에게|한테)$/.test(raw) || /\d+\s*(원|만원|달러|usd|krw)$/i.test(raw)) return null;
    const normalized = raw.replace(/(으로|에게|한테|에서|부터|까지|을|를|은|는|이|가|에|로)$/u, '');
    if (directoryHints.some((item) => item.pattern.test(normalized))) return null;
    if (/(검색|조사|찾아|만들|작성|생성|전송|공유|옮겨|이동)(하고)?$/u.test(normalized)) return null;
    return normalized;
  }

  extractWeatherLocation(text) {
    const marked = String(text).match(/(?:지역|장소|도시|location)\s*[:：=]\s*["'“”]?([^\]\[;,\n"'“”]{1,80})/iu)?.[1];
    if (marked) return marked.replace(/(?:이번\s*주|향후\s*7일|날씨|예보|통계|보고서|문서).*$/u, '').trim() || null;
    const administrative = String(text).match(/(?:^|\s)([가-힣]{2,16}(?:특별자치도|특별자치시|특별시|광역시|도|시|군|구))(?:의|에서|\s|$)/u)?.[1];
    if (administrative) return administrative;
    const known = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '제주', '수원', '성남', '고양', '용인', '창원', '청주', '전주', '천안', '김해', '포항'];
    return known.find((name) => new RegExp(`(?:^|\\s|["'“”])${name}(?:의|에서|\\s|["'“”]|$)`, 'u').test(String(text))) ?? null;
  }
}

function matchingPatterns(rule, text) {
  const matches = rule.patterns.filter((pattern) => pattern.test(text));
  const requiredMatches = rule.matchMode === 'all'
    ? matches.length === rule.patterns.length
    : matches.length > 0;
  if (!requiredMatches) return [];
  // Exclusion patterns prevent contextual words from creating a competing intent.
  if (Array.isArray(rule.antiPatterns) && rule.antiPatterns.some((pattern) => pattern.test(text))) return [];
  return matches;
}
