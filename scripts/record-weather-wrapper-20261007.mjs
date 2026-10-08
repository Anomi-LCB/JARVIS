import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/weather-wrapper-20261007',observedAt=new Date().toISOString();
const log=await readFile(prefix+'-final-regression.txt','utf8');
if(!log.includes('ℹ fail 0')||!log.includes('ℹ pass 30'))throw Error('Final regression not complete');
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['apps/pc-agent/src/pc-agent-runtime.js','tests/weather-hwp-workflow.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 날씨 한글 보고서: 실행 문맥과 렌더 요구 보존

관측 ${observedAt}. 공식60/100 유지. 이번 제품 활성화·서비스 재시작·설치본 적용0.

공통 effect 색인에서 제외된 weather.createHwpReport의 실제 구현을 대조했다. 새 반례4개 전부 기준선 실패: 취소된 작업도 예보 조회·문서 작성, 예보 응답 중 권한철회 이후 작성, HwpCreateToolAdapter로 signal/assertAccess/beforeArtifactWrite 문맥 미전달, verifyRendering 요구·잘못된 옵션 소실. 기준선 로그를 보존했다.

Weather wrapper는 시작/예보 이후 현재 권한·취소를 검사하고 기존 HWP 제작기에 동일 context와 verifyRendering을 전달한다. 잘못된 boolean 옵션은 예보 조회 전 차단한다. 기존 구조화 날씨 표·출처 증거는 유지한다. fake author 테스트4개는 wrapper 계약 검사이며 실제 한글 파일 생성 증거가 아니다. 추가1개는 실제 HwpCreateToolAdapter의 beforeArtifactWrite에 도달해 요청 표를 검사하고 거부 시 파일이 없음을 확인한다. 기존 예보HTTP·Core 계획·문서계약 검사도 유지했다.

최종 고정 검사32개 중30통과/실패0/skip2. skip은 JARVIS_NATIVE_HWP_TEST 미설정에 따른 계획→실제 Hancom 렌더/G2건으로 이번 native 렌더 성공에 포함하지 않는다. build 및 core:contract-gate exit0. 중간 검사1건은 테스트 readFile import 누락으로 실패했고 수정 후 전체 재실행했다. 초기15개 검사·중간 로그를 최종 수치와 중복 집계하지 않는다.

비용 미측정, 실제 예보API·실계정·유료 호출·발송 없음. 시험은 합성 forecast/HTTP fixture와 격리 경로다. F/cognition 실제 업무 기억을 시험 성공으로 채우지 않았다. 이 context 전달은 common SQL effect/원래 예보 스냅샷/공급자 장애 처리/전체 HWP 실제렌더 인수를 완료한 것이 아니다. 현재 예보 요청 자체는 AbortSignal을 받지 않아 취소 후 응답이 올 때까지 기다릴 수 있으나 응답 후 작성은 차단한다. 이후 common effect 바인딩·예보 취소/시간 제한·실제 렌더 관측을 이어 진행한다. 복원은 wrapper signature/검사/인수전달 소스 변경을 이전 버전으로 되돌리는 방식이다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'weather-wrapper-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'contract-test',reportedOutcome:'passed',observedAt,hypothesis:'날씨 wrapper가 기존 한글 제작기의 권위/취소/게시검사 문맥과 렌더 요구를 보존하면 호출 중 철회 및 요구 소실로 인한 잘못된 제작을 차단할 수 있다.',lesson:'보호된 내부 제작기가 있어도 상위 wrapper가 context와 요구를 버리면 통합 계약이 성립하지 않는다.',limitations:'최종30pass/2native skip, 합성예보와 실제HWP게시거부. commonSQL/실예보/native렌더/운영활성화미완료, 비용미측정, 공식60유지.',evidencePaths:['-report.md','-source.json','-baseline.txt','-final-regression.txt','-stable.txt','-build-stable.txt','-contract-stable.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: weather wrapper context/취소/권한철회/렌더요구4반례 수정·실제HWP게시거부·30pass/2native skip/build/contract. 공식60·운영활성화0. 다음 weather commonSQL/예보취소와 원래100인수.\n`);
