import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/local-model-failure-meter-20261008',observedAt=new Date().toISOString(),candidateId='local-ollama-mission-provider';
if(!runResearchLedger(['status']).candidates.some(c=>c.id===candidateId))throw Error('KNOWN_CANDIDATE_REQUIRED');
const write=(path,value)=>writeFile(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const tests=await readFile(prefix+'-final-tests.txt','utf8'),baseline=await readFile(prefix+'-baseline.txt','utf8');
for(const m of ['ℹ pass 91','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0'])if(!tests.includes(m))throw Error('FINAL_TEST_REQUIRED:'+m);
if(!baseline.includes('ℹ fail 2'))throw Error('BASELINE_REQUIRED');
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS executive console'))throw Error('BUILD_REQUIRED');
if(!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('CONTRACT_REQUIRED');
const actualPath='artifacts/local-model-clarification-20261008/failure-0.json',actual=JSON.parse(await readFile(actualPath,'utf8'));
if(actual.code!=='A_LOCAL_MODEL_TRANSPORT_ERROR'||actual.diagnostics.providerCalls!==2||actual.receipt.providerCalls!==null)throw Error('ACTUAL_PRE_FIX_OBSERVATION_REQUIRED');
const sources=['packages/core/src/mission/model-provider.js','packages/core/src/mission/local-model-observation.js','tests/model-provider.test.js'];
await write(prefix+'-source.json',await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))));
await write(prefix+'-report.md',`# 실제 로컬 모델 실패의 호출·사용량 기록 수정\n\n관측 ${observedAt}. 이전 확인 답변 수정은 완료했다. 현재 인수 큐100개를 원장과 다시 대조한 결과 verified60/in_progress23/pending17, 증거 경로 누락0이다. 경로 존재가 실사용 성과 검증이라는 의미는 아니다.\n\n합성 파일과 삭제 금지 요청을 기존 gemma3:latest 4.3B Q4_K_M 모델에 전달하고 실제 Core/E/PC/G 계획 경로를 실행했다. 이 격리 후보 구성은 결정형 우회 함수를 제외하여 모델 계획을 직접 관측한다. 실제 첫 호출은 ${Math.round(actual.receipt.latencyMs)}ms 후 A_LOCAL_MODEL_TRANSPORT_ERROR로 실패했다. 모델 내부 진단에는 HTTP 호출2회(목록 확인+생성 요청)가 있었으나 공통 receipt에는 providerCalls=null로 누락됐다. 토큰·비용은 응답이 없어 미측정이며 0으로 계산하지 않는다. 이 오류만으로 CPU 속도·메모리·서버·클라이언트 시간 제한 중 정확한 원인을 확정하지 않는다.\n\n별도 회귀에서 길이 제한/잘못된 JSON으로 실패한 모델의 이미 관측된 입력·출력 토큰도 공통 계층에서 사라지는 결함2개를 재현했다(수정 전35검사 중2실패). 공통 모델 계층이 로컬 실패 진단을 재정규화한 뒤 관측된 호출과 토큰을 실패 receipt에 보존하도록 수정했다. 출력 원문·공급자 임의 문구·가격·자격증명은 복사하지 않는다. 누락된 토큰·비용은 미측정, 부분 측정은 부분 상태 그대로 남긴다. 모델 실패는 계속 실패로 처리하며 실행 권한이나 완료 판정을 늘리지 않는다.\n\n최종 **91개 고유 회귀 통과, 실패0/건너뜀0/취소0**, build/API 계약 검사 통과. 실제 계획기까지 거부된 출력의 사용량 전달을 확인했고 응답 손실은 HTTP2회/토큰미측정, 모델 미설치는 HTTP1회/토큰미측정으로 구분했다. 중간55/90 재실행은 합산하지 않는다. 이는 모델의 이해력이나 속도가 개선됐다는 결과가 아니다.\n\n실제 모델 파일 실험은 이 보고서 기록 시 아직 진행 상태이므로 최종 성공/실패·질문 필요성은 별도 종료 증거로 판단한다. 첫 프로세스는 수정 전 모듈을 이미 import했으므로 sources-before-meter-fix.json을 그 호출의 소스 기록으로 보존했고 현재 수정 소스와 혼동하지 않는다. 모델 서버는 사용자의 기존 프로세스를 재사용했으며 종료·언로드·설정 변경하지 않았다. 알려진 기존 모델만 호출하고 설치·cloud 모델·실계정·유료 API·개인 정보는 사용하지 않았다.\n\n실험 스크립트에서 budget 대신 budgets가 실제 계약 필드임을 확인해 다음 실행용 소스를 정정했다. 이미 실행 중인 첫 실험의 실제 Mission budget을 이 정정으로 소급 변경했다고 주장하지 않는다. 다음 실행은 plannerCalls2 제한을 명시적으로 적용한다.\n\n[Ollama 생성 API](https://docs.ollama.com/api/generate)의 종료 사유·토큰 수·시간 필드와 [구조화 출력 문서](https://docs.ollama.com/capabilities/structured-outputs)를 대조했다. JSON 형식이 의미 정확성이나 작업 완료를 보장하지 않는다는 기존 기준을 유지한다.\n\n공식 인수 **60/100 유지**, V3-022 비교 기록의 부분 증거다. Responses/도구 검색/프로그램형 호출의 실제 비교, 독립26/260 의미평가, 실계정/설치본/장기관측은 미완료. 다음은 현재 실행의 종료 원인·파일 상태 확인 후 실제 모델 구성과 하드웨어 조건을 반영한 비교다.\n`);
const evidencePaths=[prefix+'-report.md',prefix+'-baseline.txt',prefix+'-final-tests.txt',prefix+'-build.txt',prefix+'-contract.txt',prefix+'-source.json',
 actualPath,'artifacts/local-model-clarification-20261008/sources-before-meter-fix.json','artifacts/local-model-clarification-20261008/contract.json'];
await write(prefix+'-attempt.json',{id:'local-model-failure-meter-20261008',candidateId,kind:'contract-test',reportedOutcome:'passed',observedAt,
 hypothesis:'Failed local model generations must preserve measured calls/tokens through the shared runner and actual planner accounting.',
 lesson:'Real transport failure lost two measured calls; unit reproduction also lost measured tokens. Canonical failure diagnostics now flow into receipts without invented usage/cost or provider prose.',
 limitations:'91 local regressions and one pre-fix real transport failure; real model workflow still pending when recorded. No model quality/speed/26-or-260/remote provider or live account acceptance.',evidencePaths});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),gate=a.stages.flatMap(s=>s.gates).find(g=>g.id==='V3-022');
gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations=[...(gate.limitations??[]),'2026-10-08 실제 로컬 모델 첫 요청303초 transport 실패/HTTP2회 공통계층 누락·출력실패 토큰누락2반례 수정,91회귀/build/contract. 파일실험 종료·질문판정/Responses등 비교·실사용 미완료.'];
a.updatedAt=observedAt;await writeFile(path,JSON.stringify(a,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제로컬모델 첫303초응답실패 관측/공통 실패 호출·토큰누락 수정91검사/build/contract. 공식60/100 유지. 실제 파일 실험 진행중, 다음 소유 handle60030 종료 관측과 결과 확인; 재시작하지 말 것.\n`);
console.log(JSON.stringify(runResearchLedger(['record',prefix+'-attempt.json'])));
