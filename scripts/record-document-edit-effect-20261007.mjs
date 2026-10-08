import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const prefix='artifacts/document-edit-effect-20261007',observedAt=new Date().toISOString();
const sources=['apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/excel/edit-contract.js','apps/verification/src/document-edit-verifier.js','apps/verification/src/verification-runtime.js','packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js','packages/core/src/orchestration/core-orchestration-worker.js','tests/document-edit-contract.test.js','tests/mission-document-edit-effect-process.test.js','tests/fixtures/document-edit-effect-process-child.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const status=JSON.parse(await readFile(prefix+'-runtime-status.json','utf8')),selfcheck=JSON.parse(await readFile(prefix+'-selfcheck.json','utf8'));
assert.equal(status.status,'ready');assert.ok(status.services.every(s=>s.identityVerified&&s.healthy&&s.statusCode===200));assert.equal(selfcheck.status,'COMPLETED');
await writeFile(prefix+'-report.md',`# document.edit 전체 SQL 실행·영수증·현재 G·종료 복구

관측 ${observedAt}. 공식 인수율60/100 유지.

## 연결한 구현

원래 target/sourceSnapshot/sourceSha256/sheet/edits/backup/전체 output paths를 jarvis-document-edit-v1로 고정하고 SQL 효과 요청에 저장한다. 백업 경로는 원 요청·입력 신원의 해시에서 파생한다. preparePublication→Core private original-plan fence→B 두 경로 claim→현재 권한/배타 staging→즉시 영수증→G→기억 후속 기록으로 연결했다. operationId/effectId/providerIdempotencyKey와 B 영수증은 기존 공통 계약을 재사용한다. 원본·백업 모두 필수 output이다.

G는 현재 원래 백업의 SHA를 확인하고 백업에서 원래 요구의 기대 셀을 계산해 현재 전체 시트 값을 대조한다. 요구한 셀과 관계없는 다른 시트 변경도 거부한다. original SQL contract와 receipt manifest를 최초 receipt 저장 전과 종료 복구 시 각각 대조한다. producer가 수정한 자기 계약만으로 완료할 수 없다.

추가 실패1개를 실제로 재현했다. 앞선 편집이 뒤의 findText 후보를1개→2개로 늘리면 scope=ask인데도 전부 바꿨다. 현재 후보가 다시 모호해지면 저장 전에 보류하도록 수정했고 ambiguity-baseline.txt를 보존했다. 최초 통합84개 실행 후 receipt guard를 추가했으므로 이전 final.txt 대신 고정 소스 final-stable.txt를 최종 근거로 삼는다.

## 실제 종료·변조 검증

- actual XLSX/Mission/SQL/B/G 프로세스7조건: prepared, B receipt, Core receipt persisted, backup-only partial, current target 변조, original backup 변조, active execution authority.
- 실제 SIGKILL 뒤 새 CorePID에서 같은operation/effect/key/receipt로 복구했다. 완결 경로는 편집1회/B claims0/반복복구 같은 영수증이다. backup-only 종료는 completed adapter return0이며 재편집·허위완료 없이 PAUSED/uncertain이다. 문서/백업 변조 후에도 추가 편집이 없다. source-changed라는 fixture mode는 이번 시험에서 원본 백업 변조를 뜻한다.
- 최종 고정 소스84/84 + 공유7/7 =91/91, 실패0·skip0. 별도 계약6개에 실제XLSX 잘못된셀/다른시트/백업손실/범위/manifest변경/연속모호성 포함. 테스트 전체31.7초는 제품 p50/p95 성능 근거가 아니다.
- 독립 최종14/14, 실패0·skip0. 그중7개는 별도 actual runtime wrapper 반례/양성이고7개는 동일 actual process fixture 재실행이므로 전체 고유 조건은98개다. 독립 작성 결과·방법·한계는 independent.md와 실행 테스트를 보존했다. 추가 B1 쓰기 후 일관된 가짜manifest, sourcehash/backup경로/필수출력 교체가 최초 SQL receipt부터 차단됐다. 원래 manifest를 유지한 backupbytes 변조는 공급자receipt succeeded를 보존하되 G가 Mission 완료를 거부했다. receipt succeeded는 사용자 업무 완료가 아니다. 이미 실행한 잘못된 쓰기를 원복/예방했다고 주장하지 않는다.
- build와 Core contract gate exit0. 계정 연결/메일/거래/유료모델 시험 없음. 비용 미측정. 사용자 F/cognition을 시험 기록으로 채우지 않은 격리 경로다.

## 운영 재확인과 복원

현재 HTTP 재관측에서4071/17776/41730이 모두 연결거부였고 기존 product-runtime 프로세스는 없었다. 이유는 미확정이다. known stopped 상태를 확인한 후 hidden supervisor21308를 기존 connections-only/DPAPI 설정으로 복원했다. 세 서비스200·identityVerified/ready다. Core 자동 worker/Google sync/personal import는0이며 저장 원장과 개인 기억을 초기화하지 않았다. PC의 기존 queue drain은 실행된다. 종료 원인을 추정하거나 상시 운영 인수를 통과했다고 표시하지 않는다.

실제 밝은 UI proxy→Core→PC→G에서 합성70바이트 파일 읽기 완료·원본보존·같은Mission revision2 재조회가 통과했다. 운영자 기능시험 답변1건이며 실제 사용자 승인이 아니고 longTermMemory=false다. 이 서비스 복원은 설치EXE/Windows SCM/다른PC/클라우드 시험과 다르다. 최신 PC 소스는 재기동됐지만 새 document.edit SQL 효과는 trusted-local 구성에서만 검증했으며 현재 PC HTTP 원격 실행의 전체 effect 활성화로 확대하지 않는다.

## 남은 범위와 다음 작업

공식 V3-040/041/065는 다른 등록쓰기/외부 공급자 대사/원격 환경/실계정/OS앱 전체 인수 등이 남아 partial이다. 파일값 검사는 셀 스타일·레이아웃·외부링크·native 수식 재계산·모든 format 의미 검증이 아니다. 같은 OS의 원자적 compare-and-replace/power loss, 대용량/압축폭탄/지연, SIGKILL orphan staging/backup 정리와 장기 운영은 미완료다. 애매한 편집을 임의로 완료하지 않지만 일반 자연어 의도까지 검증한 것이 아니다.

다음은 아직 SQLeffect 계약이 없는 등록된 쓰기 경로를 전수색인해 덮어쓰기/복원·shell/UI 범위를 정확히 분류하고, 원래100개 인수의 남은 완료 조건을 이어 검증한다. 복원은 이번 source additions와 document.edit allowlist/contract 연결만 이전 상태로 되돌리며 이미 저장한 SQL/백업/저널을 삭제하지 않는다. 원래 인수 항목과 전체 목표를 줄이지 않았다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'document-edit-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'원래 편집·입력·백업·전체출력 SQL 계약과 현재 G/B claim/영수증을 연결하면 프로세스 종료와 변조에서 재편집 및 허위 완료를 막을 수 있다.',lesson:'원본 편집은 backup 자체를 필수 산출물로 결속해야 하며 최초 receipt에도 original SQL contract를 검사해야 producer 가짜계약이 결과로 승격되지 않는다.',limitations:'최종91/91+독립14(7process중복)·실제종료7. 운영3신원/읽기 복원. 설치EXE/원격effect/실계정/모든쓰기/OS원자성/장기운영 미완료, 공식60/100·비용미측정.',evidencePaths:['-report.md','-source.json','-ambiguity-baseline.txt','-process-first.txt','-final-stable.txt','-shared-stable.txt','-independent.md','-independent.test.mjs','-independent-final.txt','-build.txt','-contract.txt','-runtime.json','-runtime-status.json','-selfcheck.json'].map(s=>prefix+s)},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(await readFile(path,'utf8'));
for(const gate of acceptance.stages.flatMap(s=>s.gates).filter(g=>['V3-040','V3-041','V3-065'].includes(g.id))){gate.evidence??=[];if(!gate.evidence.includes(prefix+'-report.md'))gate.evidence.push(prefix+'-report.md');}
acceptance.updatedAt=observedAt;await writeFile(path,JSON.stringify(acceptance,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: document.edit 원본/편집/backup/전체SQL계약·privatefence/Bclaim/receipt/현재G·actualSIGKILL7·연속모호성1결함수정·91/91+독립14(7중복)/build/contract. 운영3서비스복원·실읽기/설치EXE·원격effect미완료·공식60. 다음 남은등록쓰기 전수색인과 원래100인수.\n`);
