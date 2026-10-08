import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/card-effect-20261007',observedAt=new Date().toISOString();
for(const [suffix,count] of [['-final.txt',72],['-independent-final.txt',42]]){
 const log=await readFile(prefix+suffix,'utf8');
 if(!log.includes(`pass ${count}`)||!log.includes('fail 0')||!log.includes('skipped 0'))throw Error('verification-summary-mismatch:'+suffix);
}
const sources=['apps/pc-agent/src/pc-agent-runtime.js','apps/pc-agent/src/adapters/visual/artifact-contract.js',
 'packages/core/src/mission/mission-effect-coordinator.js','packages/core/src/mission/mission-action-recovery.js',
 'packages/core/src/orchestration/core-orchestration-worker.js','apps/verification/src/verification-runtime.js',
 'tests/card-authority-boundary.test.js','tests/mission-card-effect-process.test.js','tests/fixtures/card-effect-process-child.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify(await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))),null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# PNG 카드 원문·발행·영속 효과·중단 복구

관측 ${observedAt}. 공식100개 인수 기준은 그대로이며60/100이다.

## 실제 바뀐 동작

원래 카드별 제목·label·subtitle·body·footer·색·크기·파일 이름·전체 outputPaths를 preparePublication에 고정하고 Core SQL artifactPlan의 cardPublication/해시에 연결했다. B는 원 계획 private guard 확인 후 전체 파일 claim을 잡는다. 성공 receipt는 즉시 기록하고, B 원래 result/fingerprint/원문 결과/전체 자원 대조 후 claim을 해제한다. 복구는 원문과 완전한 출력 계약을 대조한 뒤 실제 현재 PNG를 독립 G의 글리프·색·배치 검증으로 다시 읽는다. 로컬 authority fence allowlist도 이 경로에 연결했다. 외향 원격 카드 실행은 활성화하지 않았다.

초기 반례3개가 모두 실패했다: direct adapter가 context.assertAccess를 무시했고 signed scope도 검사하지 않았다. 생성후 권한 철회가 관측되지 않은 채 success가 반환됐다. 초기/각 출력 경로/발행 전후에 현재 권한·signed 범위·취소를 확인하고 Python 생성/픽셀 검증에 AbortSignal을 전달했다.

정상 경합은 현재 권한과 원래 dev/ino/bytes 해시가 같은 새 파일만 보상 삭제한다. 이미 권한이 철회됐거나 파일 identity/내용이 바뀌면 임의 삭제하지 않고 retained outputPaths/changedItems/uncertain을 보존한다. undo 이후 최종 파일 해시도 확인한다. 기존 충돌 때 다른 사용자의 파일 보존과 새 파일만 제거하는 동작은 유지했다. 잘못된 accent를 임의7글자로 잘라 다른 스타일로 만들던 처리도 명시적 사전차단으로 바꿨다.

## 검증

- 최종72/72, 실패0·skip0. 실제 Pillow PNG 생성, 현재 G 픽셀 대조, 한국어 OCR 회귀, 실제 Python staging 관측 후 취소, 부분 보상과 scope 검사 포함. 전체 검사42.8초는 제품 p50/p95가 아니다. 실제 이메일 시험은 없으며 이메일 회귀는 nodemailer 합성 transport다.
- 3개 카드의 실제 Mission/SQL/B/G를 별도 프로세스로 실행했다. prepared/b-receipt/receipt-persisted/partial/첫 PNG 변조/두 번째 PNG 변조/authority 총7경계다. SIGKILL 후 새 Core 프로세스는 같은 operationId/effectId/멱등키/receipt로 복구했다. 완료 경로는 생성1회·claim0·반복복구 영수증 동일. 부분/변조는 PAUSED·uncertain이며 추가 생성·허위 완료0. 파일 한 개 존재만으로3개 전체 완료를 인정하지 않는다.
- 독립42/42·실패0·skip0. 실제 Pillow 및 현재 G에서 wrong wording/color/dimensions/layout/hash와 유효한 빈 PNG+새해시+가짜 producer proof를 반증했다. B 임시SQL claim·원receipt object/operation/action 결속, original-plan/복구 반례도 검사했다. 독립검사의 Core live authority/receipt/G 일부는 합성이므로 실제 full process/native 증거와 구분한다. independent.md 참조.
- build/Core 계약 게이트 exit0. runtime.json은 connections-only 상태다. 운영 서비스/설치EXE 재시작·활성화0, 개인계정 변경0, 유료API 호출0. 비용 미측정. 임시SQL/작업 자료·기억·undo로 검사했으며 실제 사용자 F/cognition 기억에 시험 업무를 넣지 않았다.

## 한계와 다음 작업

픽셀과 원문·배치의 일치는 사실 정확성·신학적 의미·디자인 취향 평가와 다르다. 모든 자연어·이미지 생성·앱을 지원한다는 뜻도 아니다. 외부OS 프로세스와 모든 파일 경쟁의 원자성, SIGKILL 뒤 orphan staging의 영속 정리, 공통 manual rollback의 변조 파일 보호는 별도 검토가 남았다. 이번 자동 보상 삭제의 identity/hash/권한 검증을 전체 UndoJournal의 보증으로 확대하지 않는다.

V3-040/041/065에 이 실제 카드 증거를 연결하지만 document.edit 등 남은 등록쓰기·외부 공급자 대사·클라우드·실계정·운영 설치 검증이 남아 공식 인수율은60%다. 다음은 원본을 수정하는 document.edit의 원 요청/입력 해시/backup/출력 계약과 복구, 공통 rollback 현재 파일 변조 방어다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'card-effect-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,
 hypothesis:'카드 원문·전체 출력 SQL 계약과 현재 권한/파일 소유 기반 보상을 연결하면 중단·경합·변조·철회에서 중복 제작과 허위 완료를 막을 수 있다.',
 lesson:'직접 adapter의 권한 검사와 원문 contract가 모두 필요하며 현재 권한/identity/hash를 확인하지 않은 보상 삭제도 부작용이다.',
 limitations:'최종72/72·actual process7/Pillow/G/OCR·독립42(일부synthetic). 의미/디자인/원격/운영EXE/모든쓰기/OS원자성/orphan cleanup/공통manualrollback 미완료, 공식60/100·비용미측정.',
 evidencePaths:['-report.md','-source.json','-baseline.txt','-boundaries.txt','-process-first.txt','-first-integrated.txt','-final.txt','-independent.md','-independent.test.mjs','-independent-final.txt','-build.txt','-contract.txt','-runtime.json'].map(s=>prefix+s)},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(await readFile(path,'utf8'));
for(const gate of acceptance.stages.flatMap(s=>s.gates).filter(g=>['V3-040','V3-041','V3-065'].includes(g.id))){gate.evidence??=[];if(!gate.evidence.includes(prefix+'-report.md'))gate.evidence.push(prefix+'-report.md');}
acceptance.updatedAt=observedAt;await writeFile(path,JSON.stringify(acceptance,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: PNG원문/색/크기/전체manifest SQL·privatefence/Bclaim/영속receipt/G복구·직접권한/signedscope/partial보상3반례수정·actualSIGKILL7·72/72+독립42/build/contract. 공식60·운영활성화0. 다음 document.edit 원본/backup/전체effect·manual rollback 변조보호/orphan 정리와 나머지인수.\n`);
