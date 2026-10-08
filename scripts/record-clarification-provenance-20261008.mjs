import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/clarification-provenance-20261008',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-verified.txt','utf8');
for(const marker of ['ℹ pass 112','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0','"mode":"same-revision-legacy-gate","status":"WAITING_APPROVAL"'])if(!final.includes(marker))throw Error('EVIDENCE_REQUIRED:'+marker);
if(!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('CONTRACT_REQUIRED');
const comparison=JSON.parse(await readFile(prefix+'-comparison.json','utf8'));
if(!comparison.sourceUnchanged||comparison.runs.length!==96)throw Error('COMPARISON_REQUIRED');
const watch=JSON.parse(await readFile('.runtime/research-watch/latest.json','utf8'));
const snapshot=runResearchLedger(['status']);
const research={observedAt,watch,candidates:snapshot.candidates.map(c=>({id:c.id,nextReason:c.nextReason,
 nextExperiment:c.nextExperiment,attemptCount:c.attemptCount,
 failedOrBlocked:(c.attempts??[]).filter(a=>['failed','blocked','inconclusive'].includes(a.reportedOutcome)).map(a=>({id:a.id,reportedOutcome:a.reportedOutcome,lesson:a.lesson,limitations:a.limitations})),
 evidenceIssues:(c.attempts??[]).flatMap(a=>(a.evidence??[]).filter(e=>e.integrity!=='intact'||e.sourceIntegrity!=='intact').map(e=>({attemptId:a.id,path:e.path,integrity:e.integrity,sourceIntegrity:e.sourceIntegrity}))),
 recentAttempts:[...(c.attempts??[])].sort((a,b)=>String(b.observedAt??b.recordedAt).localeCompare(String(a.observedAt??a.recordedAt))).slice(0,3).map(a=>({id:a.id,reportedOutcome:a.reportedOutcome,limitations:a.limitations,
  changedEvidence:(a.evidence??[]).filter(e=>e.integrity!=='intact'||e.sourceIntegrity!=='intact').map(e=>({path:e.path,integrity:e.integrity,sourceIntegrity:e.sourceIntegrity}))}))})),
 reviews:[
  {url:'https://developers.openai.com/api/docs/guides/agents-api/overview',finding:'관리형 session/orchestration/recovery와 도구·실행환경 선택을 분리한다. 현재 JARVIS 원문·권한·결과 대사를 대신하지 않는다.'},
  {url:'https://developers.openai.com/api/docs/guides/agents/sdk',finding:'서버가 도구·저장·승인 결정을 소유하는 SDK 경로는 현재 Core/E/B/G와 결합 후보다. 실호출하지 않았다.'},
  {url:'https://developers.openai.com/api/docs/changelog',finding:'10월7일 chat-latest snapshot/10월6일 Decisions 후보를 재확인. 반복 HTML hash 변화를 새 제품 성과로 세지 않았다.'},
  {url:'https://research.google/blog/does-better-work-always-mean-better-workers/',finding:'10월7일 특허 변호사 현장 연구는 AI 지원 산출물 품질과 도움 없는 전문가 판단을 구분한다. JARVIS 성능으로 환산하거나 새 실행 기술로 채택하지 않았다.'},
  {url:'https://research.google/blog/open-and-emergent-problems-in-agentic-privacy-and-security-a-contextual-angle/',finding:'10월5일 contextual behavioral norms 연구 방향을 재검토. 옛 답변의 맥락 provenance 결함은 로컬 코드로 고치는 경로를 선택했다.'}
 ],limitations:['RSS web 도구 조회 오류 후 공식 블로그 본문으로 대체 확인; 감시 자체는 HTTP200','원문 재검토는 실모델/논문 재현 아님','장부 파일 무결성은 실험 결론의 독립 검증이나 제품 활성화가 아님']};
await writeFile(prefix+'-research.json',JSON.stringify(research,null,2)+'\n',{flag:'wx'});
const paths=['packages/core/src/mission/clarification-context.js','tests/clarification-source-boundary.test.js','tests/clarification-context.test.js','scripts/record-clarification-provenance-20261008.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2)+'\n',{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
const report=[
 '# 이전 확인 답변의 원문 증거 누락 수정',
 `관측 ${observedAt}. 공식 인수 ${counts.verified}/100 유지. V3-020 부분 증거이며 전체 의미 평가·설치본 인수가 아니다.`,
 '## 재현과 수정',
 '이전 승인 gate에 원문 SHA-256이 없을 때 같은 revision 숫자만으로 답변을 재사용하는 결함을 재현했다. 구조화 답변과 단일 자유문 답변 모두 현재 질문에 과거 답변을 잘못 적용했다. 실제 Core/E/PC/G·SQLite 경로에서는 반복 계획 정지로 BLOCKED가 됐다. 최초14검사 중 제품 반례3개와 시험 정리 오류1개가 실패했다. 정리 오류는 열린 remote-operations SQLite를 닫지 않아 EBUSY가 난 별개 시험 수명주기 문제다.',
 '이제 현재 원문 hash와 정확히 일치하는 gate의 답변만 재사용한다. 옛 이력에 새 hash를 만들어 붙이거나 이력을 삭제하지 않는다. 원문에서 정확히 확인 가능한 사실과 정상 hash-bound 답변은 계속 재사용한다. 기존 정상 시험 fixture에는 실제 현재 원문 hash를 명시해 검사 의미를 보존했다.',
 '## 실제 실행 결과',
 '격리된 실제 Core/E/PC/G·SQLite에서 정상 요청은 독립 읽기2회·작성1회·COMPLETED다. 추가 정보 미확인, 다른 원문 hash, hash 없는 옛 gate 세 경우는 읽기2회가 계속되고 작성0회·질문1개 한 묶음·WAITING_APPROVAL로 남았다. 옛 gate를 SQL로 재조회해 hash가 여전히 없고 현재 답변으로 승격되지 않는 것을 확인했다. 이번 시험은 동일 PID의 SQL 재조회이며 별도 PID 재시작 시험으로 보고하지 않는다.',
 '최종 관련10파일 고유112검사 통과·실패0·skip0·cancel0. 집중18검사와 중간37/112 재실행은 중복 합산하지 않았다. build 및 Core 계약 통과. 일반 질문 필요성 판단·답변 의미 정확성·모든 조건/앱·설치 화면·실사용 개입률은 미완료다.',
 '## 고정 비교 실행과 연구 검토',
 '기존 고정 정보 획득 코퍼스 hash를 유지하고 8사례×4경로×3반복=96실행했다. execute의 정답 일치24/24는 파일 생성·재조회21완료와 예상 차단3을 포함한 오라클 일치이며 전체 요청 완료율100%가 아니다. none은3/24, lookup9/24, question21/24 일치이며 실패·차단을 분모에서 제외하지 않았다. execute 획득 p50 208.26ms·p95 237.75ms·전체 p95 246.72ms. 모든 금전 비용은 미측정이다. scripted 계획·합성 응답·로컬 JSON 평가이며 이번 패치 전후 품질 또는 속도 개선량·실모델 우열·블라인드 의미 평가를 입증하지 않는다.',
 '공식 출처6곳 감시에서4변화/2동일/오류0, 장부 sync/status 후 원문 재검토를 research.json에 보존했다. 새 Google 연구의 산출물과 장기 판단 구분을 평가 관점으로 참고했다. 공식 SDK/관리형 API의 사용 조건을 재확인했지만 유료 호출·SDK 설치·실계정 연결·권한 확대·외부 발송은 하지 않았다.',
 '## 다음 작업과 복원',
 '다음은 V3-020의 실제 UI 질문·정정·복구 인수와 독립 의미 평가다. 운영 서비스를 재시작하거나 최신 PC 설치 후보를 덮어쓰지 않았고 사용자 F/cognition 기억을 바꾸지 않았다. 설치 후보에는 이 변경이 아직 포함되지 않는다. 복원 시 이 원문 확인 guard 변경과 관련 반례를 함께 검토하되, 증거 없는 이전 답변을 자동 복원하지 않는다. 일반 질문 추가 승인을 새로 도입한 것이 아니라 출처 불명 답변의 잘못된 재사용만 중지했다.'
].join('\n\n');
await writeFile(prefix+'-report.md',report+'\n',{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-before.txt','-focused.txt','-regression.txt','-final.txt','-verified.txt','-comparison.json','-comparison.txt','-build.txt','-contract.txt','-research.json'].map(s=>prefix+s);
const attempt={id:'clarification-provenance-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'원문 hash 없는 이전 답변을 재사용하지 않으면 잘못된 맥락 적용을 막으면서 명시한 독립 읽기와 정상 답변 재사용을 보존할 수 있다.',
 lesson:'revision 숫자와 질문 문자열만으로 이전 답변의 원문 provenance가 입증되지 않는다. 실제 독립 읽기는 유지하고 출처 미확인 질문만 한 묶음으로 남긴다.',
 limitations:'112 관련 검사/실제CoreEBGSQL 동일PID/고정 비교96. 합성 입력·scripted 계획·실계정/설치본/일반 의미/장기 개입률 미검증·비용 미측정·원래 인수60/100 유지.'};
await writeFile(prefix+'-attempt.json',JSON.stringify(attempt,null,2)+'\n',{flag:'wx'});
const gate=gates.find(g=>g.id==='V3-020');gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations.push('2026-10-08: 원문hash 없는 옛 gate 답변 잘못 재사용3반례 수정. 실제Core/E/PC/G·SQL 독립읽기2/작성0/질문1묶음 유지와 정상작성 완료,112검사/비교96. 일반 의미·설치UI·실사용 개입률은 미완료.');
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 옛 답변 원문hash 누락3실패 수정/독립읽기 유지/112검사/기존 고정 비교96. 공식 ${counts.verified}/100 유지. 다음 V3-020 실제UI 질문·정정·복구/독립 의미 인수.\n`);
console.log(JSON.stringify({counts,tests:112,comparisonRuns:96,record:runResearchLedger(['record',prefix+'-attempt.json'])}));
