// Desktop entry points reuse the authenticated control-center controls.
// A visible entry never implies a connected account or a verified capability.
export const desktopFeatures = Object.freeze([
  { id: 'command', title: '대화·작업 공간', detail: '자연어 요청, 작업 정정·취소, 결과와 로컬 문서 미리보기', path: '/?workspace=1#chat', glyph: 'E8F2' },
  { id: 'routines', title: '예약·반복 작업', detail: '일회성·주간 예약, 시간대, 실행 기록과 취소', path: '/?workspace=1#routines', glyph: 'E787' },
  { id: 'inbox', title: '메일·일정·Google 연결', detail: '독립 계정 연결 화면에서 인증과 수집 범위 관리', path: '/src/ui/connections/accounts.html', glyph: 'E715' },
  {id:'storedsources',title:'저장 자료 전체 조회',detail:'선택한 저장 연결의 전체 자료 조회·검증 결과·중단을 독립 화면에서 확인',path:'/src/ui/connections/sources.html',glyph:'E8B7'},
  {id:'microsoftcollection',title:'Microsoft 자료 수집',detail:'Outlook·Teams 한 페이지 수집·이전 요청 회수·현재 결과 검증',path:'/src/ui/connections/microsoft.html',glyph:'E8F1'},
  {id:'email',title:'메일 발송 연결',detail:'메일을 보내지 않는 인증 확인·이 프로그램의 발송 사용 중지',path:'/src/ui/connections/email.html',glyph:'E8F3'},
  {id:'pcemail',title:'이 PC의 메일 연결',detail:'현재 PC 서비스의 메일 설정 확인·사용 중지. 원격 계정은 변경하지 않음',path:'/src/ui/connections/pc-email.html',glyph:'E8F4'},
  {id:'travel',title:'여행 견적 연결',detail:'항공 시험 견적의 읽기 조회·중개 연결 상태 확인. 예약·결제 미지원',path:'/src/ui/connections/travel.html',glyph:'E709'},
  { id: 'memory', title: '참고 기억', detail: '일반 문장으로 기억 저장·검색·철회, 고급 대화 가져오기', path: '/?workspace=1#memory', glyph: 'E8BD' },
  { id: 'sources', title: '자료 변경·연구 추적', detail: '자료 버전, 변경 감지와 후속 작업 관리', path: '/#desktop-sources', glyph: 'E9D2' },
  { id: 'delegation', title: '위임·자동 실행 범위', detail: '허용 대상, 유효기간, 예산과 위임 철회', path: '/#desktop-delegation', glyph: 'E8D7' },
  { id: 'models', title: '모델 API 연결', detail: '독립 API 화면에서 보호 키 등록·읽기 검사·삭제', path: '/src/ui/connections/api.html', glyph: 'E950' },
  { id: 'agents', title: '에이전트 연결', detail: '관리형 에이전트 자격증명과 세션 준비 상태', path: '/src/ui/connections/agents.html', glyph: 'E902' },
  { id: 'mcp', title: 'MCP 서버 연결', detail: '이 PC의 MCP 서버 등록·도구 목록 점검·등록 해제', path: '/src/ui/connections/mcp.html', glyph: 'E774' },
  { id: 'devices', title: 'PC·장치 연결', detail: '독립 화면에서 공개 인증서·장치 이름·사용 기간·조회 범위 관리', path: '/src/ui/connections/devices.html', glyph: 'E7F4' },
  { id:'pctasks',title:'이 PC 업무 등록',detail:'계획된 업무의 조회·산출물·명령 후보를 별도 등록',path:'/src/ui/connections/pc-tasks.html',glyph:'E8A5' },
  { id:'pcpermissions',title:'이 PC 실행 허용',detail:'현재 PC의 업무 허용·종료 시각·철회를 독립 화면에서 관리',path:'/src/ui/connections/pc-permissions.html',glyph:'E8D4' },
  { id: 'security', title: '보안·긴급 잠금·복구', detail: '실행 보호, 무결성, 잠금과 복구 검사', path: '/#desktop-security', glyph: 'E72E' },
  { id: 'connections', title: '연결·실행 환경', detail: '독립 실행 환경 화면에서 로컬 Core와 관리 인증 설정', path: '/src/ui/connections/runtime.html', glyph: 'E968' },
  { id: 'skills', title: '스킬·도구·프로필', detail: '등록된 도구, 스킬 구성과 실행 프로필 관리', path: '/src/ui/skill-center/index.html', glyph: 'E713' }
]);
