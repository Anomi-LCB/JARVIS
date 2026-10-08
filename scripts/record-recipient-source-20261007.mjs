import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/recipient-source-20261007',pilot='artifacts/recipient-source-mission-20261007-lf2wBU/result.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,''));
const baselinePath='artifacts/recipient-source-guard-20261007-jOj7jL/result.json',fixedPath='artifacts/recipient-source-guard-20261007-WqouXB/result.json';
const baseline=json(baselinePath),fixed=json(fixedPath),run=json(pilot);
assert.equal(baseline.observations.filter(x=>x.allowed!==x.expected).length,2);
assert.ok(fixed.observations.every(x=>x.allowed===x.expected));
assert.equal(run.records.length,10);
for(const row of run.records){assert.equal(row.requests,row.expectedCalls);assert.equal(row.canaryReceipts.length,row.expectedCalls);
 assert.equal(row.sourcePreserved,true);assert.equal(row.independentReadCompleted,true);
 assert.equal(row.status,row.expectedCalls?'COMPLETED':'PAUSED');}
assert.match(readFileSync(`${prefix}-current-tests.txt`,'utf8'),/tests 242/);
assert.match(readFileSync(`${prefix}-current-tests.txt`,'utf8'),/fail 0/);
assert.match(readFileSync(`${prefix}-current-tests.txt`,'utf8'),/skipped 0/);
assert.match(readFileSync(`${prefix}-current-build.txt`,'utf8'),/Built static/);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath);
const gates=acceptance.stages.flatMap(x=>x.gates),gate=gates.find(x=>x.id==='V3-018');
assert.equal(gates.length,100);assert.equal(gate.status,'in_progress');
const originalRequirementsSha256=hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))));
const times=run.records.map(x=>x.durationMs).sort((a,b)=>a-b),percentile=p=>times[Math.ceil(times.length*p)-1];
const result={observedAt,pilotObservedAt:run.observedAt,gateId:gate.id,originalRequirement:gate.requirement,originalRequirementsSha256,
 decision:'in_progress',acceptanceVerified:gates.filter(x=>x.status==='verified').length,
 completed:2,paused:8,unexpectedDispatches:0,providerCalls:2,approvals:run.records.reduce((sum,x)=>sum+x.approvals,0),
 latencyMs:{p50:percentile(.5),p95:percentile(.95),scope:'isolated campaign 10 cases; completion and denied cases combined'},
 cost:'미측정',externalModelCalls:0,scope:run.scope,
 failuresPreserved:['initial bootstrap lost compound read/send source','default criterion lacked narrow provider acceptance oracle','broad regression: bootstrap route change and legacy test fixture missing resultReadGuard'],
 remaining:'all non-file external actions and general semantic omission are not independently audited; real SMTP/account delivery and long-running acceptance remain unverified'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(result,null,2),{flag:'wx'});
const paths=['packages/core/src/mission/goal-contract.js','packages/core/src/mission/mission-requirement-coverage.js',
 'packages/core/src/mission/mission-planner.js','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/criteria-evidence.js',
 'packages/core/src/mission/read-send-default-criteria.js','apps/pc-agent/src/pc-agent-runtime.js','tests/read-send-default-criteria.test.js',
 'tests/mission-requirement-coverage.test.js','tests/mission-legacy-path-evidence.test.js','scripts/recipient-source-guard-probe.mjs','scripts/recipient-source-mission-pilot.mjs'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,sources:paths.map(path=>{const bytes=readFileSync(path);return {path,sha256:hash(bytes),content:bytes.toString('utf8')};})},null,2),{flag:'wx'});
