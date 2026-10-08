import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/compound-duration-20261007',observedAt=new Date().toISOString();
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
assert.match(read(`${prefix}-baseline.txt`),/ℹ fail 2/);
for(const [suffix,count] of [['final.txt',160],['process.txt',20]]){
 const text=read(`${prefix}-${suffix}`);
 for(const [key,value] of [['tests',count],['pass',count],['fail',0],['skipped',0]])assert.match(text,new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
}
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const processCases=read(`${prefix}-process.txt`).split(/\r?\n/).filter(s=>s.startsWith('ℹ {"actualOsKill":true,"actualCoreEBG":true,')).map(s=>JSON.parse(s.slice(2)));
assert.equal(processCases.length,20);const duration=processCases.filter(o=>o.deadlineMode==='duration');assert.equal(duration.length,6);
for(const c of duration){assert.notEqual(c.oldPid,c.resumedPid);assert.notEqual(c.resumedPid,c.againPid);}
assert.equal(duration.find(c=>c.boundary==='prepared'&&c.offset===60001).adapterCalls,0);
assert.equal(duration.find(c=>c.boundary==='b-receipt'&&c.offset===60001).stopReason,'completion-deadline-unverified');
assert.equal(duration.find(c=>c.boundary==='completed-before-ack').deadlineProof.deadlineAt,'2026-10-07T00:02:00.000Z');
const files=['packages/core/src/mission/goal-contract.js','packages/core/src/mission/mission-completion-deadline.js','tests/duration-deadline-source.test.js','tests/mission-completion-deadline.test.js','tests/fixtures/routine-process-recovery-child.mjs','tests/routine-temporal-process-recovery.test.js'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('verification.json',{observedAt,unsupportedBaselineCases:2,regressionTests:160,actualOsKillTests:20,passed:180,failed:0,skipped:0,actualProcessLaunches:60,newDurationCases:duration,productLatency:null,actualCost:null,buildPassed:true,contractPassed:true});
write('report.md',`# 복합 경과 기간과 실제 종료 후 복구\n\n관측 ${observedAt}. 원래 인수 원장 59/100, V3-021 진행 중.\n\n이전 구현이 지원하지 못한 1시간30분·2시간3분4초 두 고정 UTC 오라클의 실패를 보존하고 지원했다. 최대 세 종류의 시간→분→초 순서와 정수 합계를 검증한다. 중복/역순 단위·소수/음수·불명 기간을 임의로 축약하지 않는다. .5시간 같은 표현도 계약에서 누락하지 않고 명시적 미해결 시간 조건으로 보존한다. Mission 생성 시각을 기준으로 UTC 경과 시간을 더해 DST나 연말에도 기한을 다시 늘리지 않는다.\n\n실제 Core/E/B/G/SQL에서 1분30초 명령의 실제 파일 생성·최종 기한 증거를 확인했다. 프로세스 복구는 기존 날짜/예약 14조건에 복합 기간 6조건을 추가해 총20조건·60개 별도 프로세스 실행이다. 새 기간 조건은 생성 전 prepared 기한안/초과, PC영수증 뒤 기한안/초과, 파일 효과 뒤 영수증 소실, 완료 후 ACK 소실을 검사한다.\n\n초과 prepared는 파일0회다. 기한안 복구는 동일 원래 기한으로 파일1회 완료한다. 영수증 후 기한 초과는 이미 만들어진 파일을 유지하고 PAUSED다. 영수증 없는 효과는 uncertain/복구필요로 남기고 재작성하지 않는다. 이미 완료 후 ACK만 소실된 경우에는 원래 완료 시각과 기한 증거를 보존한다. 각 조건 세 번째 프로세스에서도 같은 Mission과 결과이며 추가 실행0이다.\n\n회귀10파일160통과 + 실제OS 종료20통과 = 180통과, 실패0·skip0. build/Core 계약 통과. 계획기/시계/자료는 격리 결정형 fixture이며 모델/외부 공급자 호출, 운영 재시작, 설치본 변경은 없다. 제품 지연과 실제 비용은 미측정이다.\n\n이는 지원한 기간과 실제 로컬 파일 경로의 증거이며 전체 자연어 시간/수량/금액/일반 제약이나 실계정 성공률이 아니다. 인수율59%를 유지한다. 기존 조사 장부에 새 시도로 보존하며 해시 무결성을 독립 의미 평가로 취급하지 않는다.\n\n복원은 복합 기간 추출 및 앞부분 기한 분기와 관련 검사를 함께 검토한다. 기존 원문 시간 보존, 초과 차단, 불명 효과 재실행 금지를 제거하지 않는다. 다음은 V3-021 잔여 요구를 유형별 현재 증거에 대조하고 설치 런타임/실효과 및 일반 제약의 빈틈을 좁힌다.\n`);
const evidencePaths=['report.md','verification.json','source.json','baseline.txt','focused.txt','final.txt','process.txt','build.txt','contract.txt'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'compound-duration-20261007',candidateId:'mission-time-zone-and-dst-constraints',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'복합 경과 기간을 단일 원문 기한으로 보존하면 재시작도 기한을 연장하거나 파일 효과를 중복하지 않는다.',lesson:'단일 단위 기간만 지원하면 일반적인 복합 기간은 계속 차단된다. 기간 검증과 이미 완료한 결과의 복구는 구분해야 한다.',limitations:'결정형 계획기/시계·격리 실제Core/E/B/G/SQL/OS 종료. 일반 기간/수량/금액/다른도구·설치 서비스·실계정·실기기 미완료. 제품 지연/비용 미측정.'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,59);const gate=gates.find(g=>g.id==='V3-021');assert.equal(gate.status,'in_progress');
gate.evidence.push(...evidencePaths);gate.limitations.push('2026-10-07: 복합 기간2미지원 확장·실제CoreSQL 파일 및 기간OS 종료6조건/18프로세스·160회귀+20전체OS/build/contract. 설치 서비스/일반 제약/실계정 인수 미완료.');
a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 복합 경과 기간 및 실제 종료 복구6신규조건/18프로세스·총180통과/build/contract. 공식59% 유지. 다음 V3-021 잔여 유형별 증거와 설치 런타임·실효과 제약.\n`);
appendFileSync('docs/local-mission-deadlines.md','\n복합 경과 기간은 정수 시간→분→초 순서의 최대3개 단위를 합산한다(예: 지금부터1시간30분이내). 중복/역순/소수/음수는 보류한다. 실제 강제 종료6조건에서도 원래 Mission 생성 시각과 완료 기한을 유지한다.\n');
console.log(JSON.stringify({observedAt,verified:59,tests:180,actualOsKillCases:20,newDurationOsKillCases:6}));
