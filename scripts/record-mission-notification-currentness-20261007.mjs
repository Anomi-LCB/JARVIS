import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mission-notification-currentness-20261007';
const read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const log=read(`${prefix}-verified.txt`),before=read(`${prefix}-first.txt`);
for(const regex of [/tests 33\b/,/pass 33\b/,/fail 0\b/,/skipped 0\b/])assert.match(log,regex);
assert.match(before,/fail 4\b/);assert.match(read(`${prefix}-build-final.txt`),/Built static/);
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(read(path)),gates=acceptance.stages.flatMap(s=>s.gates);
assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,48);
const gate=gates.find(g=>g.id==='V3-056');assert.equal(gate.status,'in_progress');
const requirementsSha256=hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
const verification={observedAt,acceptanceId:gate.id,requirement:gate.requirement,originalRequirementsSha256:requirementsSha256,
 before:{tests:4,failed:4},after:{tests:33,passed:33,failed:0,skipped:0,durationMs:2723.9216},build:'passed',
 verified:48,actualSqlite:true,databaseReopen:true,actualCoreHttp:'existing inbox/source and deadline regression paths',
 newOsProcessKill:false,externalAccountConnected:false,installedRuntimeUpdated:false,externalModelCalls:0,cost:'미측정',
 scope:'내부 Mission 현재성·로컬 알림 발행/확인 경계. 합성 업무 입력과 실제 SQL, 기존 Core HTTP 회귀. 외부 전달·사용자 읽음·선제 위임 전체 검증 아님.'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(verification,null,2),{flag:'wx'});
const files=['packages/core/src/personal-operations/operations-store.js','packages/core/src/personal-operations/reminder-scheduler.js','tests/mission-notification-currentness.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 작업 상태 변경 중 오래된 알림 발행 수정

공식 인수율은 **48/100**, V3-056은 진행 중으로 유지한다. 원래100개 요구와 분모를 변경하지 않았다.

## 재현과 수정

새 반례4건 모두 변경 전에 실패했다. 알림 묶음의 첫 콜백이 다음 작업을 완료하거나 제거한 경우에도 다음의 오래된 중단 알림이 발행됐다. 비동기 콜백 도중 작업이 완료돼도 과거 사건의 응답을 확정했다. 아직 발행되지 않은 중단 사건을 해결해도 별도 해결 알림을 생성했다.

기존 PersonalOperationsStore·ReminderScheduler와 기존 수신함을 수정했다. 각 Mission 알림 발행 직전과 비동기 응답 직후 해당 Mission을 현재 Map에서 다시 관측한다. 변경된 상태는 영속 sequence를 바꾸고 옛 claim/확정을 무효화한다. 제거된 작업은 UNAVAILABLE 관측 tombstone으로 기존 알림을 철회한다. 완전한 snapshot에서 이미 발행된 제거 작업도 현재 조회·미확인 수·확인 영수증에서 제외한다. 작업 원장 자체의 상태나 실행 권한은 바꾸지 않는다.

해결 알림은 이전 sequence가 실제 로컬 발행 확정된 경우에만 생성한다. 발행 전 사라진 문제에는 해결 알림을 추가하지 않는다. 동일 상태 반복은 조용하고 재등장한 작업은 새 사건 ID를 받는다. 발행 중 원인이 바뀌면 이전 응답은 완료로 집계하지 않고 새 사건을 다음 주기에 전달한다. 주기 중 생성된 사건도 상태 집계에 포함했다. runtime snapshot을 읽을 수 없으면 작업 제거로 꾸며내지 않고 오류로 중지한다.

## 검증

새 반례와 양성·중단원인 변경·이미 발행된 작업 제거/재등장·snapshot 미준비를 포함한7건, 기존 알림·기한·출처·Core HTTP 회귀와 합계33/33 통과, 실패0·제외0, 빌드 성공. 최종 runner 2723.9216ms는 업무 p50/p95 지표가 아니다. 처음 실패4건과 중간/최종 로그를 보존했다. DB 재열기는 실제 파일을 사용했다. 이번 새 시험에서 OS 강제 종료나 사용자 UI 평가는 수행하지 않았다.

## 한계와 다음 작업

콜백 호출 후 발생한 상태 변경은 이미 전달된 메시지를 취소하지 못한다. 현재성 재검사는 새 callback/확정/로컬 조회 경계를 보호하며 외부 채널의 exactly-once 전달이나 실제 사용자 읽음을 증명하지 않는다. 외부 소비자는 여전히 eventId 중복 제거가 필요하다. 배포 설치본과 운영 서비스는 재시작/갱신하지 않았다. 실제 계정 선제 점검·자료/행동 위임·알림 유용성 사용자 평가·장기 관측은 남아 있다. 외부모델 호출0, 실제 비용 미측정.

다음은 영속 dependency impact 변경 사건을 검토된 위임 범위에서 기존 알림 수신함으로 연결하는 작업이다. 불필요한 상태 변화는 조용히 기록하고 권한/대상/계정 연결이 준비되지 않은 경우 자동 발송하지 않는다.

복원 시 이번2개 모듈의 Mission 관측/알림 분기만 좁게 검토한다. 기존 사용자 업무/기억과 이미 생성된 사건 원장을 삭제하지 않는다. source snapshot은 수정 시점 보존용이며 이전 전체 파일의 모든 코드가 이번 신규 구현이라는 의미가 아니다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-final.txt`,`${prefix}-regression.txt`,`${prefix}-verified.txt`,`${prefix}-build-final.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'mission-notification-currentness-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'발행 직전/응답 직후 현재 Mission 재관측과 영속 sequence 철회로 예약된 오래된 알림의 전달/확정과 미발행 문제의 불필요 해결 알림을 줄일 수 있다.',
 lesson:'예약 시점 snapshot과 현재 업무 상태는 다르다. claim lease만 확인하면 콜백 중 다른 작업의 해결/제거를 놓친다. 로컬 발행 확정과 사용자 읽음/외부 전달도 분리해야 한다.',
 limitations:'공식48 유지/V3-056 부분. 합성입력·실제 SQL 재열기·기존Core HTTP 회귀33통과. 실계정·선제 위임전체·외부소비자·OSkill·사용자평가·운영설치본 미검증. 비용미측정.'},null,2),{flag:'wx'});
gate.evidence.push(...evidencePaths.slice(0,3));gate.reviewedAt=observedAt;
gate.limitations.push('2026-10-07 Mission 발행 전/응답 후 재관측·제거 철회·미발행 해결 알림 억제·33회귀/SQL재열기 완료. 기존48 유지. 콜백 후 실제 외부 전달 취소/사용자읽음/선제위임 전체/실계정/사용자평가 미검증.');
assert.equal(hash(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),requirementsSha256);
acceptance.updatedAt=observedAt;writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: Mission 알림 현재성4실패→33통과/build, 완료·제거·원인변경과 미발행 해결알림 억제. 공식48/100 유지·V3-056 진행. 다음 영속 영향사건의 위임/기존수신함 연결·사용자평가.\n`);
console.log(JSON.stringify({verified:48,acceptanceId:'V3-056',evidenceBytes:evidencePaths.reduce((sum,p)=>sum+readFileSync(p).length,0)}));
