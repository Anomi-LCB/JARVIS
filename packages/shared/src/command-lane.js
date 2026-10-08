const stageDefinitions = Object.freeze([
  {
    id: 'live-data',
    label: '최신 정보 조회',
    weight: 3,
    pattern: /(?:날씨|기상|예보|뉴스|주가|환율|교통|미세먼지|실시간|최신\s*(?:정보|현황)|현재\s*(?:가격|상태)|항공권|항공편|기차표|열차표)/iu
  },
  {
    id: 'account-data',
    label: '연결 계정 자료 조회',
    weight: 4,
    pattern: /(?:(?:gmail|구글\s*메일|메일함|받은편지함|google\s*(?:calendar|캘린더|drive|드라이브)|구글\s*(?:캘린더|드라이브)|은행|계좌|거래내역).*(?:읽|확인|조회|가져|동기화|분석|정리|연동|불러)|(?:읽|확인|조회|가져|동기화|분석|정리|연동|불러).*(?:gmail|구글\s*메일|메일함|받은편지함|google\s*(?:calendar|캘린더|drive|드라이브)|구글\s*(?:캘린더|드라이브)|은행|계좌|거래내역))/iu
  },
  {
    id: 'transaction',
    label: '예약·구매·금융 거래',
    weight: 5,
    pattern: /(?:(?:항공권|항공편|기차표|열차표|호텔|숙소|상품|제품|가전|프린터|휴대폰|장바구니|계좌|돈|자금).*(?:예약|예매|구매|주문|결제|송금|이체|발권)|(?:예약|예매|구매|주문|결제|송금|이체|발권).*(?:항공권|항공편|기차표|열차표|호텔|숙소|상품|제품|가전|프린터|휴대폰|장바구니|계좌|돈|자금))/iu
  },
  {
    id: 'health-device',
    label: '건강 기기 자료',
    weight: 4,
    pattern: /(?:(?:워치|웨어러블|심박(?:수)?|수면\s*데이터|건강\s*데이터|걸음\s*수).*(?:읽|확인|조회|가져|동기화|분석|비교)|(?:읽|확인|조회|가져|동기화|분석|비교).*(?:워치|웨어러블|심박(?:수)?|수면\s*데이터|건강\s*데이터|걸음\s*수))/iu
  },
  {
    id: 'physical-device',
    label: '스마트홈·물리 기기 제어',
    weight: 5,
    pattern: /(?:(?:스마트\s*홈|난방|보일러|조명|도어락|현관문|에어컨|온도조절기).*(?:켜|끄|열어|잠가|설정|작동|도착하면)|(?:켜|끄|열어|잠가|설정|작동).*(?:스마트\s*홈|난방|보일러|조명|도어락|현관문|에어컨|온도조절기))/iu
  },
  {
    id: 'safety-sensitive',
    label: '민감·고위험 작업 사전 점검',
    weight: 5,
    pattern: /(?:영구\s*삭제|(?:계좌|금융|세금|건강|의료|심박|수면\s*데이터|약\s*(?:복용|용량|중단)|응급|긴급(?:전화|\s*상황|\s*메시지)|연락처\s*출처|외부\s*발신|전화|도어락|현관문|난방|보일러|차량|접근성|권한|민감정보|개인정보|위치\s*(?:정보|데이터)|health\s*connect|헬스\s*커넥트).{0,56}(?:확인|분석|공유|전송|보내|허용|부여|조작|작동|설정|삭제|처리|중단|변경|저장|자동|보고|작성|계산|추출|비교|정리|검토|표시|판단|안내|기록|제안|준비|연결|연동)|(?:예약|예매|구매|주문|결제|송금|이체|취소|재예약|발권|게시|배포|발송|전송|영구\s*삭제)|(?:기본\s*브랜치|운영).{0,24}(?:배포|적용|삭제)|(?:모든|전체).{0,20}(?:연락처|권한|채널).{0,20}(?:보내|허용|전송|게시|발송)|(?:승인|허가).{0,16}(?:지어|추측|위조)|(?:완료|성공).{0,10}(?:표시|보고).{0,18}(?:검증|실제|근거))/iu
  },
  {
    id: 'calendar-collaboration',
    label: '일정·참석자 조정',
    weight: 4,
    pattern: /(?:참석자|회의.*(?:시간|후보|초대)|초대장|초대\s*(?:발송|후보)|시간대|이동\s*여유|주최자|반복\s*일정|일정\s*(?:변경|충돌|조정)|캘린더.{0,48}(?:조회|확인|불러|읽|등록(?!할\s*초안|하지(?:는)?\s*(?:마|말))|변경|취소|삭제)|(?:조회|확인|불러|읽|등록(?!할\s*초안|하지(?:는)?\s*(?:마|말))|변경|취소|삭제).{0,48}캘린더)/iu
  },
  {
    id: 'administrative-workflow',
    label: '행정 서류·공식 안내',
    weight: 4,
    pattern: /(?:행정\s*(?:신청|서류)|공식\s*안내|신청\s*(?:서류|항목)|제출.*(?:중단|보류|하지\s*않)|민감정보)/iu
  },
  {
    id: 'mission-continuity',
    label: '중단 작업 복구·연속성',
    weight: 4,
    pattern: /(?:중단했던|중단된|미완료\s*작업|재개|복구|검증된\s*결과|결정과\s*이유)/iu
  },
  {
    id: 'research',
    label: '자료 조사',
    weight: 2,
    pattern: /(?:웹|인터넷|브라우저).*(?:검색|조사|찾)|(?:검색|조사|찾아봐|알아봐).*(?:웹|인터넷|자료|정보)|(?:검색|조사|찾아봐|알아봐|주요\s*보도|공식\s*(?:안내|발표)|본문.*(?:해석|원어)|원어|역사\s*배경|원문\s*출처|연구\s*노트)/iu
  },
  {
    id: 'analysis',
    label: '분석 및 시각화',
    weight: 2,
    pattern: /(?:통계|분석|집계|비교|요약|시각화|차트|그래프|도표|표\s*(?:로|형태|작성))/iu
  },
  {
    id: 'document',
    label: '문서 제작',
    weight: 2,
    pattern: /(?:(?:한글|hwp|hwpx|엑셀|xlsx|스프레드시트|워드|docx|파워포인트|pptx?|pdf|보고서|문서|표).*(?:작성|만들|생성|저장)|(?:작성|만들|생성|저장).*(?:한글|hwp|hwpx|엑셀|xlsx|스프레드시트|워드|docx|파워포인트|pptx?|pdf|보고서|문서|표))/iu
  },
  {
    id: 'external-transfer',
    label: '외부 전송',
    weight: 4,
    pattern: /(?:(?:메일|이메일|구글\s*메일|gmail|카톡|카카오톡|밴드|드라이브).*(?:보내|전송|발송|공유|업로드|첨부)|(?:보내|전송|발송|공유|업로드|첨부).*(?:메일|이메일|구글\s*메일|gmail|카톡|카카오톡|밴드|드라이브))/iu
  },
  {
    id: 'desktop-control',
    label: '화면 조작',
    weight: 4,
    pattern: /(?:(?:창|화면|버튼|메뉴|탭|입력란|체크박스|프로그램|앱).*(?:클릭|누르|선택|입력|타이핑|포커스|전환|실행)|(?:클릭|누르|선택|입력|타이핑|포커스|전환).*(?:창|화면|버튼|메뉴|탭|입력란|체크박스)|(?:앱|브라우저|프로그램).{0,32}설정.{0,32}(?:열|바꾸|변경|꺼|끄|켜|저장))/iu
  },
  {
    id: 'system-command',
    label: '시스템 명령',
    weight: 4,
    pattern: /(?:powershell|파워\s*쉘|터미널|명령\s*프롬프트|cmd\b|셸\s*명령|쉘\s*명령|스크립트\s*실행)/iu
  },
  {
    id: 'bulk-file',
    label: '대량 파일 무결성 처리',
    weight: 4,
    pattern: /(?:(?:\d[\d,]*|수백|수천|수만|대량|여러|전체)\s*(?:개\s*)?(?:파일|문서|레코드)|(?:파일|문서).*(?:sha-?256|해시|중복|압축|zip|manifest|매니페스트|일괄))/iu
  }
]);