const report=`# 수신자 원문 보존 및 외부 발송 경계 개선\n\n관측 ${run.observedAt}. 원래 V3-018은 in_progress 유지, 공식 인수45/100. 실제 기능 수정과 인수 종료를 구분한다.\n\n## 재현과 수정\n\n원문 intended@example.test와 실행 other@example.test가 달라도 기존 원문 검사에서 allowed=true였다. 내 메일 요청도 recipientMode=self와 명시 주소를 함께 넣으면 실제 어댑터에서 그 주소를 사용했다. 실제 외부 계정 발송 없이 이 두 결함을 재현했다. 정확한 원문 절을 재해석해 수신자를 비교하고, self 요청의 명시 주소 충돌은 B에서도 transport 생성 전 차단한다. 해석 메타데이터·과거 저장 계약만으로 주소를 신뢰하지 않는다.\n\n읽기+발송 복합 요청을 전체 읽기 부트스트랩으로 넘기던 경로는 발송을 포함한 복합 계약에서 중지했다. 미지원 선행 행동이 섞인 발송 절은 전체 문법 불일치로 미해석 유지한다. 기본 완료 기준은 완전히 해석된 읽기+명시 주소/self 요청에서만 요구별로 생성한다. 공급자의 발송 수락은 받은 편지함 도착·사람의 열람을 의미하지 않는다. 명시 사용자 완료 기준은 유지한다.\n\n## 실제 로컬 실행과 실패 이력\n\nCore/E/B/G 실제 실행, 실제 파일 읽기와 SHA 검사, 합성 연결 준비도, 주입 SMTP transport→소유 loopback HTTP 수신기로 검사했다. 실계정·SMTP 서버·외부 메일함은 사용하지 않았다. 현재10건 중 완료2건, 보류8건이다. 정상 주소와 self만 각각1회 수락, 나머지 잘못된 주소·self override·주소 누락·미지원 절·절 안의 미지원 행동·모호한 사람·정정·dispatch 주소 변경은0회 발송이다. 모든 원본 보존 및 독립 읽기 검사가 통과했다. 차단을 발송 성공으로 계산하지 않는다. 승인 총${result.approvals}회는 시험 위임이며 운영 권한 확대가 아니다.\n\n초기 실제 파일럿 TQlfHc는 부트스트랩 문제로 발송0/PAUSED였다. UjSrsP와 DuAlEB는 정상 canary 수락1회 후 완료 기준 미지원으로 PAUSED였다. 보고서와 산출물은 그대로 보존했다. 초기 회귀242건 중6실패: 읽기 전용 bootstrap 경로 변화1건을 제품 수정, 기존 borrowed verifier 시험에서 resultReadGuard 누락5건을 실제 prototype guard 연결로 수정했다. 운영 보안 검사를 제거하지 않았다. 최종242통과·실패0·skip0, build 성공.\n\n## 측정과 한계\n\n현재10건 전체 p50 ${result.latencyMs.p50.toFixed(2)}ms / p95 ${result.latencyMs.p95.toFixed(2)}ms. 정상/보류 혼합 격리 측정이며 운영 이메일 지연이나 전체 성능 지표가 아니다. 공급자 canary 호출2회, 외부 모델0회, 실제 비용 미측정. 실계정 전송·모든 비파일 외부 행동·일반 자연어 의미 누락·장기관측은 검증하지 않았다. 따라서 V3-018 종료나 전체 인수율 상승은 선언하지 않는다.\n\n## 다음 작업과 복원\n\n현재 색인에서 V3-018의 비파일 외부 실행 경로와 선행 요구 전체 보존을 이어 감사한다. 실제 발송 연결은 별도 계정 준비도·위임·provider 기록 관측이 필요하다. 복원은 이번 source bundle과 기존 reviewHistory를 사용해 해당 수정만 검토하여 복원하며, 전체 저장소 reset·사용자 문서 종료·메일 권한 확대는 하지 않는다.\n`;
writeFileSync(`${prefix}-report.md`,report,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-current-tests.txt`,`${prefix}-current-build.txt`,pilot,baselinePath,fixedPath,
 'artifacts/recipient-source-mission-20261007-TQlfHc/result.json','artifacts/recipient-source-mission-20261007-UjSrsP/result.json','artifacts/recipient-source-mission-20261007-DuAlEB/result.json',
 `${prefix}-final-tests.txt`,`${prefix}-repair-tests.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'recipient-source-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',observedAt:run.observedAt,
 hypothesis:'원문 수신자 및 복합 요구를 최종 dispatch에 보존하면 계획 주소 변경이나 미지원 단계 생략은 외부 효과 전에 차단된다.',reportedOutcome:'passed',evidencePaths,
 lesson:'주소는 모델 메타데이터 대신 정확한 원문 절에서 다시 바인딩해야 한다. 공급자 수락과 실제 도착, 좁은 문법과 일반 자연어 완료를 구분한다.',
 limitations:'실제 로컬Core/E/B/G+합성 준비도/transport+loopback canary10건/242회귀/build. 실제 계정 SMTP 전달·일반 의미·모든 비파일 외부 경로 미검증. 원래V3-018 진행중·전체45/100,비용미측정.'},null,2),{flag:'wx'});
for(const path of [`${prefix}-report.md`,`${prefix}-verification.json`,pilot,`${prefix}-current-tests.txt`])if(!gate.evidence.includes(path))gate.evidence.push(path);
gate.limitations.push('2026-10-07 수신자 원문/dispatch 주소/self override/미지원 발송 절 경계 수정. 격리10건 완료2·보류8·잘못된발송0/242회귀/build. 실계정 전달 및 일반 의미·전체 비파일 외부 경로 인수 미완료 유지.');
acceptance.updatedAt=observedAt;
assert.equal(hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))))),originalRequirementsSha256);
writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 원문 수신자/실행 주소 불일치와 self override 수정, 발송 복합 bootstrap 및 좁은 완료 기준 연결. 실제 로컬+주입transport/loopback10건 완료2·보류8·오발송0,242회귀/build. V3-018 in_progress/전체45/100,실계정 전달·전체 비파일 경로 미완료. 다음은 미지원 선행 요구와 비파일 외부 dispatch 감사.\n`);
console.log(JSON.stringify({verified:result.acceptanceVerified,evidenceBytes:evidencePaths.reduce((sum,path)=>sum+readFileSync(path).length,0),evidenceFiles:evidencePaths.length}));
