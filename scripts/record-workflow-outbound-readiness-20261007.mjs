import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/workflow-outbound-readiness-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,''),sha=b=>createHash('sha256').update(b).digest('hex'),observedAt=new Date().toISOString();
const before=read(`${prefix}-before.txt`),after=read(`${prefix}-after.txt`),outbound=read(`${prefix}-outbound-regression.txt`);
assert.match(before,/fail 2\b/);for(const rx of [/tests 44\b/,/pass 44\b/,/fail 0\b/,/skipped 0\b/])assert.match(after,rx);assert.match(outbound,/fail 0\b/);assert.match(read(`${prefix}-build.txt`),/Built static/);
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped','duration_ms'].map(key=>[key,Number(new RegExp(`${key} ([0-9.]+)`).exec(log)?.[1])]));
writeFileSync(`${prefix}-verification.json`,JSON.stringify({observedAt,before:counts(before),focused:counts(after),supportedOutboundRegression:counts(outbound),officialVerified:47,newCapabilityActivated:false,scope:'Two direct coordinator prerequisite cases using real SQL stores and constructed outbound client; no network workflow dispatch. Existing authenticated single-file outbound/process recovery regressions run separately.',externalModelCalls:0,cost:'미측정'},null,2),{flag:'wx'});
const files=['packages/core/src/mission/mission-effect-coordinator.js','tests/workflow-outbound-memory-readiness.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,files:files.map(path=>({path,sha256:sha(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 外向 원격 복합 작업의 복구 준비도 정확화

공식 인수 **47/100 유지**. V3-046 미완료 경로를 조사하며 현재 PcOutboundExecutionClient는 단일 filesystem.createTextFile 효과만 영속 대사하고, workflow cognition intent·publication 재개는 지원하지 않는 것을 확인했다. 그런데 memoryReadiness는 해당 typed outbound 연결의 enabled=false 상태에서 required=false/available=true를 반환했다. 영속 기억 DB 준비 여부와 실행 채널의 복구 지원 여부는 별개다.

실제 SQL store와 실제 생성자를 사용한 outbound client에서 두 준비도 반례를 만들었다. 수정 전2/2실패, 수정 뒤 영속 기억의 유무 모두 복합 workflow는 A_MISSION_WORKFLOW_RECOVERY_CHANNEL_UNSUPPORTED와 outbound-workflow-recovery-not-implemented를 반환한다. 사전 확인 위치는 Mission staging·dispatch checkpoint 앞이며 현재 두 반례에서 command queue0·cognition intent0을 확인했다. 지원되는 실행 연결을 설정하고 같은 작업을 이어가라는 한국어 안내를 반환하며 DB 경로나 비밀을 노출하지 않는다. 읽기 목록 및 기존 단일 파일 효과의 조건은 바꾸지 않는다.

이번 신규 두 사례는 coordinator 계약 시험이다. 실제 네트워크 workflow를 성공시켰거나 OS 재시작으로 새로운 outbound workflow 복구를 입증한 것이 아니다. 이를 지원하려면 별도의 workflow 영속 효과·현재 원격 산출물 검증·publication 대사·실행 직전 권한 fence·원래 사용자 기억 문맥 계약이 필요하다. 기존 단일 파일의 binding을 복합 작업에 임의 재사용하지 않았다.

6파일44/44통과·실패0·제외0, 전체 runner13,320.6569ms. 기존 HTTP workflow 기억 실패 후 실제 Core kill/new PID 복구 및 executor endpoint 변경 거절을 포함한다. 지원되는 outbound 단일파일·응답 손실 대사는 별도 remote-mission-effect.test.js 회귀로 검사했다: ${JSON.stringify(counts(outbound))}. Linux-root 전용 제외는 통과로 계산하지 않는다. 빌드 성공. 모델 호출0·비용미측정, 운영 서비스·계정 변경 없음. 이전2실패 로그를 보존한다.

V3-046은 진행 중이며 이번 차단 정확화를 기능 활성화나 인수 승격으로 세지 않는다. 다음은 외향 채널의 workflow 계약을 실제 별도 프로세스·권한/원격 검증 경계와 연결하거나, 독립 종료 가능한 다른 미완료 로컬 인수 조건을 진행한다. 복원은 이번 coordinator guard와 시험 파일만 좁게 검토하며 기존 기억/사용자 작업/다른 변경은 보존한다. SHA는 무결성 증거다.
`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-before.txt`,`${prefix}-after.txt`,`${prefix}-outbound-regression.txt`,`${prefix}-build.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'workflow-outbound-readiness-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'contract-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'실행 채널의 복구 미지원은 영속 기억 준비와 분리해서 staging 전에 표시할 수 있다.',lesson:'단일파일 영속 outbound binding은 복합 workflow publication/cognition 복구 계약을 대신하지 않는다. 미지원 연결은 자동 fallback 없이 명시적 차단한다.',limitations:'47/100 유지, V3-046 진행중. 신규2사례는 SQL/client 생성자를 이용한 coordinator 계약 검증, 실제 외향 workflow 성공 아님. 비용미측정.'},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse(read(path)),gates=a.stages.flatMap(s=>s.gates);assert.equal(gates.length,100);assert.equal(gates.filter(g=>g.status==='verified').length,47);const gate=gates.find(g=>g.id==='V3-046');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths.slice(0,2));gate.limitations.push('2026-10-07 typed outbound workflow의 미지원 복구를 staging 전 명시차단. 새2반례+공유44통과/build/지원단일파일 outbound 회귀. 실제 외향 복합복구 활성화 아님.');a.updatedAt=observedAt;writeFileSync(path,JSON.stringify(a,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 외향복합workflow 복구 미지원 준비도 정확화·2실패재현/공유44통과·기존outbound회귀/build. 전체47/100/V3-046진행중. 다음 복합효과/원격현재검증/기억문맥 경계 또는 다른 종료가능 로컬조건.\n`);
console.log(JSON.stringify({verified:47,focused:counts(after),outbound:counts(outbound)}));