const alwaysMissionStages = new Set(['live-data', 'account-data', 'transaction', 'health-device', 'physical-device', 'safety-sensitive', 'calendar-collaboration', 'administrative-workflow', 'mission-continuity', 'external-transfer', 'desktop-control', 'system-command', 'bulk-file']);
const sequencePattern = /(?:그리고|그\s*다음|다음으로|한\s*뒤|고\s*나서|후에|동시에|\bthen\b|\band\b)/iu;
const predicateSequencePattern = /(?:검색하|조사하|찾|읽|확인하|분석하|정리하|작성하|만들|생성하|저장하|수정하|이동하|삭제하|실행하|클릭하|전송하|보내|공유하|업로드하|계산하|추출하|검증하|변환하|선택하|정렬하)(?:고|서|여서)\s+/iu;
const operationPattern = /(?:검색|조사|찾|확인|분석|통계|정리|작성|만들|생성|저장|수정|이동|삭제|실행|클릭|전송|보내|공유|업로드|읽|계산|추출|검증|변환|걸러|조인|피벗|대사|마스킹|정렬|정규화|치환|선택|펼쳐|제거)/giu;

function hasSeparatedOperations(text) {
  let quote = null;
  let visible = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\' && [quote, '\\'].includes(text[index + 1])) { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    const closer = ({ "'": "'", '"': '"', '“': '”', '‘': '’' })[character];
    if (closer) { quote = closer; continue; }
    visible += character;
  }
  return visible.split(/[;；\n]/u).filter((clause) => (clause.match(operationPattern) ?? []).length > 0).length >= 2;
}

