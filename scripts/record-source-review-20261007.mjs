import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const dir='artifacts/research-source-review-20261007', read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''), put=(name,value)=>writeFileSync(`${dir}/${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const observations=JSON.parse(read(`${dir}/observations.json`));
const text=read('artifacts/research-heartbeat-20261007-040042-status.txt');
// npm appends a SQLite warning after its JSON object.
const end=text.lastIndexOf('\n}')+2;
const status=JSON.parse(text.slice(text.indexOf('{'),end));
const review=status.candidates.map(c=>({id:c.id,nextReason:c.nextReason,attemptCount:c.attemptCount,
  evidenceIssues:c.attempts.flatMap(a=>a.evidence.filter(e=>e.integrity!=='intact'||e.sourceIntegrity!=='intact').map(e=>({attemptId:a.id,path:e.path,integrity:e.integrity,sourceIntegrity:e.sourceIntegrity}))),
  latestOutcome:c.attempts[0]?.reportedOutcome??'not-run'}));
put('ledger-review.json',{observedAt:observations.observedAt,candidates:review});
const catalogPath='config/research-candidates.json', catalog=JSON.parse(read(catalogPath));
const candidate=catalog.candidates.find(c=>c.id==='jev-typed-decision-cascade');assert(candidate);
assert(!candidate.sources.some(s=>s.url==='https://developers.openai.com/api/docs/guides/decisions'));
put('candidate-before.json',candidate);
candidate.sources.push(
 {url:'https://developers.openai.com/api/docs/guides/decisions',checkedAt:'2026-10-07',revision:'Public beta gpt-6-luna; POST /v1/decisions; predicate/choice/score/refusal; speed claim not JARVIS measurement; SDK JS >=7.30.0.'},
 {url:'https://developers.openai.com/api/reference/resources/decisions/methods/create',checkedAt:'2026-10-07',revision:'Official API reference viewed through web tool; .md export returned404 and was not treated as evidence of absent API.'});
candidate.nextExperiment+=' 2026-10-07: OpenAI Decisions beta도 같은 기존 선택 판단 비교의 후보로 추가한다. 결정형/실제 Laya 탈락 기록을 보존한다. 고정 한국어 분류 및 명시적 금지 사례에 대해 동일 입력으로 비교하고 거부·이름 누락/중복·범위 밖 선택·낮은 확신에서 기존 planner로 인계한다. confidence는 E 권한이나 G 완료 근거가 아니다. 외부 전송/예산/인증이 준비되기 전 API 호출은 하지 않는다. 전체 요구 보존·실제 결과·p50/p95·재시도 포함 비용으로 승격하며 업체10배 주장은 미측정으로 남긴다.';
writeFileSync(catalogPath,JSON.stringify(catalog,null,2)+'\n');put('candidate-after.json',candidate);
const acceptance=JSON.parse(read('docs/universal-control-v3-acceptance.json')), verified=acceptance.stages.flatMap(s=>s.gates).filter(g=>g.status==='verified').length;
put('report.md',`# 공식 출처 검토 — 2026-10-07\n\n관측 ${observations.observedAt}. research:watch → ledger sync → status를 순서대로 실행했다. 6출처 중4 raw 변경·2동일·오류0. raw 변경은 출시/성능/제품 활성화가 아니므로 본문을 다시 조회했다. 원래 인수 ${verified}/100 유지.\n\n## 판단 속도 후보\n\n[OpenAI 변경 기록](https://developers.openai.com/api/docs/changelog)의10월6일 항목과 [Decisions 안내](https://developers.openai.com/api/docs/guides/decisions), [API 계약](https://developers.openai.com/api/reference/resources/decisions/methods/create)을 대조했다. 공개 베타의 gpt-6-luna 전용 엔드포인트가 확률·고정 선택·점수 판정을 제공한다. 임의 구조 생성이나 도구 실행은 기존 Responses 경로와 구분한다. 속도10배는 공급자 주장이고 JARVIS 실측이 아니다. 기존 Jev 후보에 대안과 다음 비교를 추가했고 별도 실행 시스템/중복 후보는 만들지 않았다.\n\n로컬 결정형 Core/E/B/G 비교와 실제 Laya 실패 증거를 기준선으로 유지한다. 다음 실험은 한국어·정정·부정 요구 보존과 전체 지연·재시도·비용을 같은 조건에서 비교하는 것이다. 이름/형식/범위 검사와 refusal/fallback은 계약 검사일 뿐 의미 정확도 증명이 아니다. 모델의 confidence로 E 권한을 승인하거나 G 결과 검증을 대신하지 않는다. 이번에는 API 호출·SDK 설치·제품 라우팅 변경·외부 데이터 전송을 하지 않았다. 인증/예산/전송 조건과 실제 성능은 미확인이다.\n\n## 지속 실행/보안 검토\n\n[Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)와 [SDK](https://developers.openai.com/api/docs/guides/agents/sdk)의 본문을 보존했다. 관리형 세션·환경·재개 기능이 있지만 JARVIS 원장/권한/독립 결과 검증을 대체하지 않는다. 이 두 페이지의 과거 본문 스냅샷과 의미 비교는 하지 않았으므로 이번 raw hash 변화가 기능 추가라는 결론을 내리지 않는다.\n\nGoogle RSS의10월5일 [맥락 기반 에이전트 보안 연구](https://research.google/blog/open-and-emergent-problems-in-agentic-privacy-and-security-a-contextual-angle/)와 공식 출판 초록을 읽었다. 자료 유형·보내는 사람·받는 사람·전송 목적을 함께 검사하는 supervisor 방향은 기존 E 정책·목적 제한·별도 실행 권한과 맞는다. 이는 미해결 연구 문제를 정리한 보고서이며 즉시 설치 가능한 보안 제품/완성된 벤치마크로 계산하지 않는다. 후속은 같은 계정·수신자라도 목적/자료 종류가 바뀌면 전송을 막는 기존 E 경로의 반례다. 모든 계정/도구에서 이미 구현됐다고 주장하지 않는다.10월6일 Earth AI 항목은 RSS 제목/날짜만 확인했으며 개인 건강 워치 연결의 해결책으로 채택하지 않았다.\n\n## 증거와 한계\n\n공식 Markdown5경로 중4원문과 RSS를 관측시각·URL·hash로 보존했다. API reference .md404는 web의 HTML 공식 계약 조회로 보완했고 수집 실패도 observations에 남겼다. 후보52개의 최신 검토 이유·보고 결과·증거 변경/누락을 ledger-review.json에 보존했다. 원래 경로 변경과 보존 스냅샷 손상을 구별하며 파일 해시는 결론의 독립 검증이 아니다. F/cognition의 실제 업무 기억·운영서비스·설치본·기기·실계정은 수정하지 않았다. 유료 API 호출0; 실제 API 품질/지연/가격 비교 및 전체 개발비는 미측정. 이번 결과는 출처 검토이고 개발 실험 통과나 인수 승격이 아니다.\n`);
put('attempt.json',{id:'typed-decisions-source-review-20261007',candidateId:candidate.id,kind:'source-review',reportedOutcome:'passed',observedAt:new Date(observations.observedAt).toISOString(),
 evidencePaths:['report.md','observations.json','ledger-review.json','agents-api.md','agents-sdk.md','changelog.md','decisions.md','google-research.xml','candidate-before.json','candidate-after.json'].map(n=>`${dir}/${n}`),
 hypothesis:'새 유형별 판단 API를 기존 Jev 비교 후보에 추가할 수 있는지, 실행·권한·결과 검증과 구분해 공식 계약을 확인한다.',
 lesson:'10월6일 Decisions 베타 출시와 전용 판단 계약을 확인했다. 기존 결정형 경로와 Laya 실패를 보존하고 모델 확신을 실행 권한으로 삼지 않는 비교 조건을 추가했다.',
 limitations:'Source review only; no live API/SDK installation/adapter activation, Korean quality/total latency/cost unmeasured; budget/auth/data conditions not verified; original59% unchanged.'});
console.log(JSON.stringify({observedAt:observations.observedAt,verified,candidates:review.length,issues:review.filter(c=>c.evidenceIssues.length).length,definitionUpdated:candidate.id}));
