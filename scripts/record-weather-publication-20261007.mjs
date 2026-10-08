import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/weather-publication-20261007',observedAt=new Date().toISOString();
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['apps/pc-agent/src/pc-agent-runtime.js','tests/weather-hwp-workflow.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 날씨 예보와 문서 제작 준비 계약

관측 ${observedAt}. 공식60/100 유지. SQL 효과 연결 전체는 미완료다. 운영서비스 재시작·설치본 적용0.

등록 쓰기 감사에서 weather.createHwpReport가 공통 SQL 효과 경로에 없음을 확인한 기존 색인을 이어 대조했다. HWP 원래 문서 계약은 이미 있지만 weather는 execute 때 예보를 새로 조회한다. 그대로 prepare와 execute를 두 번 호출하면 다른 예보와 원래 문서 계약이 섞일 수 있다.

WeatherHwpReportToolAdapter.preparePublication을 추가했다. 취소/권위 확인→한 번 예보 조회→구조화 HWP 인수→실제 HwpCreateToolAdapter.preparePublication 순서로 requestSha256/reportSha256/report/hancomPublication을 반환한다. execute는 내부 context.weatherPublication이 있는 경우 해당 예보를 재사용하고 요청해시·예보해시·재생성한 한글 계약을 대조한다. 없는 경우 기존 조회 경로를 유지한다. 준비 계약은 model 인수에 추가하지 않았다. 해시는 변조 권한 검사가 아니라 내용 결속이며 trusted context 전달/SQL 원장 권위는 후속 연결이 필요하다.

최종31/31 실패0/skip0, build/core:contract-gate exit0. 새4개 중1개는 합성 예보를 한 번 조회하고 JSON 직렬화 뒤 새 adapter에 전달, 두 번째 조회0, 실제 HWP 게시 guard에서 원래 계약 일치 확인 및 의도적 거부/파일없음을 검증한다. 다른3개는 request/report/document 변경을 거부하고 게시guard 진입0/파일없음 확인이다. 기존 날씨/취소/실로컬HTTP 수신 제한27개도 유지했다. 실제 파일 완성·다른 프로세스·SQL 재시작 증거가 아니다. 초기27개와 최종을 중복 합산하지 않는다.

비용 미측정. 실제 외부 예보·유료호출·실계정·발송0, F/cognition 실제업무 기억에 합성 성공 기록0. 새 기능의 preparation 계약 검사이며 기존 전체SQL 복구 결함을 해결했다고 주장하지 않는다. 사용자가 요청하지 않은 출력이나 원문 출처를 임의 생성하지 않았다.

남은 연결: Core가 승인된 읽기 경계에서 snapshot을 준비해 원래 효과 SQL intent에 저장, B private fence를 통해 전달, HWP 전체 claim/receipt와 원래 예보 evidence를 검증, 새PID 중단복구에서 재조회·중복제작 방지, 의미/현재산출물 G검증. 현재 생성된 해시를 공격자가 함께 바꾸는 상황은 저장된 원장 원문과 비교해야 하며 이번 helper만으로 차단됐다고 볼 수 없다. 실예보 freshness/총기한/설치본 인수 및 원래100개 요구도 남았다. 소스 복원은 새 preparePublication/documentArgs와 pinned context 분기를 제거하고 기존 문서 인수 구성을 복원하는 방식이다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'weather-publication-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'contract-test',reportedOutcome:'passed',observedAt,hypothesis:'원래 예보와 구조화 한글 제작 계약을 한 준비 단위로 결속하고 execute에서 재사용하면 두 번 조회로 인한 원문·산출물 불일치를 방지할 기반을 만들 수 있다.',lesson:'내부 문서 계약과 외부 읽기 결과를 같은 준비 기록에 묶어야 한다. helper 통과는 SQL 권위·복구 완료가 아니다.',limitations:'31/31·실제HWP게시거부/합성예보, SQL/새PID/실제문서/G/설치활성화 미완료·공식60유지·비용미측정.',evidencePaths:['-report.md','-source.json','-first.txt','-final.txt','-build.txt','-contract.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: weather 예보1조회/원래한글 준비계약·직렬화재사용/3변경거부·31/31/build/contract. 공식60·SQL/운영활성화0. 다음 Core SQL intent/B private fence/receipt/G/새PID 복구와 원래100인수.\n`);
