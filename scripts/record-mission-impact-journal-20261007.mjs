import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mission-impact-journal-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),hash=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const log=read(`${prefix}-final.txt`);for(const rx of [/tests 35\b/,/pass 35\b/,/fail 0\b/,/skipped 0\b/])assert.match(log,rx);assert.match(log,/actualOsKill.*true/);assert.match(read(`${prefix}-build.txt`),/Built static/);
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,officialVerified:47,acceptanceId:'V3-054',regression:{tests:35,passed:35,failed:0,skipped:0,durationMs:10342.95},build:'passed',actualCoreOsKill:true,actualAdminHttp:true,scope:'Synthetic local SQL count quotas/Mission conditions; separate real Core processes killed by test parent, no external accounts/device claims.',notificationsSent:0,externalModelCalls:0,cost:'미측정'},null,2),{flag:'wx'});
const files=['packages/core/src/mission/mission-dependency-impact-journal.js','packages/core/src/mission/mission-dependency-impact.js','packages/core/src/mission/mission-runtime.js','packages/core/src/main.mjs','tests/mission-dependency-impact-journal.test.js','tests/fixtures/mission-impact-journal-child.mjs'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:hash(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 명시적 업무 조건 변경의 영속 이력·중복 억제

공식 **47/100 유지**. V3-054의 현재 영향 계산을 단일 SQL Core 권위의 영속 변경 이력과 연결했다. 원래100개 요구·인수 조건을 유지하며 금액 예산·실계정 조건까지 끝났다고 계산하지 않는다.

## 구현한 실제 경로

POST /missions/dependency-impact-reconciliation은 ADMIN 인증과 동일 SqliteMissionStore에 결합된 실제 MissionExecutionAuthority를 요구한다. 최초 관측은 기준값만 저장하며 이후 같은 상태는 중복 사건을 만들지 않는다. 공유 quota 감소·권한/기기 판정·행동 영향의 변경을 업무별 revision과 이전/현재 판정으로 기록한다. GET /missions/dependency-impact-events의 after/limit으로 이력을 조회한다. 원문 요청·자료·계정·경로는 요약 이력에 복제하지 않는다. 금액이나 제공자 비용을 횟수 quota로 대신하지 않는다.

기준값 갱신과 사건 저장은 같은 BEGIN IMMEDIATE 트랜잭션이다. 트랜잭션 안에서 현재 Core lease의 fencing·만료와 SQL Mission snapshot revision을 다시 검사한다. recovery-only 권위·다른 저장소·오래된 Core는 기록할 수 없다. 저장 요약/사건의 digest를 재대조하고 변조된 이력을 정상 출력하지 않는다. SHA는 저장 무결성 근거이며 원래 판정의 참됨은 별도 행동 검사로 평가한다.

이력 생성은 실행/예약/재계획/권한 부여/알림 발송을 수행하지 않는다. 완성된 효과는 계속 역사로 남으며 의존 판정이 바뀌었다고 다시 실행하지 않는다. 현재 코드에서는 명시적 API 호출만 대사하며 자동 스케줄러 활성화가 아니다. 기존 읽기 전용 API와 JSON Mission 경로를 억지로 SQL로 전환하지 않았다.

## 실패 보존과 검증

첫3시험은 실제 런타임 옵션 missionExecutionAuthority 대신 executionAuthority를 전달해 모두 A_MISSION_IMPACT_DURABLE_AUTHORITY_REQUIRED로 차단됐다. 권위 조건을 제거하지 않고 시험 설정을 기존 공개 옵션에 맞췄다. 초기 실패 로그 보존, 이후3/3 통과. 사건 INSERT 오류 trigger를 주입하면 기준값과 사건이 모두 rollback되고 재시도1회만 기록된다. quota를 공유하는 두 Mission은 변경2건, 독립 Mission은 변화0, 같은 관측 재시도는0이다.

별도 실제 Node Core 프로세스3개에서 baseline→SIGKILL→lease 만료 후 새 권위 획득→quota 변경/대사→SIGKILL→새 Core 복원을 수행했다. 최초 사건0, 변경2, 복원후중복0이고 저장 이력 내용도 동일했다. 프로세스 PID는 final.txt에 기록했다. 파일 효과는 실행하지 않았으며 외부 B 업무 재실행 성공을 이 시험으로 주장하지 않는다.

실제 ADMIN HTTP에서 원문 supplied events 입력 거부400·무인증401·정상 대사200·이력 조회·잘못된 pagination400·변조된 이력503을 확인했다. 현재 이력 기록/조회는 별도 권한 경로다. 최종4파일 **35/35 통과·실패0·제외0**, runner10,342.95ms. 기존 Core 권위·quota SQL/실제 파일2개 효과 회귀 포함, 빌드 성공. 모델 호출0·비용미측정. 운영 서비스·설치본·외부 계정/기기 변경 없음.

## 남은 인수 조건과 복원

V3-054는 아직 진행 중이다. 금액 예약의 명시적 업무 연결·자동 대사 스케줄/영속 알림·실계정·실기기 및 미계획 의미 관련성은 미완료다. 실제 권위가 없는 기본 Core에는 영속 대사 기능을 준비 완료로 표시하지 않는다. 47개 완료·23진행·30대기는 변하지 않는다.

다음은 명시적 금액 예약/공급자 결과 계약이 있는 업무의 현재 예산 영향을 연결하며, 비용을 알 수 없는 사례를0원으로 취급하지 않는 것이다. 복원은 이번 이력 module·runtime method·ADMIN route·시험만 검토하며 원래 Mission/기억/외부효과를 되돌리지 않는다. SQL 이력 테이블은 원장과 분리된 projection/event로 보존하되 삭제 작업을 자동 실행하지 않는다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-first.txt`,`${prefix}-focused.txt`,`${prefix}-final.txt`,`${prefix}-build.txt`,'docs/mission-dependency-impact-api.md'];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'mission-impact-journal-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'단일 Core 권위와 SQL snapshot revision을 같은 변경 대사 transaction에서 확인하면 재시작/재시도 후 사건 중복과 기준값 분리를 막을 수 있다.',lesson:'이력 기록도 활성 SQL Core 권위에 결합하고 초기 baseline과 실제 변화 사건을 분리해야 한다. INSERT 실패는 기준값 갱신과 함께 rollback한다.',limitations:'47/100/V3-054진행중.35회귀/build/실제3Core SIGKILL·ADMIN HTTP. synthetic quota/관측이며 금액예산/자동알림/실계정·기기/운영 활성화 아님.비용미측정.'},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-054');assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,47);assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths.slice(0,2));gate.limitations.push('2026-10-07 単一SQL Core 권위/현재snapshot revision 결속 영속이력·INSERT rollback·실제Core3PID kill복구 중복0·ADMIN HTTP·35통과/build. 금액예산/자동알림·실계정기기는 남음.');a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: SQL 단일권위 영속의존변경이력·실제Core kill/복원 중복0·원자rollback·ADMIN API·35통과/build. 전체47/100/V3-054진행중. 다음 금액예약의 명시업무 현재예산 영향.\n`);
console.log(JSON.stringify({verified:47,evidenceBytes:evidencePaths.reduce((n,p)=>n+readFileSync(p).length,0)}));
