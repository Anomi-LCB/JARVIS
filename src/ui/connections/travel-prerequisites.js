// Official access research, not a credential or runtime readiness registry.
export const travelPrerequisites = Object.freeze([
  {id:'tago-rail',label:'한국 철도 시간표 · TAGO',checkedAt:'2026-10-04',scope:'출발·도착역의 열차 시간표 조회',
   conditions:'공공데이터포털 활용신청·인증키 필요. 개발·운영 자동승인, 무료, 개발 트래픽 10,000으로 안내됩니다.',
   state:'이 화면에 조회 어댑터 미연결',next:'공식 명세와 보호 키 저장 경로를 연결한 후 실제 응답·페이지 전체·최신성을 검증합니다.',
   limit:'좌석 확보·예약·결제 API로 확인한 자료가 아닙니다.',url:'https://www.data.go.kr/data/15098552/openapi.do'},
  {id:'korail-rail',label:'코레일 승차권',checkedAt:'2026-10-04',scope:'공식 예매 사이트 및 운행계획 공개 샘플 확인',
   conditions:'기존 letskorail.com은 korail.com으로 이동합니다. 공개 샘플은 열차 운행계획 정보를 표시합니다.',
   state:'자동 예약·결제 미연결',next:'공식 사이트에서 여정·인원·할인·좌석·총액을 확인하세요. 자동 연결은 제공자 허용 경로와 로그인 인계·영수증 검증이 필요합니다.',
   limit:'검토한 공개 자료에서 범용 예약 API 계약은 확인하지 못했습니다. API가 없다는 단정은 아닙니다.',url:'https://www.korail.com/'},
  {id:'sr-rail',label:'SR 승차권',checkedAt:'2026-10-04',scope:'공식 일반승차권 조회·예약·결제·발권 경로',
   conditions:'공식 화면에 출발·도착·일시·인원·좌석 조건과 미등록 고객 예매 메뉴가 표시됩니다. 명절 전용 조건을 평시 조건으로 일반화하지 않습니다.',
   state:'자동 예약·결제 미연결',next:'공식 예매 화면에서 조건을 확인하세요. 로그인·인증은 해당 서비스에서 직접 진행하고 이후 예약 기록을 대조해야 합니다.',
   limit:'이 화면에서 계정·좌석·발권을 확인하지 않았습니다. 공개 예약 API 권한도 미확인입니다.',url:'https://etk.srail.kr/hpg/hra/01/selectScheduleList.do?pageId=TK0101010000'},
  {id:'duffel-flight',label:'Duffel 항공',checkedAt:'2026-10-04',scope:'현재 JARVIS는 시험 환경의 기존 견적 조회 경로만 구현',
   conditions:'공식 흐름은 검색→선택 견적 재조회→승객·결제 자료→주문입니다. 견적은 만료되므로 실행 직전 재조회가 필요합니다.',
   state:'예약·결제·취소 미연결',next:'보호 설정과 중개 서비스의 시험 계정을 준비한 후 기존 견적 조회를 실제 API로 검증합니다.',
   limit:'키 저장이나 로컬 중개 테스트는 공급자 연결 성공·예약 성공이 아닙니다.',url:'https://duffel.com/docs/guides/getting-started-with-flights'},
  {id:'amadeus-flight',label:'Amadeus 항공 · 대안',checkedAt:'2026-10-04',scope:'공개 Self-Service 검색·가격·주문 경로 조사',
   conditions:'운영 Flight Create Orders는 승인 시장·현지 조건 및 발권 consolidator 계약 등 접근 조건이 있습니다. 환불은 consolidator를 통해 처리하도록 안내합니다.',
   state:'JARVIS 연결 어댑터·계정 미검증',next:'한국의 운영 접근 가능 여부와 발권 계약을 공급자에게 확인한 후 시험 환경 어댑터를 비교합니다. 임의로 가입·계약·결제하지 않습니다.',
   limit:'공개 API의 존재는 한국 계정의 운영 접근·전체 항공사·예약·환불 자동화 가능 증거가 아닙니다.',url:'https://admin.developers.amadeus.com/self-service/apis-docs/guides/developer-guides/faq/'}
].map(item=>Object.freeze(item)));
export function renderTravelPrerequisites(escape) {
  return `<section aria-label="철도와 여행 연결 조건"><h2>철도와 여행 연결 조건</h2><p>공식 자료 확인: 2026.10.04 · 아래 내용은 연결 조건 안내입니다. 실제 계정·예약 준비도와 구분합니다.</p>${travelPrerequisites.map(item=>`<article data-travel-prerequisite="${escape(item.id)}"><h3>${escape(item.label)}</h3><p><strong>${escape(item.state)}</strong></p><p>${escape(item.scope)}</p><p>${escape(item.conditions)}</p><p>${escape(item.limit)}</p><p>다음 단계: ${escape(item.next)}</p><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">공식 안내 열기</a></article>`).join('')}</section>`;
}