export function classifyCommandLane(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) {
    return commandLaneResult({ text, lane: 'task', stages: [], reasonCodes: ['empty-command'], score: 0 });
  }

  const stages = stageDefinitions
    .filter((definition) => definition.pattern.test(text))
    .map(({ id, label, weight }) => ({ id, label, weight }));
  const stageIds = new Set(stages.map((stage) => stage.id));
  const operationCount = new Set((text.match(operationPattern) ?? []).map((item) => item.toLowerCase())).size;
  const hasSequence = sequencePattern.test(text) || predicateSequencePattern.test(text) || hasSeparatedOperations(text);
  const reasonCodes = [];

  if ([...stageIds].some((stageId) => alwaysMissionStages.has(stageId))) {
    reasonCodes.push('long-running-or-privileged-stage');
  }
  if (stageIds.has('safety-sensitive')) {
    reasonCodes.push('safety-sensitive-action');
  }
  if (operationCount >= 2 && text.length >= 48) {
    reasonCodes.push('compound-natural-language-workflow');
  }
  if (stageIds.has('research') && (stageIds.has('analysis') || stageIds.has('document'))) {
    reasonCodes.push('research-to-artifact-pipeline');
  }
  if (stageIds.has('analysis') && stageIds.has('document')) {
    reasonCodes.push('analysis-to-document-pipeline');
  }
  if (hasSequence && operationCount >= 2) {
    reasonCodes.push('explicit-multi-step-sequence');
  }
  if (stages.length >= 3) {
    reasonCodes.push('multi-capability-workflow');
  }
  if (stageIds.has('bulk-file')) {
    reasonCodes.push('bulk-file-workflow');
  }

  const lane = reasonCodes.length > 0 ? 'mission' : 'task';
  const score = stages.reduce((total, stage) => total + stage.weight, 0)
    + (hasSequence ? 2 : 0)
    + Math.max(0, operationCount - 1);
  return commandLaneResult({ text, lane, stages, reasonCodes, score, operationCount, hasSequence });
}

export function commandRequiresMission(rawText) {
  return classifyCommandLane(rawText).lane === 'mission';
}

function commandLaneResult({ text, lane, stages, reasonCodes, score, operationCount = 0, hasSequence = false }) {
  return {
    routingVersion: 'jarvis-command-lane-v1',
    lane,
    asynchronous: lane === 'mission',
    score,
    stages,
    stageIds: stages.map((stage) => stage.id),
    reasonCodes,
    operationCount,
    hasSequence,
    commandLength: text.length,
    userSummary: lane === 'mission'
      ? `${stages.length ? stages.map((stage) => stage.label).join(' → ') : '입력한 복합'} 작업으로 자동 분리합니다.`
      : '즉시 실행 가능한 빠른 작업입니다.'
  };
}
