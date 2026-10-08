// Fifty synthetic, single-command workflows with acceptance criteria fixed before execution.
// Each command deliberately includes observation, transformation, artifact production,
// rediscovery/re-read, and cross-check/archive or delivery stages.

const workflow = (...steps) => `다음 작업을 순서대로 완료해줘. ${steps.map((step, index) => `${index + 1}) ${step}`).join(' ')}`;
const textFile = (path, contains = [], absent = []) => ({ path, type: 'text', contains, ...(absent.length ? { absent } : {}) });
const officeFile = (path, type, contains = [], extra = {}) => ({ path, type, contains, ...extra });
const pngFile = (path) => ({ path, type: 'png', width: 1200, height: 675 });
const zipFile = (path, entries) => ({ path, type: 'zip', entries });

export const cases = [
  {
    id: '01',
    title: '오늘의 핫뉴스 수집·재검증·뉴스카드·자기메일 전송',
    category: 'live-web-email',
    allowExternalSend: true,
    inputs: {},
    command: workflow(
      '오늘 날짜 기준 국내외 주요 핫뉴스를 웹에서 검색하고 서로 다른 신뢰 가능한 출처 URL이 있는 기사 세 건을 골라.',
      '각 기사의 제목·핵심 사실·왜 중요한지·실제로 읽은 출처 URL을 hot-news-report.md에 저장해.',
      'workspace에서 hot-news-report.md를 파일명으로 다시 찾아 정확히 한 개가 생성됐는지 확인해.',
      '찾은 파일을 다시 읽고 기사 세 건과 URL 세 개가 빠짐없이 있는지 교차확인해.',
      '확인된 세 기사만 사용해 cards/news-01.png, cards/news-02.png, cards/news-03.png를 1200x675 뉴스카드로 만들어.',
      '보고서와 카드 세 장을 hot-news-package.zip으로 묶고 ZIP 안의 네 파일을 확인해.',
      '보고서와 카드 세 장을 내 구글 메일로 제목 [JARVIS-50:C01] 오늘의 핫뉴스 검증본으로 한 번만 보내.',
      'SMTP 수락과 첨부 4개가 확인된 경우에만 완료로 보고해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('hot-news-report.md', ['핵심', '중요', 'http']),
        pngFile('cards/news-01.png'), pngFile('cards/news-02.png'), pngFile('cards/news-03.png'),
        zipFile('hot-news-package.zip', ['hot-news-report.md', 'news-01.png', 'news-02.png', 'news-03.png'])
      ],
      liveWeb: {
        requiredTool: 'news.fetchHeadlines', minUrls: 3, minDomains: 2, minNewsItems: 3,
        publishedOnLocalDate: true, artifactPath: 'hot-news-report.md', minArtifactObservedUrls: 3,
        minArtifactNewsArticleUrls: 3, minPublisherDomains: 2
      },
      email: {
        subjectContains: '[JARVIS-50:C01]',
        attachmentCount: 4,
        attachmentPaths: ['hot-news-report.md', 'cards/news-01.png', 'cards/news-02.png', 'cards/news-03.png'],
        idempotencyKey: 'jarvis-complex-workflow-50-C01-v1'
      }
    }
  },
  {
    id: '02',
    title: 'MDN Promise 동시성 비교 패키지',
    category: 'live-web-research',
    inputs: {},
    command: workflow(
      'MDN의 Promise.all과 Promise.allSettled 공식 문서를 각각 웹에서 직접 읽어.',
      '두 API의 반환값·실패 처리·적합한 사용 사례를 비교해 promise-guide.md에 공식 URL과 함께 저장해.',
      '같은 사실을 비교 시트와 선택 기준 시트로 나눈 promise-matrix.xlsx를 만들어.',
      'workspace에서 promise-guide.md와 promise-matrix.xlsx를 다시 찾아 두 파일이 모두 있는지 확인해.',
      'promise-guide.md를 다시 읽어 두 API 이름과 공식 URL 두 개를 교차확인해.',
      '핵심 선택 기준 두 개를 cards/promise-all.png와 cards/promise-allsettled.png 카드로 만들어.',
      '네 결과물을 promise-package.zip으로 묶고 항목 수를 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('promise-guide.md', ['Promise.all', 'Promise.allSettled', 'developer.mozilla.org', 'https://']),
        officeFile('promise-matrix.xlsx', 'xlsx', ['Promise.all', 'Promise.allSettled'], { sheets: ['비교', '선택 기준'] }),
        pngFile('cards/promise-all.png'), pngFile('cards/promise-allsettled.png'),
        zipFile('promise-package.zip', ['promise-guide.md', 'promise-matrix.xlsx', 'promise-all.png', 'promise-allsettled.png'])
      ],
      liveWeb: {
        requiredTool: 'browser.search', minUrls: 2, minDomains: 1,
        requiredDomains: ['developer.mozilla.org'], artifactPath: 'promise-guide.md', minArtifactObservedUrls: 2,
        minDirectOfficialReads: 2
      }
    }
  },
  {
    id: '03',
    title: 'Python asyncio 취소·타임아웃 운영자료',
    category: 'live-web-research',
    inputs: {},
    command: workflow(
      'Python 공식 문서에서 asyncio Task 취소와 timeout 관련 내용을 각각 직접 읽어.',
      '취소 전파·TimeoutError·안전한 정리 절차를 asyncio-operations.docx에 공식 URL과 함께 정리해.',
      '운영자 교육용 asyncio-briefing.pptx를 정확히 5장으로 만들어 개요·취소·타임아웃·정리·체크리스트 순으로 구성해.',
      '두 산출물을 workspace에서 다시 검색해 이름과 개수를 확인해.',
      '원문 관찰과 두 문서의 핵심 용어를 교차확인해.',
      '두 파일을 asyncio-package.zip으로 묶고 ZIP 항목 두 개를 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('asyncio-operations.docx', 'docx', ['asyncio', 'TimeoutError', '취소', 'https://']),
        officeFile('asyncio-briefing.pptx', 'pptx', ['asyncio', '취소', '타임아웃', '체크리스트'], { slides: 5 }),
        zipFile('asyncio-package.zip', ['asyncio-operations.docx', 'asyncio-briefing.pptx'])
      ],
      liveWeb: {
        requiredTool: 'browser.search', minUrls: 2, minDomains: 1,
        requiredDomains: ['docs.python.org'], artifactPath: 'asyncio-operations.docx', minArtifactObservedUrls: 2,
        minDirectOfficialReads: 1
      }
    }
  },
  {
    id: '04',
    title: 'Node.js 파일 API 공식문서 검토 묶음',
    category: 'live-web-research',
    inputs: {},
    command: workflow(
      'Node.js 공식 문서에서 fs와 fs/promises API 설명을 웹으로 직접 읽어.',
      '콜백 방식과 Promise 방식의 오류 처리·자원 정리·선택 기준을 node-file-api.md에 실제 URL과 함께 기록해.',
      '검토 기준과 권장 방식을 두 시트로 나눈 node-file-api.xlsx를 만들어.',
      'workspace에서 두 파일을 다시 검색하고 node-file-api.md를 다시 읽어.',
      '공식 문서에서 관찰한 API 이름과 보고서·엑셀 내용을 교차확인해.',
      '두 산출물을 node-file-api-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('node-file-api.md', ['fs', 'Promise', 'nodejs.org', 'https://']),
        officeFile('node-file-api.xlsx', 'xlsx', ['콜백', 'Promise'], { sheets: ['검토 기준', '권장 방식'] }),
        zipFile('node-file-api-package.zip', ['node-file-api.md', 'node-file-api.xlsx'])
      ],
      liveWeb: {
        requiredTool: 'browser.search', minUrls: 2, minDomains: 1,
        requiredDomains: ['nodejs.org'], artifactPath: 'node-file-api.md', minArtifactObservedUrls: 2,
        minDirectOfficialReads: 1
      }
    }
  },
  {
    id: '05',
    title: 'PowerShell 파일 무결성 운영지침',
    category: 'live-web-research',
    inputs: {},
    command: workflow(
      'Microsoft Learn의 Get-FileHash와 Get-Content 공식 문서를 각각 웹에서 직접 읽어.',
      '파일 읽기와 SHA256 무결성 확인 절차를 powershell-integrity.hwpx 한글 문서에 실제 URL과 함께 작성해.',
      '실행 전·실행·판정·오류 대응을 정확히 4장으로 구성한 powershell-integrity.pptx를 만들어.',
      '두 파일을 workspace에서 다시 찾아 형식과 개수를 확인해.',
      '공식 문서 관찰과 두 산출물의 cmdlet 이름을 교차확인해.',
      '두 파일을 powershell-integrity-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('powershell-integrity.hwpx', 'hwpx', ['Get-FileHash', 'Get-Content', 'SHA256', 'https://']),
        officeFile('powershell-integrity.pptx', 'pptx', ['Get-FileHash', '오류 대응'], { slides: 4 }),
        zipFile('powershell-integrity-package.zip', ['powershell-integrity.hwpx', 'powershell-integrity.pptx'])
      ],
      liveWeb: {
        requiredTool: 'browser.search', minUrls: 2, minDomains: 1,
        requiredDomains: ['learn.microsoft.com'], artifactPath: 'powershell-integrity.hwpx', minArtifactObservedUrls: 2,
        minDirectOfficialReads: 2
      }
    }
  },
  {
    id: '06',
    title: '세 런타임 공식문서 교차비교',
    category: 'live-web-research',
    inputs: {},
    command: workflow(
      'MDN Promise.allSettled, Python asyncio.gather, Node.js fs/promises 공식 자료를 웹에서 각각 직접 읽어.',
      '세 생태계의 비동기 실패 처리와 결과 수집 차이를 runtime-resilience.md에 실제 URL 세 개와 함께 비교해.',
      '생태계·실패 모델·부분 성공·권장 상황 열을 가진 runtime-resilience.xlsx를 만들어.',
      'workspace에서 두 결과물을 다시 검색하고 markdown 파일을 다시 읽어.',
      '세 도메인·세 API 이름·엑셀 행 세 개가 일치하는지 교차확인해.',
      '두 결과물을 runtime-resilience-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('runtime-resilience.md', ['Promise.allSettled', 'asyncio.gather', 'fs/promises', 'https://']),
        officeFile('runtime-resilience.xlsx', 'xlsx', ['Promise.allSettled', 'asyncio.gather', 'fs/promises'], { sheets: ['비교'] }),
        zipFile('runtime-resilience-package.zip', ['runtime-resilience.md', 'runtime-resilience.xlsx'])
      ],
      liveWeb: {
        requiredTool: 'browser.search', minUrls: 3, minDomains: 3,
        requiredDomains: ['developer.mozilla.org', 'docs.python.org', 'nodejs.org'],
        artifactPath: 'runtime-resilience.md', minArtifactObservedUrls: 3, minDirectOfficialReads: 3
      }
    }
  },
  {
    id: '07',
    title: '월간 매출 분석·시각화·보관',
    category: 'data-office',
    inputs: {
      'sales.csv': 'month,product,quantity,unit_price\n2026-07,노트,10,2500\n2026-07,펜,20,1000\n2026-08,노트,12,2500\n2026-08,펜,15,1000\n'
    },
    command: workflow(
      'sales.csv를 UTF-8로 읽고 각 행 매출과 월별 합계를 계산해.',
      '행별 계산과 월별 요약을 두 시트로 나눈 sales-analysis.xlsx를 만들고 총매출 90000원을 포함해.',
      '월별 합계와 증감 해설을 sales-analysis.md에 저장해.',
      'workspace에서 두 산출물을 다시 검색하고 markdown 파일을 다시 읽어.',
      '원본 네 행·월별 합계 45000원·전체 합계 90000원이 일치하는지 교차확인해.',
      '핵심 수치 두 개를 cards/sales-july.png와 cards/sales-august.png로 만들고 모든 결과물을 sales-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('sales-analysis.xlsx', 'xlsx', ['90000'], { sheets: ['행별 계산', '월별 요약'] }),
        textFile('sales-analysis.md', ['45000', '90000']),
        pngFile('cards/sales-july.png'), pngFile('cards/sales-august.png'),
        zipFile('sales-package.zip', ['sales-analysis.xlsx', 'sales-analysis.md', 'sales-july.png', 'sales-august.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '08',
    title: '두 창고 재고 통합·발주자료',
    category: 'data-office',
    inputs: {
      'warehouse-a.csv': 'item,stock,reorder_point\n키보드,3,5\n마우스,8,5\n모니터,2,4\n',
      'warehouse-b.csv': 'item,stock,reorder_point\n키보드,4,5\n마우스,1,5\n모니터,3,4\n'
    },
    command: workflow(
      'warehouse-a.csv와 warehouse-b.csv를 모두 읽고 품목별 재고를 합산해.',
      '통합 재고와 재주문 판단을 inventory.xlsx의 통합 재고·판정 근거 두 시트에 작성해.',
      '통합 수량 키보드 7, 마우스 9, 모니터 5를 inventory-summary.md에 기록해.',
      '두 결과물을 workspace에서 다시 찾고 markdown을 다시 읽어.',
      '두 원본의 품목별 합과 결과가 일치하는지 교차확인해.',
      'inventory.xlsx와 inventory-summary.md를 inventory-package.zip으로 묶고 항목 두 개를 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('inventory.xlsx', 'xlsx', ['키보드', '마우스', '모니터'], { sheets: ['통합 재고', '판정 근거'] }),
        textFile('inventory-summary.md', ['키보드', '7', '마우스', '9', '모니터', '5']),
        zipFile('inventory-package.zip', ['inventory.xlsx', 'inventory-summary.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '09',
    title: '업무 우선순위 정제·보고서',
    category: 'data-office',
    inputs: {
      'tasks.json': '[{"task":"계약 검토","priority":1,"done":false,"owner":"김하늘"},{"task":"배너 제작","priority":3,"done":false,"owner":"이지민"},{"task":"결제 확인","priority":2,"done":true,"owner":"박서준"},{"task":"장소 예약","priority":2,"done":false,"owner":"김하늘"}]'
    },
    command: workflow(
      'tasks.json을 읽고 done이 false인 항목만 priority 오름차순으로 정렬해.',
      '유효한 JSON 배열을 open-tasks.json에 저장하고 완료된 결제 확인은 제외해.',
      '담당자별 미완료 수와 우선 실행안을 task-brief.docx로 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 open-tasks.json을 다시 읽어 JSON 구문을 확인해.',
      '원본의 미완료 세 건과 결과의 세 건이 일치하는지 교차확인해.',
      '두 결과물을 task-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        { path: 'open-tasks.json', type: 'json', rootType: 'array', length: 3, contains: ['계약 검토', '장소 예약', '배너 제작'], absent: ['결제 확인'] },
        officeFile('task-brief.docx', 'docx', ['김하늘', '이지민', '미완료']),
        zipFile('task-package.zip', ['open-tasks.json', 'task-brief.docx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '10',
    title: '서비스 장애 로그 원인분석',
    category: 'operations',
    inputs: {
      'service.log': '2026-09-03T09:00:00Z INFO boot ok\n2026-09-03T09:05:10Z WARN db latency=820ms\n2026-09-03T09:05:12Z ERROR checkout timeout request=r1\n2026-09-03T09:06:00Z WARN db latency=910ms\n2026-09-03T09:06:04Z ERROR checkout timeout request=r2\n2026-09-03T09:10:00Z INFO recovered\n'
    },
    command: workflow(
      'service.log를 읽고 WARN과 ERROR의 시각·유형·상관관계를 분석해.',
      '사건 타임라인·가능 원인·근거·복구 확인을 incident-report.md에 저장해.',
      '로그 수준별 건수와 주요 지연값을 incident-metrics.xlsx에 작성해.',
      '두 결과물을 workspace에서 다시 찾고 incident-report.md를 다시 읽어.',
      'WARN 2건·ERROR 2건·최대 지연 910ms·10시 이전 복구가 원본과 일치하는지 교차확인해.',
      '핵심 사건과 복구를 cards/incident.png와 cards/recovery.png로 만들고 네 결과물을 incident-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('incident-report.md', ['WARN', 'ERROR', '910ms', 'recovered']),
        officeFile('incident-metrics.xlsx', 'xlsx', ['910'], { sheets: ['로그 지표'] }),
        pngFile('cards/incident.png'), pngFile('cards/recovery.png'),
        zipFile('incident-package.zip', ['incident-report.md', 'incident-metrics.xlsx', 'incident.png', 'recovery.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '11',
    title: '고객 피드백 주제분석',
    category: 'data-office',
    inputs: {
      'feedback.csv': 'id,rating,comment\n1,5,검색이 빠르고 편리함\n2,2,로그인이 자주 풀림\n3,4,검색 결과가 정확함\n4,1,결제 오류가 발생함\n5,3,화면은 좋지만 알림이 많음\n'
    },
    command: workflow(
      'feedback.csv를 읽고 평점 평균과 긍정·개선 주제를 분류해.',
      '평균 3.0점과 검색·로그인·결제·알림 주제를 feedback-report.html의 표와 요약에 작성해.',
      '개선 우선순위와 담당 권고를 feedback-actions.docx로 만들어.',
      'workspace에서 두 파일을 다시 검색하고 HTML을 다시 읽어 외부 자원 없이 열리는지 확인해.',
      '원본 5건·평균 3.0·낮은 평점 두 건과 보고서 수치가 일치하는지 교차확인해.',
      '두 결과물을 feedback-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        { path: 'feedback-report.html', type: 'html', contains: ['<table', '3.0', '검색', '로그인', '결제', '알림'] },
        officeFile('feedback-actions.docx', 'docx', ['우선순위', '로그인', '결제']),
        zipFile('feedback-package.zip', ['feedback-report.html', 'feedback-actions.docx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '12',
    title: '교육 출석·수료 판정',
    category: 'data-office',
    inputs: {
      'attendance.csv': 'name,session1,session2,session3,score\n김하늘,1,1,1,92\n이지민,1,0,1,88\n박서준,1,1,0,74\n최유나,1,1,1,81\n'
    },
    command: workflow(
      'attendance.csv를 읽고 출석 3회 모두와 점수 80점 이상을 동시에 만족하는 수료자를 판정해.',
      '전체 판정 근거를 completion.xlsx의 판정·요약 두 시트에 작성해.',
      '수료자 김하늘과 최유나 두 명만 completion-list.csv에 저장해.',
      'workspace에서 두 결과물을 다시 검색하고 CSV를 다시 읽어.',
      '원본 조건과 수료자 수 2명이 정확히 일치하는지 교차확인해.',
      '두 결과물을 completion-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('completion.xlsx', 'xlsx', ['김하늘', '최유나'], { sheets: ['판정', '요약'] }),
        { path: 'completion-list.csv', type: 'csv', rows: 2, contains: ['김하늘', '최유나'], absent: ['이지민', '박서준'] },
        zipFile('completion-package.zip', ['completion.xlsx', 'completion-list.csv'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '13',
    title: '공급업체 견적 의사결정',
    category: 'data-office',
    inputs: {
      'quotes.csv': 'vendor,price,delivery_days,warranty_months,quality_score\n가온,920000,7,12,88\n나래,980000,4,24,93\n다온,870000,10,12,84\n'
    },
    command: workflow(
      'quotes.csv를 읽고 가격·납기·보증·품질을 모두 비교해.',
      '원자료와 비교 판단을 vendor-decision.xlsx의 견적·평가 두 시트에 작성해.',
      '나래의 빠른 납기 4일·보증 24개월·품질 93점과 가격 상충을 vendor-recommendation.hwpx에 설명해.',
      'workspace에서 두 결과물을 다시 검색하고 한글 문서의 핵심 수치를 확인해.',
      '세 업체의 모든 숫자가 원본과 일치하는지 교차확인해.',
      '두 결과물을 vendor-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('vendor-decision.xlsx', 'xlsx', ['가온', '나래', '다온'], { sheets: ['견적', '평가'] }),
        officeFile('vendor-recommendation.hwpx', 'hwpx', ['나래', '4일', '24개월', '93']),
        zipFile('vendor-package.zip', ['vendor-decision.xlsx', 'vendor-recommendation.hwpx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '14',
    title: '시설 에너지 소비 개선안',
    category: 'data-office',
    inputs: {
      'energy.csv': 'month,electricity_kwh,gas_kwh\n2026-05,1200,300\n2026-06,1500,220\n2026-07,1900,180\n2026-08,1700,190\n'
    },
    command: workflow(
      'energy.csv를 읽고 월별 총사용량과 전월 대비 변화를 계산해.',
      '계산 결과와 요약을 energy-analysis.xlsx의 월별·변화 두 시트에 작성해.',
      '7월 총사용량 2080kWh와 8월 1890kWh를 포함한 energy-actions.md를 만들어.',
      'workspace에서 두 파일을 다시 찾고 markdown을 다시 읽어.',
      '입력 네 달·계산값·최고 사용월 7월이 일치하는지 교차확인해.',
      '개선 전후 메시지를 cards/energy-peak.png와 cards/energy-action.png로 만들고 네 결과물을 energy-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('energy-analysis.xlsx', 'xlsx', ['2080', '1890'], { sheets: ['월별', '변화'] }),
        textFile('energy-actions.md', ['2080', '1890', '7월']),
        pngFile('cards/energy-peak.png'), pngFile('cards/energy-action.png'),
        zipFile('energy-package.zip', ['energy-analysis.xlsx', 'energy-actions.md', 'energy-peak.png', 'energy-action.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '15',
    title: '학습 성취도 개인화 계획',
    category: 'data-office',
    inputs: {
      'scores.csv': 'name,math,science,korean\n김하늘,95,87,91\n이지민,72,84,89\n박서준,88,63,77\n'
    },
    command: workflow(
      'scores.csv를 읽고 학생별 평균과 과목별 평균을 계산해.',
      '학생별·과목별 결과를 learning-analysis.xlsx의 두 시트에 작성해.',
      '각 학생의 가장 낮은 과목과 다음 학습 행동을 learning-plan.docx로 만들어.',
      'workspace에서 두 결과물을 다시 검색하고 문서의 학생 세 명을 확인해.',
      '김하늘 평균 91점·이지민 약 81.67점·박서준 76점이 계산과 일치하는지 교차확인해.',
      '두 결과물을 learning-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('learning-analysis.xlsx', 'xlsx', ['김하늘', '이지민', '박서준'], { sheets: ['학생별', '과목별'] }),
        officeFile('learning-plan.docx', 'docx', ['김하늘', '이지민', '박서준', '학습']),
        zipFile('learning-package.zip', ['learning-analysis.xlsx', 'learning-plan.docx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '16',
    title: '프로젝트 위험 등록부·브리핑',
    category: 'operations',
    inputs: {
      'risks.json': '[{"risk":"장소 지연","probability":4,"impact":5,"owner":"김하늘"},{"risk":"예산 초과","probability":3,"impact":4,"owner":"이지민"},{"risk":"참여 부족","probability":2,"impact":5,"owner":"박서준"}]'
    },
    command: workflow(
      'risks.json을 읽고 probability와 impact를 곱한 위험 점수를 계산해.',
      '점수 내림차순 등록부를 risk-register.xlsx의 위험·요약 두 시트에 작성해.',
      '위험별 대응과 담당자를 risk-response.docx로 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 담당자 세 명을 확인해.',
      '점수 20·12·10과 순서가 원본 계산과 일치하는지 교차확인해.',
      '위험 상위 두 건을 cards/risk-01.png와 cards/risk-02.png로 만들고 네 결과물을 risk-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('risk-register.xlsx', 'xlsx', ['20', '12', '10'], { sheets: ['위험', '요약'] }),
        officeFile('risk-response.docx', 'docx', ['김하늘', '이지민', '박서준']),
        pngFile('cards/risk-01.png'), pngFile('cards/risk-02.png'),
        zipFile('risk-package.zip', ['risk-register.xlsx', 'risk-response.docx', 'risk-01.png', 'risk-02.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '17',
    title: '행사 등록·좌석 배정',
    category: 'data-office',
    inputs: {
      'registrations.csv': 'name,paid,accessibility,registered_at\n김하늘,true,일반,2026-09-01T09:00\n이지민,false,일반,2026-09-01T09:05\n박서준,true,휠체어,2026-09-01T09:10\n최유나,true,일반,2026-09-01T09:15\n'
    },
    command: workflow(
      'registrations.csv를 읽고 paid가 true인 참가자만 등록 시각 순으로 확정해.',
      '박서준의 접근성 요구를 반영해 A1, A2, A3 좌석을 배정한 seating.xlsx를 만들어.',
      '확정자 세 명과 미결제 이지민을 구분한 registration-summary.md를 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '결제 완료 3명·미결제 1명·휠체어 1명이 원본과 일치하는지 교차확인해.',
      '두 결과물을 registration-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('seating.xlsx', 'xlsx', ['김하늘', '박서준', '최유나', 'A1', 'A2', 'A3'], { sheets: ['좌석 배정'] }),
        textFile('registration-summary.md', ['3명', '이지민', '휠체어']),
        zipFile('registration-package.zip', ['seating.xlsx', 'registration-summary.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '18',
    title: '설비 예방정비 우선순위',
    category: 'operations',
    inputs: {
      'equipment.csv': 'asset,current_hours,last_service_hours,service_interval,criticality\n펌프-A,1480,1000,500,높음\n팬-B,820,500,400,중간\n밸브-C,2100,1600,600,높음\n'
    },
    command: workflow(
      'equipment.csv를 읽고 current_hours에서 last_service_hours를 빼 정비 주기와 비교해.',
      '잔여 시간과 정비 상태를 maintenance.xlsx의 상태·우선순위 두 시트에 작성해.',
      '펌프-A는 20시간 남음, 팬-B는 80시간 남음, 밸브-C는 100시간 남음으로 maintenance-plan.md에 정리해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '세 계산값과 중요도 기준 우선순위가 원본과 일치하는지 교차확인해.',
      '두 결과물을 maintenance-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('maintenance.xlsx', 'xlsx', ['펌프-A', '팬-B', '밸브-C'], { sheets: ['상태', '우선순위'] }),
        textFile('maintenance-plan.md', ['20시간', '80시간', '100시간']),
        zipFile('maintenance-package.zip', ['maintenance.xlsx', 'maintenance-plan.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '19',
    title: '배송 주문 금액·지연 위험 통합',
    category: 'data-office',
    inputs: {
      'orders.csv': 'order_id,item,quantity,unit_price,promised_date,status\nO-101,키트,3,12000,2026-09-05,준비\nO-102,책자,10,3000,2026-09-03,미출고\nO-103,배너,2,25000,2026-09-07,출고\n'
    },
    command: workflow(
      'orders.csv를 읽고 주문별 금액과 총액을 계산하고 기준일 2026-09-03에 미출고인 당일 약속 주문을 찾아.',
      '주문별 계산과 위험 판정을 orders-analysis.xlsx의 주문·위험 두 시트에 작성해.',
      '총액 116000원과 O-102 지연 위험을 shipping-brief.md에 명시해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '금액 36000원·30000원·50000원과 총액이 원본 계산과 일치하는지 교차확인해.',
      '두 결과물을 shipping-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('orders-analysis.xlsx', 'xlsx', ['O-101', 'O-102', 'O-103', '116000'], { sheets: ['주문', '위험'] }),
        textFile('shipping-brief.md', ['116000', 'O-102', '지연']),
        zipFile('shipping-package.zip', ['orders-analysis.xlsx', 'shipping-brief.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '20',
    title: '후원금 집계·감사 요약',
    category: 'data-office',
    inputs: {
      'donations.csv': 'donor,campaign,amount,restricted\n김하늘,교육,100000,true\n이지민,교육,50000,false\n박서준,시설,200000,true\n최유나,시설,75000,false\n'
    },
    command: workflow(
      'donations.csv를 읽고 캠페인별 합계와 제한 후원금 합계를 계산해.',
      '거래·캠페인 요약·제한성 요약 세 시트의 donations-audit.xlsx를 만들어.',
      '전체 425000원, 교육 150000원, 시설 275000원, 제한 후원 300000원을 donations-summary.hwpx에 기록해.',
      'workspace에서 두 산출물을 다시 검색하고 한글 문서의 네 금액을 확인해.',
      '원본 네 거래와 모든 합계가 일치하는지 교차확인해.',
      '두 결과물을 donations-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('donations-audit.xlsx', 'xlsx', ['425000', '300000'], { sheets: ['거래', '캠페인 요약', '제한성 요약'] }),
        officeFile('donations-summary.hwpx', 'hwpx', ['425000', '150000', '275000', '300000']),
        zipFile('donations-package.zip', ['donations-audit.xlsx', 'donations-summary.hwpx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '21',
    title: '합성 연구노트 근거 통합',
    category: 'knowledge',
    inputs: {
      'notes/study-a.txt': '연구 A: 참가자 120명. 주 3회 20분 활동군의 집중도 점수가 12% 증가했다. 한계: 4주 관찰.',
      'notes/study-b.txt': '연구 B: 참가자 80명. 주 5회 10분 활동군의 집중도 점수가 8% 증가했다. 한계: 자기보고 편향.',
      'notes/study-c.txt': '연구 C: 참가자 150명. 대조군 대비 활동군의 결석률이 5%p 낮았다. 한계: 단일 기관.'
    },
    command: workflow(
      'notes 폴더의 study-a.txt, study-b.txt, study-c.txt를 찾아 모두 읽어.',
      '표본·개입·결과·한계를 연구별로 구분한 evidence-table.xlsx를 만들어.',
      '공통점·차이·결론의 한계를 evidence-synthesis.docx에 작성하고 각 주장에 원본 파일명을 붙여.',
      'workspace에서 두 결과물을 다시 검색하고 문서의 연구 A·B·C를 확인해.',
      '참가자 수 120·80·150과 결과 12%·8%·5%p가 원본과 일치하는지 교차확인해.',
      '두 결과물을 evidence-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('evidence-table.xlsx', 'xlsx', ['120', '80', '150', '12', '8', '5'], { sheets: ['근거 표'] }),
        officeFile('evidence-synthesis.docx', 'docx', ['study-a.txt', 'study-b.txt', 'study-c.txt', '한계']),
        zipFile('evidence-package.zip', ['evidence-table.xlsx', 'evidence-synthesis.docx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '22',
    title: '회의록 실행항목·의사결정 추적',
    category: 'knowledge',
    inputs: {
      'meeting.txt': '2026-09-02 운영회의. 결정: 행사일은 9월 20일로 확정. 김하늘은 9월 8일까지 장소 계약. 이지민은 9월 10일까지 초대장 완성. 박서준은 9월 12일까지 예산 승인 요청. 보류: 우천 대체 프로그램은 다음 회의에서 결정. 다음 회의 9월 13일.'
    },
    command: workflow(
      'meeting.txt를 읽고 결정·실행 항목·보류 항목·다음 회의를 구분해.',
      '담당자·할 일·마감·상태 열이 있는 action-tracker.xlsx를 만들어.',
      '확정 사항과 보류 사항을 meeting-decision.md에 원문 날짜와 함께 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '담당자 세 명·마감일 세 개·행사일 9월 20일·다음 회의 9월 13일이 원본과 일치하는지 교차확인해.',
      '두 결과물을 meeting-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('action-tracker.xlsx', 'xlsx', ['김하늘', '이지민', '박서준'], { sheets: ['실행 항목'] }),
        textFile('meeting-decision.md', ['9월 20일', '우천', '9월 13일']),
        zipFile('meeting-package.zip', ['action-tracker.xlsx', 'meeting-decision.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '23',
    title: '두 정책안 충돌·통합 분석',
    category: 'knowledge',
    inputs: {
      'policy-old.txt': '문서 보존기간은 3년이다. 외부 공유는 팀장 승인 후 가능하다. 백업은 매주 수행한다.',
      'policy-new.txt': '문서 보존기간은 5년이다. 외부 공유는 보안담당과 팀장 승인 후 가능하다. 백업은 매일 수행한다.'
    },
    command: workflow(
      'policy-old.txt와 policy-new.txt를 모두 읽고 조항별 변경과 충돌을 찾아.',
      '이전·신규·변경 영향 열을 가진 policy-diff.xlsx를 만들어.',
      '신규 기준 보존 5년·이중 승인·매일 백업을 반영한 consolidated-policy.docx를 작성해.',
      'workspace에서 두 산출물을 다시 검색하고 통합 문서의 세 기준을 확인해.',
      '두 원본의 3개 조항과 결과의 변경 3건이 일치하는지 교차확인해.',
      '두 결과물을 policy-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('policy-diff.xlsx', 'xlsx', ['3년', '5년', '매주', '매일'], { sheets: ['변경 비교'] }),
        officeFile('consolidated-policy.docx', 'docx', ['5년', '보안담당', '팀장', '매일']),
        zipFile('policy-package.zip', ['policy-diff.xlsx', 'consolidated-policy.docx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '24',
    title: '보안 경보 상관분석·대응카드',
    category: 'operations',
    inputs: {
      'auth.log': '09:00 SUCCESS user=hana ip=10.0.0.2\n09:10 FAIL user=admin ip=203.0.113.10\n09:11 FAIL user=admin ip=203.0.113.10\n09:12 FAIL user=admin ip=203.0.113.10\n09:14 SUCCESS user=admin ip=203.0.113.10\n',
      'alerts.json': '[{"time":"09:13","type":"brute_force","ip":"203.0.113.10","severity":"high"},{"time":"09:20","type":"policy_update","severity":"low"}]'
    },
    command: workflow(
      'auth.log와 alerts.json을 모두 읽고 시간·사용자·IP로 사건을 연결해.',
      '연속 실패 3회 뒤 같은 IP의 성공과 high 경보를 security-incident.md에 근거와 함께 기록해.',
      '사건·경보·판정 세 시트의 security-analysis.xlsx를 만들어.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '203.0.113.10·admin·실패 3회·09:14 성공이 두 원본과 일치하는지 교차확인해.',
      '대응 요약을 cards/security-alert.png로 만들고 세 결과물을 security-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('security-incident.md', ['203.0.113.10', 'admin', '3회', '09:14']),
        officeFile('security-analysis.xlsx', 'xlsx', ['brute_force', 'high'], { sheets: ['사건', '경보', '판정'] }),
        pngFile('cards/security-alert.png'),
        zipFile('security-package.zip', ['security-incident.md', 'security-analysis.xlsx', 'security-alert.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '25',
    title: '누락 원본 기반 계산 안전 중단',
    category: 'expected-stop',
    inputs: {
      'readme.txt': '정산은 transactions-september.csv 원본을 근거로 수행해야 하며 추정값 사용은 금지한다.'
    },
    command: workflow(
      'readme.txt를 읽어 필요한 정산 원본 이름을 확인해.',
      'workspace에서 transactions-september.csv를 정확한 파일명으로 검색해.',
      '파일이 없으면 비슷한 파일이나 예시 수치로 대체하지 말아.',
      '누락된 파일명을 명확히 알리고 사용자에게 원본 제공을 요청해.',
      '원본을 받기 전에는 settlement.xlsx, settlement-summary.md, settlement-package.zip을 만들지 말아.'
    ),
    expected: {
      status: 'EXPECTED_STOP',
      files: [
        { path: 'settlement.xlsx', type: 'xlsx', absent: true },
        { path: 'settlement-summary.md', type: 'text', absent: true },
        { path: 'settlement-package.zip', type: 'zip', absent: true }
      ],
      missing: ['transactions-september.csv'],
      unchangedInputs: true
    }
  },
  {
    id: '26',
    title: '확장자 선택 이동·목록·보관',
    category: 'filesystem',
    inputs: {
      'inbox/meeting-a.txt': '회의 A: 예산 검토 완료',
      'inbox/meeting-b.txt': '회의 B: 일정 확정 완료',
      'inbox/metrics.csv': 'metric,value\n완료,2\n',
      'inbox/photo-note.md': '이미지 촬영 메모'
    },
    command: workflow(
      'inbox에서 이름이 meeting으로 시작하는 txt 파일만 검색해 정확히 두 개를 찾아.',
      '두 txt를 reviewed/meeting-a.txt와 reviewed/meeting-b.txt로 이동하고 나머지 두 파일은 inbox에 유지해.',
      '이동 후 reviewed와 inbox를 다시 나열해 위치를 확인해.',
      '이동된 두 파일을 다시 읽고 원래 내용을 보존했는지 확인해.',
      '이동 결과와 남은 파일 목록을 move-manifest.md에 저장해.',
      '이동된 두 파일과 manifest를 reviewed-package.zip으로 묶고 세 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('reviewed/meeting-a.txt', ['예산 검토 완료']),
        textFile('reviewed/meeting-b.txt', ['일정 확정 완료']),
        textFile('inbox/metrics.csv', ['완료,2']),
        textFile('inbox/photo-note.md', ['촬영 메모']),
        textFile('move-manifest.md', ['meeting-a.txt', 'meeting-b.txt', 'metrics.csv', 'photo-note.md']),
        zipFile('reviewed-package.zip', ['meeting-a.txt', 'meeting-b.txt', 'move-manifest.md']),
        { path: 'inbox/meeting-a.txt', type: 'text', absent: true },
        { path: 'inbox/meeting-b.txt', type: 'text', absent: true }
      ]
    }
  },
  {
    id: '27',
    title: '이름 충돌 보존 이동·비교',
    category: 'filesystem',
    inputs: {
      'archive/report.txt': '기존 보고서: 승인 7건',
      'inbox/report.txt': '신규 보고서: 승인 9건'
    },
    command: workflow(
      'archive/report.txt와 inbox/report.txt를 각각 읽어 이름 충돌과 서로 다른 내용을 확인해.',
      '기존 archive/report.txt는 보존하고 신규 파일을 archive/report-incoming.txt로 이동해.',
      'archive 폴더를 다시 검색해 두 파일이 각각 한 개씩 있는지 확인해.',
      '두 파일을 다시 읽고 승인 7건과 9건이 바뀌거나 덮어쓰이지 않았는지 교차확인해.',
      '차이를 collision-review.md에 기록해.',
      '두 보고서와 비교 문서를 collision-package.zip으로 묶고 세 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('archive/report.txt', ['승인 7건']),
        textFile('archive/report-incoming.txt', ['승인 9건']),
        textFile('collision-review.md', ['7건', '9건', '보존']),
        zipFile('collision-package.zip', ['report.txt', 'report-incoming.txt', 'collision-review.md']),
        { path: 'inbox/report.txt', type: 'text', absent: true }
      ]
    }
  },
  {
    id: '28',
    title: '혼합 파일 분류·내용 보존 감사',
    category: 'filesystem',
    inputs: {
      'drop/a.txt': '텍스트 증거 A-17',
      'drop/b.csv': 'key,value\nB,23\n',
      'drop/c.json': '{"key":"C","value":31}'
    },
    command: workflow(
      'drop 폴더를 나열하고 txt, csv, json 파일 세 개를 확인해.',
      'a.txt는 sorted/text/a.txt, b.csv는 sorted/data/b.csv, c.json은 sorted/data/c.json으로 이동해.',
      'sorted 아래를 다시 검색해 세 파일의 새 위치를 확인해.',
      '세 파일을 다시 읽어 A-17, B의 23, C의 31이 보존됐는지 교차확인해.',
      '원래 위치와 새 위치를 sort-manifest.csv에 기록해.',
      '세 이동 파일과 manifest를 sorted-package.zip으로 묶고 네 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('sorted/text/a.txt', ['A-17']),
        { path: 'sorted/data/b.csv', type: 'csv', contains: ['B,23'] },
        { path: 'sorted/data/c.json', type: 'json', contains: ['"key":"C"', '31'] },
        { path: 'sort-manifest.csv', type: 'csv', rows: 3, contains: ['drop/a.txt', 'sorted/text/a.txt', 'sorted/data/b.csv', 'sorted/data/c.json'] },
        zipFile('sorted-package.zip', ['a.txt', 'b.csv', 'c.json', 'sort-manifest.csv']),
        { path: 'drop/a.txt', type: 'text', absent: true },
        { path: 'drop/b.csv', type: 'csv', absent: true },
        { path: 'drop/c.json', type: 'json', absent: true }
      ]
    }
  },
  {
    id: '29',
    title: '환경설정 JSON 규칙 검증·정규화',
    category: 'data-office',
    inputs: {
      'config.json': '{"service":"alpha","retryCount":3,"timeoutMs":5000,"regions":["ap-northeast-2","us-west-2"],"features":{"audit":true,"legacy":false}}'
    },
    command: workflow(
      'config.json을 읽고 필수 키 service, retryCount, timeoutMs, regions, features를 확인해.',
      '값의 자료형과 retryCount 0~5, timeoutMs 1000~30000 규칙을 검증해.',
      '키를 읽기 쉬운 순서로 정리한 유효 JSON을 normalized-config.json에 저장해.',
      '검증 규칙·실제 값·통과 여부를 config-validation.md에 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 normalized-config.json을 다시 읽어 구문을 확인해.',
      '원본의 두 region과 audit true, legacy false가 손실되지 않았는지 교차확인한 뒤 두 결과물을 config-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        { path: 'normalized-config.json', type: 'json', rootType: 'object', contains: ['alpha', 'ap-northeast-2', 'us-west-2', 'audit', 'legacy'] },
        textFile('config-validation.md', ['retryCount', 'timeoutMs', '통과']),
        zipFile('config-package.zip', ['normalized-config.json', 'config-validation.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '30',
    title: '근무시간 집계·초과 배분',
    category: 'data-office',
    inputs: {
      'timesheet.csv': 'name,project,hours\n김하늘,A,18\n김하늘,B,25\n이지민,A,20\n이지민,C,16\n박서준,B,22\n박서준,C,21\n'
    },
    command: workflow(
      'timesheet.csv를 읽고 사람별·프로젝트별 시간을 각각 합산해.',
      '두 집계와 주 40시간 초과 판정을 timesheet-analysis.xlsx의 사람별·프로젝트별·초과 세 시트에 작성해.',
      '김하늘 43시간과 박서준 43시간의 각 3시간 초과, 이지민 36시간을 workload-summary.md에 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '여섯 원본 행·총 122시간·초과자 2명이 결과와 일치하는지 교차확인해.',
      '두 결과물을 workload-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('timesheet-analysis.xlsx', 'xlsx', ['43', '36', '122'], { sheets: ['사람별', '프로젝트별', '초과'] }),
        textFile('workload-summary.md', ['김하늘', '박서준', '3시간', '이지민', '36시간']),
        zipFile('workload-package.zip', ['timesheet-analysis.xlsx', 'workload-summary.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '31',
    title: '캠페인 전환효율 분석',
    category: 'data-office',
    inputs: {
      'campaign.csv': 'channel,impressions,clicks,conversions,cost\n검색,10000,500,50,1000000\n소셜,15000,600,30,750000\n이메일,5000,750,75,300000\n'
    },
    command: workflow(
      'campaign.csv를 읽고 채널별 클릭률, 전환율, 전환당 비용을 계산해.',
      '원자료와 계산 지표를 campaign-analysis.xlsx의 원자료·효율 두 시트에 작성해.',
      '이메일 클릭률 15%, 클릭 대비 전환율 10%, 전환당 비용 4000원과 권고를 campaign-brief.docx에 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 문서의 지표를 확인해.',
      '세 채널 계산과 총 전환 155건이 원본과 일치하는지 교차확인해.',
      '최고 효율과 개선 채널을 cards/campaign-best.png와 cards/campaign-action.png로 만들고 네 결과물을 campaign-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('campaign-analysis.xlsx', 'xlsx', ['검색', '소셜', '이메일', '155'], { sheets: ['원자료', '효율'] }),
        officeFile('campaign-brief.docx', 'docx', ['15%', '10%', '4000']),
        pngFile('cards/campaign-best.png'), pngFile('cards/campaign-action.png'),
        zipFile('campaign-package.zip', ['campaign-analysis.xlsx', 'campaign-brief.docx', 'campaign-best.png', 'campaign-action.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '32',
    title: '급식 수량·알레르기 운영계획',
    category: 'operations',
    inputs: {
      'meal-orders.csv': 'name,meal,allergy\n김하늘,일반,없음\n이지민,채식,견과\n박서준,일반,우유\n최유나,채식,없음\n한도윤,일반,견과\n'
    },
    command: workflow(
      'meal-orders.csv를 읽고 식단별 수량과 알레르기별 인원을 집계해.',
      '참가자·식단 요약·알레르기 요약 세 시트의 meal-plan.xlsx를 만들어.',
      '일반 3개·채식 2개와 견과 2명·우유 1명을 meal-safety.hwpx에 분리 준비 절차와 함께 작성해.',
      'workspace에서 두 산출물을 다시 검색하고 한글 문서의 수량을 확인해.',
      '원본 5명과 모든 집계가 일치하는지 교차확인해.',
      '두 결과물을 meal-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('meal-plan.xlsx', 'xlsx', ['일반', '채식', '견과', '우유'], { sheets: ['참가자', '식단 요약', '알레르기 요약'] }),
        officeFile('meal-safety.hwpx', 'hwpx', ['일반 3', '채식 2', '견과', '우유']),
        zipFile('meal-package.zip', ['meal-plan.xlsx', 'meal-safety.hwpx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '33',
    title: '품질 결함 파레토 분석',
    category: 'data-office',
    inputs: {
      'defects.csv': 'type,count,severity\n스크래치,24,낮음\n조립불량,15,높음\n오염,9,중간\n치수오차,12,높음\n'
    },
    command: workflow(
      'defects.csv를 읽고 총 결함 수와 유형별 비중을 계산해 count 내림차순으로 정렬해.',
      '결함 원자료·비중·심각도 우선순위 세 시트의 quality-analysis.xlsx를 만들어.',
      '총 60건, 스크래치 40%, 조립불량 25%, 치수오차 20%, 오염 15%를 quality-actions.md에 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '높음 심각도 두 유형과 비중 합계 100%가 원본과 일치하는지 교차확인해.',
      '상위 빈도와 상위 심각도를 cards/defect-frequency.png와 cards/defect-severity.png로 만들고 네 결과물을 quality-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('quality-analysis.xlsx', 'xlsx', ['60', '40', '25', '20', '15'], { sheets: ['원자료', '비중', '심각도 우선순위'] }),
        textFile('quality-actions.md', ['60', '40%', '25%', '20%', '15%']),
        pngFile('cards/defect-frequency.png'), pngFile('cards/defect-severity.png'),
        zipFile('quality-package.zip', ['quality-analysis.xlsx', 'quality-actions.md', 'defect-frequency.png', 'defect-severity.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '34',
    title: '지원 티켓 SLA·주제 분석',
    category: 'operations',
    inputs: {
      'tickets.csv': 'id,topic,priority,opened_hours,resolved\nT1,로그인,높음,6,false\nT2,결제,높음,2,true\nT3,검색,중간,20,false\nT4,로그인,낮음,30,true\nT5,결제,중간,12,false\n'
    },
    command: workflow(
      'tickets.csv를 읽고 주제별 건수·미해결 건수와 높은 우선순위 미해결 시간을 분석해.',
      '티켓·주제 요약·SLA 위험 세 시트의 ticket-analysis.xlsx를 만들어.',
      '미해결 T1, T3, T5와 최우선 조치 T1을 support-brief.md에 근거와 함께 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '전체 5건·미해결 3건·로그인 2건·결제 2건·검색 1건이 원본과 일치하는지 교차확인해.',
      '두 결과물을 support-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('ticket-analysis.xlsx', 'xlsx', ['T1', 'T3', 'T5'], { sheets: ['티켓', '주제 요약', 'SLA 위험'] }),
        textFile('support-brief.md', ['T1', 'T3', 'T5', '미해결 3']),
        zipFile('support-package.zip', ['ticket-analysis.xlsx', 'support-brief.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '35',
    title: '성장 시나리오 계산·의사결정 브리핑',
    category: 'data-office',
    inputs: {
      'growth-scenarios.csv': 'scenario,start,m1_rate,m2_rate,m3_rate\n보수,1000,0.02,0.03,0.02\n기준,1000,0.05,0.08,0.06\n공격,1000,0.08,0.10,0.09\n'
    },
    command: workflow(
      'growth-scenarios.csv를 읽고 각 달의 값에 해당 월 성장률을 연속 적용해 시나리오별 3개월 말 값을 계산해.',
      '월별 계산과 시나리오 비교를 growth-forecast.xlsx의 월별·비교 두 시트에 작성해.',
      '보수 약 1071.61, 기준 약 1202.04, 공격 약 1294.92의 3개월 말 값과 가정을 growth-decision.md에 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '시작값 1000과 아홉 성장률, 세 최종 계산값이 원본과 일치하는지 교차확인해.',
      '세 시나리오를 cards/growth-conservative.png, cards/growth-base.png, cards/growth-aggressive.png로 만들고 다섯 결과물을 growth-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('growth-forecast.xlsx', 'xlsx', ['1071.61', '1202.04', '1294.92'], { sheets: ['월별', '비교'] }),
        textFile('growth-decision.md', ['1071.61', '1202.04', '1294.92']),
        pngFile('cards/growth-conservative.png'), pngFile('cards/growth-base.png'), pngFile('cards/growth-aggressive.png'),
        zipFile('growth-package.zip', ['growth-forecast.xlsx', 'growth-decision.md', 'growth-conservative.png', 'growth-base.png', 'growth-aggressive.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '36',
    title: '신규 입사자 온보딩 통합 패키지',
    category: 'knowledge',
    inputs: {
      'company.txt': '회사명: 별빛랩. 핵심가치: 정직, 속도, 배려. 근무시간: 09:00~18:00. 문의: 운영팀.',
      'security.txt': '첫날 필수: MFA 등록, 비밀번호 관리자 설치. 금지: 계정 공유. 사고 신고: 보안팀.',
      'schedule.csv': 'day,topic,owner\n1,회사 소개,김하늘\n2,보안 교육,이지민\n3,직무 실습,박서준\n'
    },
    command: workflow(
      'company.txt, security.txt, schedule.csv를 찾아 모두 읽어.',
      '회사 정보·보안 필수사항·3일 일정을 onboarding-guide.docx에 작성해.',
      '환영·가치·보안·일정·문의 순서의 onboarding-briefing.pptx를 정확히 5장으로 만들어.',
      'workspace에서 두 결과물을 다시 검색하고 담당자 세 명과 MFA를 확인해.',
      '세 원본의 회사명·핵심가치·금지사항·일정 세 행이 산출물과 일치하는지 교차확인해.',
      '핵심 첫날 행동을 cards/onboarding-day1.png로 만들고 세 결과물을 onboarding-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('onboarding-guide.docx', 'docx', ['별빛랩', '정직', 'MFA', '김하늘', '이지민', '박서준']),
        officeFile('onboarding-briefing.pptx', 'pptx', ['별빛랩', '보안', '일정', '문의'], { slides: 5 }),
        pngFile('cards/onboarding-day1.png'),
        zipFile('onboarding-package.zip', ['onboarding-guide.docx', 'onboarding-briefing.pptx', 'onboarding-day1.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '37',
    title: '비상대피 훈련 성과·개선안',
    category: 'operations',
    inputs: {
      'drill.csv': 'zone,people,evacuation_seconds,issues\nA,40,185,출구 표지 혼선\nB,35,142,없음\nC,25,220,통로 적재물\n',
      'target.txt': '목표: 모든 구역 180초 이하. 전체 인원 100명 확인.'
    },
    command: workflow(
      'drill.csv와 target.txt를 모두 읽고 구역별 목표 충족 여부를 판정해.',
      '구역별 결과·인원 검산·개선 우선순위를 drill-analysis.xlsx의 세 시트에 작성해.',
      'A구역 185초와 C구역 220초 미달, 전체 100명을 drill-report.hwpx에 기록해.',
      'workspace에서 두 결과물을 다시 검색하고 한글 문서의 구역·시간·인원을 확인해.',
      'B구역만 180초 이하이고 A·C가 개선 대상이라는 판정이 원본과 일치하는지 교차확인해.',
      '개선 대상 두 구역을 cards/drill-a.png와 cards/drill-c.png로 만들고 네 결과물을 drill-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('drill-analysis.xlsx', 'xlsx', ['185', '142', '220', '100'], { sheets: ['구역별 결과', '인원 검산', '개선 우선순위'] }),
        officeFile('drill-report.hwpx', 'hwpx', ['A구역', '185', 'C구역', '220', '100']),
        pngFile('cards/drill-a.png'), pngFile('cards/drill-c.png'),
        zipFile('drill-package.zip', ['drill-analysis.xlsx', 'drill-report.hwpx', 'drill-a.png', 'drill-c.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '38',
    title: '소프트웨어 릴리스 판정 패키지',
    category: 'operations',
    inputs: {
      'release-checks.csv': 'check,status,evidence\nunit-tests,pass,107 tests\nbuild,pass,exit 0\nsecurity-scan,pass,0 critical\nbrowser-smoke,fail,checkout timeout\nrollback-plan,pass,documented\n'
    },
    command: workflow(
      'release-checks.csv를 읽고 필수 검사별 상태와 증거를 정리해.',
      '검사·실패 원인·출시 판정 세 시트의 release-gate.xlsx를 만들어.',
      'browser-smoke 실패 때문에 현재 판정은 HOLD이며 checkout timeout 해결 후 재검증해야 한다는 release-decision.md를 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '통과 4건·실패 1건·107 tests·0 critical이 원본과 일치하는지 교차확인해.',
      '현재 판정과 해제 조건을 cards/release-hold.png와 cards/release-unblock.png로 만들고 네 결과물을 release-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('release-gate.xlsx', 'xlsx', ['unit-tests', 'browser-smoke', 'checkout timeout'], { sheets: ['검사', '실패 원인', '출시 판정'] }),
        textFile('release-decision.md', ['HOLD', 'checkout timeout', '재검증']),
        pngFile('cards/release-hold.png'), pngFile('cards/release-unblock.png'),
        zipFile('release-package.zip', ['release-gate.xlsx', 'release-decision.md', 'release-hold.png', 'release-unblock.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '39',
    title: '지원 지식베이스 구조화·교육자료',
    category: 'knowledge',
    inputs: {
      'faq.txt': 'Q: 비밀번호를 잊었어요? A: 로그인 화면의 비밀번호 재설정을 사용합니다.\nQ: 영수증은 어디서 받나요? A: 결제 내역에서 PDF 영수증을 받습니다.\nQ: 계정을 삭제하려면? A: 설정의 개인정보 메뉴에서 삭제 요청을 제출합니다.',
      'escalation.txt': '재설정 메일 미수신은 30분 후 지원팀으로 전달. 결제 이중청구는 즉시 재무팀으로 전달. 계정 삭제 오류는 개인정보 담당으로 전달.'
    },
    command: workflow(
      'faq.txt와 escalation.txt를 모두 읽고 질문·기본 답변·상향 조건·담당을 연결해.',
      '세 항목을 표와 절차로 정리한 support-kb.docx를 만들어.',
      '상담원 교육용 support-training.pptx를 개요·비밀번호·결제·계정삭제·상향체계 순서의 정확히 5장으로 만들어.',
      'workspace에서 두 결과물을 다시 검색하고 세 질문과 세 담당을 확인해.',
      '30분·즉시·개인정보 담당 조건이 원본과 일치하는지 교차확인해.',
      '두 결과물을 support-kb-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('support-kb.docx', 'docx', ['비밀번호', '영수증', '계정', '30분', '재무팀', '개인정보']),
        officeFile('support-training.pptx', 'pptx', ['비밀번호', '결제', '계정삭제', '상향'], { slides: 5 }),
        zipFile('support-kb-package.zip', ['support-kb.docx', 'support-training.pptx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '40',
    title: '한영 행사 안내 일관성 검수',
    category: 'knowledge',
    inputs: {
      'event-ko.txt': '행사명: 별빛 포럼. 일시: 2026-09-20 14:00. 장소: 서울 교육관 3층. 등록 마감: 2026-09-15. 문의: forum@example.test.',
      'event-en.txt': 'Event: Starlight Forum. Date: 2026-09-20 14:00. Venue: Seoul Education Center, 3F. Registration deadline: 2026-09-15. Contact: forum@example.test.'
    },
    command: workflow(
      'event-ko.txt와 event-en.txt를 모두 읽고 행사명·날짜·시간·장소·마감·문의가 서로 대응하는지 확인해.',
      '한국어와 영어를 나란히 배치한 bilingual-invitation.docx를 만들어.',
      '항목별 대응과 일치 판정을 bilingual-check.xlsx에 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 날짜 두 개와 이메일을 확인해.',
      '두 원본의 여섯 필드가 산출물에 손실 없이 반영됐는지 교차확인해.',
      '한국어와 영어 안내를 cards/invitation-ko.png와 cards/invitation-en.png로 만들고 네 결과물을 bilingual-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('bilingual-invitation.docx', 'docx', ['별빛 포럼', 'Starlight Forum', '2026-09-20', '2026-09-15', 'forum@example.test']),
        officeFile('bilingual-check.xlsx', 'xlsx', ['일치', 'forum@example.test'], { sheets: ['대응 검수'] }),
        pngFile('cards/invitation-ko.png'), pngFile('cards/invitation-en.png'),
        zipFile('bilingual-package.zip', ['bilingual-invitation.docx', 'bilingual-check.xlsx', 'invitation-ko.png', 'invitation-en.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '41',
    title: '전략 메모에서 이사회 문서·발표 생성',
    category: 'office-suite',
    inputs: {
      'strategy.txt': '목표: 2027년 활성 사용자 20% 증가. 축1 제품 안정성, 목표 장애율 0.1% 이하. 축2 고객 성공, 응답시간 4시간 이하. 축3 비용 효율, 인프라 단가 15% 절감. 위험: 인력 부족과 데이터 품질. 분기 검토.'
    },
    command: workflow(
      'strategy.txt를 읽고 목표·세 전략축·지표·위험·검토 주기를 구조화해.',
      '배경·전략·지표·위험·거버넌스 절의 strategy-paper.docx를 만들어.',
      '제목·목표·세 전략축·위험과 다음 행동을 순서로 strategy-board.pptx를 정확히 7장으로 만들어.',
      'workspace에서 두 산출물을 다시 검색하고 문서명과 슬라이드 수를 확인해.',
      '20%·0.1%·4시간·15%와 위험 두 개가 원본과 두 산출물에서 일치하는지 교차확인해.',
      '두 결과물을 strategy-package.zip으로 묶고 항목 두 개를 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('strategy-paper.docx', 'docx', ['20%', '0.1%', '4시간', '15%', '인력 부족', '데이터 품질']),
        officeFile('strategy-board.pptx', 'pptx', ['전략', '위험', '다음 행동'], { slides: 7 }),
        zipFile('strategy-package.zip', ['strategy-paper.docx', 'strategy-board.pptx'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '42',
    title: '현장 안전점검 한글문서·분석표·카드',
    category: 'office-suite',
    inputs: {
      'inspection.csv': 'area,item,status,owner,due\n창고,통로 적재,불량,김하늘,2026-09-04\n기계실,보호구,양호,이지민,2026-09-10\n사무실,소화기 점검,주의,박서준,2026-09-06\n'
    },
    command: workflow(
      'inspection.csv를 읽고 불량·주의·양호를 분리하고 조치 우선순위를 정해.',
      '원자료·상태 요약·조치 목록 세 시트의 safety-inspection.xlsx를 만들어.',
      '창고 불량을 최우선, 사무실 주의를 차순위로 한 safety-order.hwpx 한글 문서를 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 담당자·마감일을 확인해.',
      '상태 각 1건과 원본 세 행이 두 산출물과 일치하는지 교차확인해.',
      '두 조치 항목을 cards/safety-urgent.png와 cards/safety-caution.png로 만들고 네 결과물을 safety-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('safety-inspection.xlsx', 'xlsx', ['창고', '기계실', '사무실'], { sheets: ['원자료', '상태 요약', '조치 목록'] }),
        officeFile('safety-order.hwpx', 'hwpx', ['창고', '김하늘', '사무실', '박서준']),
        pngFile('cards/safety-urgent.png'), pngFile('cards/safety-caution.png'),
        zipFile('safety-package.zip', ['safety-inspection.xlsx', 'safety-order.hwpx', 'safety-urgent.png', 'safety-caution.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '43',
    title: '예산·실지출·약정 3원장 대사',
    category: 'data-office',
    inputs: {
      'budget.csv': 'category,budget\n인쇄,300000\n장소,500000\n다과,200000\n',
      'actual.csv': 'category,actual\n인쇄,210000\n장소,350000\n다과,0\n',
      'commitments.csv': 'category,committed\n인쇄,90000\n장소,0\n다과,180000\n'
    },
    command: workflow(
      'budget.csv, actual.csv, commitments.csv를 모두 읽고 카테고리별 예산·실지출·약정·가용잔액을 대사해.',
      '세 원장과 대사 결과를 budget-reconciliation.xlsx의 예산·실지출·약정·대사 네 시트에 작성해.',
      '총예산 1000000원, 실지출 560000원, 약정 270000원, 가용잔액 170000원을 budget-status.md에 기록해.',
      'workspace에서 두 산출물을 다시 검색하고 markdown을 다시 읽어.',
      '세 카테고리와 네 총계가 세 원본의 합과 일치하는지 교차확인해.',
      '두 결과물을 budget-reconciliation-package.zip으로 묶고 항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('budget-reconciliation.xlsx', 'xlsx', ['1000000', '560000', '270000', '170000'], { sheets: ['예산', '실지출', '약정', '대사'] }),
        textFile('budget-status.md', ['1000000', '560000', '270000', '170000']),
        zipFile('budget-reconciliation-package.zip', ['budget-reconciliation.xlsx', 'budget-status.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '44',
    title: '운영 KPI 독립형 HTML 대시보드',
    category: 'data-office',
    inputs: {
      'kpi.csv': 'week,requests,successes,latency_ms,satisfaction\nW1,1000,970,420,4.2\nW2,1200,1188,390,4.4\nW3,1100,1078,450,4.1\nW4,1300,1287,370,4.6\n'
    },
    command: workflow(
      'kpi.csv를 읽고 주별 성공률과 전체 요청·성공 합계를 계산해.',
      '외부 CSS나 스크립트 없이 표·요약·판정이 포함된 kpi-dashboard.html을 만들어.',
      '전체 요청 4600건, 성공 4523건과 최고 만족도 W4 4.6을 kpi-summary.md에 기록해.',
      'workspace에서 두 파일을 다시 검색하고 HTML과 markdown을 각각 다시 읽어.',
      '네 주·전체 합계·W4 지표가 원본과 일치하며 HTML에 table 태그가 있는지 교차확인해.',
      '두 결과물을 kpi-package.zip으로 묶고 항목 두 개를 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        { path: 'kpi-dashboard.html', type: 'html', contains: ['<table', '4600', '4523', 'W4', '4.6'] },
        textFile('kpi-summary.md', ['4600', '4523', 'W4', '4.6']),
        zipFile('kpi-package.zip', ['kpi-dashboard.html', 'kpi-summary.md'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '45',
    title: '가중치 의사결정 행렬·민감도 분석',
    category: 'data-office',
    inputs: {
      'options.csv': 'option,cost,speed,quality,risk_control\nA,8,6,9,7\nB,6,9,8,8\nC,9,5,7,6\n',
      'weights.csv': 'criterion,weight\ncost,0.25\nspeed,0.25\nquality,0.35\nrisk_control,0.15\n'
    },
    command: workflow(
      'options.csv와 weights.csv를 모두 읽고 옵션별 가중합을 계산해.',
      '원점수·가중치·가중 결과 세 시트의 decision-matrix.xlsx를 만들어.',
      'B가 7.75점으로 1위이고 A가 7.70점, C가 6.85점이라는 decision-note.md를 작성해 B 선택 근거와 민감도 확인 질문도 제시해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어.',
      '가중치 합 1.0과 세 계산값이 두 원본과 일치하는지 교차확인해.',
      '공동 1위 두 옵션을 cards/option-a.png와 cards/option-b.png로 만들고 네 결과물을 decision-package.zip으로 묶어.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('decision-matrix.xlsx', 'xlsx', ['7.70', '7.75', '6.85'], { sheets: ['원점수', '가중치', '가중 결과'] }),
        textFile('decision-note.md', ['A', '7.70', 'B', '7.75', 'C', '6.85', '민감도']),
        pngFile('cards/option-a.png'), pngFile('cards/option-b.png'),
        zipFile('decision-package.zip', ['decision-matrix.xlsx', 'decision-note.md', 'option-a.png', 'option-b.png'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '46',
    title: '통제 증거·준수 상태 패키지',
    category: 'operations',
    inputs: {
      'controls.csv': 'control,required,evidence,status\n접근검토,true,access-review.txt,완료\n백업복구,true,restore-test.txt,완료\n취약점검사,true,vuln-scan.txt,미완료\n교육,true,training.txt,완료\n',
      'access-review.txt': '검토일 2026-09-01, 예외 0건',
      'restore-test.txt': '복구시험 2026-08-30, RTO 42분, 성공',
      'training.txt': '대상 20명, 이수 20명, 완료'
    },
    command: workflow(
      'controls.csv와 존재하는 증거 파일 세 개를 모두 읽고 필수 통제별 증거 상태를 연결해.',
      '통제·증거·준수 판정 세 시트의 compliance-matrix.xlsx를 만들어.',
      '4개 중 3개 완료, 취약점검사 미완료와 vuln-scan.txt 부재를 compliance-report.docx에 정확히 기록해.',
      'workspace에서 두 산출물을 다시 검색하고 문서의 완료 수와 누락 증거명을 확인해.',
      '나머지 증거의 날짜·RTO 42분·20명 이수가 원본과 일치하는지 교차확인해.',
      '두 결과물과 존재하는 증거 세 개를 compliance-package.zip으로 묶고 총 5항목을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('compliance-matrix.xlsx', 'xlsx', ['접근검토', '백업복구', '취약점검사', '교육'], { sheets: ['통제', '증거', '준수 판정'] }),
        officeFile('compliance-report.docx', 'docx', ['3개', '취약점검사', 'vuln-scan.txt', '42분', '20명']),
        zipFile('compliance-package.zip', ['compliance-matrix.xlsx', 'compliance-report.docx', 'access-review.txt', 'restore-test.txt', 'training.txt'])
      ],
      missing: ['vuln-scan.txt'],
      unchangedInputs: true
    }
  },
  {
    id: '47',
    title: '필수 계약 부속서 누락 안전 중단',
    category: 'expected-stop',
    inputs: {
      'contract-main.txt': '계약 본문. 제7조 세부 서비스 수준과 위약금은 annex-sla.csv를 따른다. 부속서 확인 전 최종 승인 금지.',
      'approval-rule.txt': 'annex-sla.csv의 uptime, response_minutes, penalty 값을 모두 검증해야 승인 문서를 만들 수 있다.'
    },
    command: workflow(
      'contract-main.txt와 approval-rule.txt를 모두 읽고 필수 부속서 이름과 검증 필드를 확인해.',
      'workspace에서 annex-sla.csv를 정확한 이름으로 검색해.',
      '부속서가 없으면 계약 본문만으로 uptime·응답시간·위약금을 추정하지 말아.',
      '누락 파일 annex-sla.csv와 필요한 세 필드를 사용자에게 알려 제공을 요청해.',
      '부속서 제공 전에는 contract-approval.docx, contract-check.xlsx, contract-package.zip을 생성하지 말아.'
    ),
    expected: {
      status: 'EXPECTED_STOP',
      files: [
        { path: 'contract-approval.docx', type: 'docx', absent: true },
        { path: 'contract-check.xlsx', type: 'xlsx', absent: true },
        { path: 'contract-package.zip', type: 'zip', absent: true }
      ],
      missing: ['annex-sla.csv'],
      unchangedInputs: true
    }
  },
  {
    id: '48',
    title: '프로젝트 종료 근거 종합·장기보관',
    category: 'comprehensive-local',
    inputs: {
      'closure/plan.txt': '목표: 주민 50명 교육. 성공기준: 수료 40명 이상. 예산 1200000원. 기간 2026-08-01~2026-08-31.',
      'closure/results.csv': 'metric,target,actual\n참가,50,54\n수료,40,46\n만족도,4.0,4.5\n지출,1200000,1130000\n',
      'closure/issues.txt': '장소 변경 1회 발생, 대체 장소로 2시간 내 전환. 개인정보 사고 0건. 미결 조치 0건.'
    },
    command: workflow(
      'closure 폴더의 plan.txt, results.csv, issues.txt를 찾아 모두 읽어.',
      '목표 대비 실제·차이·달성 여부를 closure-analysis.xlsx의 계획·실적·판정 세 시트에 작성해.',
      '수료 46명, 만족도 4.5, 지출 1130000원, 장소 대응 2시간, 사고와 미결 0건을 closure-report.hwpx에 근거별로 작성해.',
      'workspace에서 두 결과물을 다시 검색하고 핵심 수치를 교차확인해.',
      '성과와 대응을 cards/closure-results.png와 cards/closure-response.png로 만들어.',
      '두 문서·카드 두 장·원본 세 개를 closure-evidence.zip으로 묶고 총 7항목을 확인해.',
      '결과 파일과 ZIP을 다시 찾아 파일명과 개수를 확인한 경우에만 완료로 보고해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('closure-analysis.xlsx', 'xlsx', ['54', '46', '4.5', '1130000'], { sheets: ['계획', '실적', '판정'] }),
        officeFile('closure-report.hwpx', 'hwpx', ['46명', '4.5', '1130000', '2시간', '0건']),
        pngFile('cards/closure-results.png'), pngFile('cards/closure-response.png'),
        zipFile('closure-evidence.zip', ['closure-analysis.xlsx', 'closure-report.hwpx', 'closure-results.png', 'closure-response.png', 'plan.txt', 'results.csv', 'issues.txt'])
      ],
      unchangedInputs: true
    }
  },
  {
    id: '49',
    title: '분기 경영실적 이사회 패키지·자기메일',
    category: 'comprehensive-email',
    allowExternalSend: true,
    inputs: {
      'quarter.csv': 'metric,q2,q3,target\n매출,850000000,920000000,900000000\n영업이익,95000000,112000000,100000000\n활성고객,12000,13800,13500\n장애시간,75,38,45\n',
      'quarter-notes.txt': 'Q3 신규 파트너 3곳. 주요 위험은 공급 지연. 다음 분기 행동: 대체 공급처 2곳 계약, 장애시간 30분 이하 추진.'
    },
    command: workflow(
      'quarter.csv와 quarter-notes.txt를 모두 읽고 Q2 대비 Q3 변화와 목표 달성 여부를 계산해.',
      '원자료·증감·목표 판정 세 시트의 quarter-board.xlsx를 만들어.',
      '실적·파트너 3곳·공급 지연·다음 행동을 quarter-board.docx에 근거 수치와 함께 작성해.',
      'workspace에서 두 산출물을 다시 검색하고 매출 920000000원·영업이익 112000000원·활성고객 13800·장애 38분을 교차확인해.',
      '핵심 성과와 다음 행동을 cards/quarter-results.png와 cards/quarter-actions.png로 만들어.',
      '두 문서와 카드 두 장을 quarter-board-package.zip으로 묶고 네 항목을 확인해.',
      '검증된 ZIP 한 개만 내 구글 메일로 제목 [JARVIS-50:C49] Q3 이사회 검증 패키지로 한 번 보내고 SMTP 수락을 확인해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        officeFile('quarter-board.xlsx', 'xlsx', ['920000000', '112000000', '13800', '38'], { sheets: ['원자료', '증감', '목표 판정'] }),
        officeFile('quarter-board.docx', 'docx', ['파트너 3', '공급 지연', '대체 공급처 2']),
        pngFile('cards/quarter-results.png'), pngFile('cards/quarter-actions.png'),
        zipFile('quarter-board-package.zip', ['quarter-board.xlsx', 'quarter-board.docx', 'quarter-results.png', 'quarter-actions.png'])
      ],
      email: {
        subjectContains: '[JARVIS-50:C49]',
        attachmentCount: 1,
        attachmentPaths: ['quarter-board-package.zip'],
        idempotencyKey: 'jarvis-complex-workflow-50-C49-v1'
      },
      unchangedInputs: true
    }
  },
  {
    id: '50',
    title: '복합 운영상황 총괄보고·검증묶음·자기메일',
    category: 'comprehensive-email',
    allowExternalSend: true,
    inputs: {
      'ops/events.log': '08:00 deploy version=4.2.0 success\n08:15 latency p95=780ms warning\n08:20 autoscale 4->7 success\n08:28 latency p95=410ms recovered\n09:00 payment errors=12 warning\n09:07 rollback payments success\n09:12 payment errors=0 recovered\n',
      'ops/owners.csv': 'area,owner,sla_minutes\nplatform,김하늘,30\npayments,이지민,15\ncommunications,박서준,20\n'
    },
    command: workflow(
      'ops/events.log와 ops/owners.csv를 찾아 모두 읽고 사건·복구·담당·SLA를 연결해.',
      '배포 성공, 지연 780ms에서 410ms 회복, 결제 오류 12건에서 0건 회복을 executive-ops-report.md에 시각과 함께 작성해.',
      '사건·담당·SLA 판정 세 시트의 executive-ops.xlsx를 만들고 platform과 payments 모두 SLA 안에 복구됐는지 계산해.',
      'workspace에서 두 결과물을 다시 검색하고 markdown을 다시 읽어 모든 수치와 담당자를 교차확인해.',
      '배포·성능 회복·결제 회복을 cards/ops-deploy.png, cards/ops-latency.png, cards/ops-payment.png로 만들어.',
      '보고서·엑셀·카드 세 장을 executive-ops-package.zip으로 묶고 다섯 항목을 확인해.',
      '검증된 executive-ops-report.md와 executive-ops-package.zip 두 개만 내 구글 메일로 제목 [JARVIS-50:C50] 운영 총괄 검증본으로 한 번 보내.',
      'SMTP 수락과 첨부 두 개가 확인된 경우에만 완료로 보고해.'
    ),
    expected: {
      status: 'COMPLETED',
      files: [
        textFile('executive-ops-report.md', ['4.2.0', '780ms', '410ms', '12건', '0건', '김하늘', '이지민']),
        officeFile('executive-ops.xlsx', 'xlsx', ['platform', 'payments', 'SLA'], { sheets: ['사건', '담당', 'SLA 판정'] }),
        pngFile('cards/ops-deploy.png'), pngFile('cards/ops-latency.png'), pngFile('cards/ops-payment.png'),
        zipFile('executive-ops-package.zip', ['executive-ops-report.md', 'executive-ops.xlsx', 'ops-deploy.png', 'ops-latency.png', 'ops-payment.png'])
      ],
      email: {
        subjectContains: '[JARVIS-50:C50]',
        attachmentCount: 2,
        attachmentPaths: ['executive-ops-report.md', 'executive-ops-package.zip'],
        idempotencyKey: 'jarvis-complex-workflow-50-C50-v1'
      },
      unchangedInputs: true
    }
  },
];
