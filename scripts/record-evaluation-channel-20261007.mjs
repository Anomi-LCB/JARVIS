import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/evaluation-channel-20261007',observedAt=new Date().toISOString();
const final=await readFile(prefix+'-final-fixed.txt','utf8');
if(!final.includes('ℹ pass 57')||!final.includes('ℹ fail 0')||!final.includes('ℹ skipped 0'))throw Error('Final evidence unavailable');
const paths=['packages/core/src/capabilities/container-capability-package-evaluator.js','tests/capability-evaluation-result-boundary.test.js','tests/persistent-evaluation-budget.test.js','packages/core/src/runtime/container-execution-environment.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))),officialSource:{url:'https://nodejs.org/download/release/v24.8.0/docs/api/worker_threads.html',checkedAt:observedAt,scope:'MessageChannel/transferList/port.close/structured clone; API itself is not a hostile-code security proof'}},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 자동 개선 평가의 거짓 통과 차단·Docker 복구

관측 ${observedAt}. 원래100 인수60 verified/20진행/20대기 유지. 목표90%를 축소하지 않는다. 신규 운영서비스/설치EXE 활성화0. Docker Desktop 기존 설치 엔진을 Hidden 시작했고 서버29.8.2를 실제 조회했다. 클라우드/계정/유료호출/외부발송0. 테스트는 고정 합성후보·격리 temp·실제 pinned Linux 컨테이너와 실제 새PID를 사용하며 사용자 F/cognition 변경0.

## 재현과 수정

실제 후보가 parentPort로 결과 한 건을 직접 보내고 process.exit(0)하면 createAdapter가 없어도 오라클과 같다는 이유로 통과했다. 변경전 실제 컨테이너 반례1 실패(Missing expected rejection)를 보존했다. 후보가 JSON.stringify를 바꾸거나 Array.prototype.push를 바꾸면 실제 반환999가 기대값null로 변환되어 거짓 통과하는2반례도 실제 컨테이너에서 재현했다.

평가프로그램이 별도 MessageChannel을 만들고 전용port만 전달한다. 후보 import 전에 workerData에서 port 참조를 제거하고 기본parentPort를 닫는다. 전용postMessage/close와 결과 append는 후보 import 전에 결속한다. 결과는 후보가 바꿀 수 있는 JSON stringify/parse로 다시 만들지 않고 structured clone으로 부모 평가프로그램에 보내며, 부모에서 유한 plain JSON·단일 결과·정확한 ID/개수 및 호스트에만 있는 expected를 대조한다. 후보 stdout은 결과로 사용하지 않는다. 이 구현은 결과 통로와 해당 전역함수 변조를 막는 개선이며 Node 내부 메모리/inspector/모든 전역 변조에 대한 완전한 보안 격리를 의미하지 않는다. 컨테이너와 제한된자료·별도 승격권한 경계는 유지한다.

확대56개 실행에서55통과/1실패가 발생했다. 새로운 private port의 메시지와 Worker exit는 별도 이벤트이므로 exit가 먼저 처리되면 정상 결과를 잘못 거부할 수 있었다. 결과 채널close와 Worker exit를 모두 관측한 뒤 한 결과·exit0을 판단하도록 수정했다. 동시실행 조절만으로 성공을 가장하지 않고 이 경합을 코드로 제거했다. 최종은 테스트파일 concurrency3으로 실행했으며 전체57/57 실패0/skip0이다.

새 receipt에 private-message-port-v1을 기록한다. 영속 평가 cache와 restoreCompleted는 이 버전을 검사하므로 과거 취약한 통로의 결과를 현재 통과 증거로 재사용하지 않는다. 실제 SQLite에 유효 해시를 가진 구버전 fixture를 보존하고 다시 연결한 evaluator의 cache·복원 거부/새dispatch0/기존quota0 보존을 검사했다. 새 단계의 재평가가 필요하며 예산을 조용히 늘리지 않는다. 기존 signed comparison의 모든 역사적 receipt/운영 승격을 일괄 재심사한 것은 아니다.

## 검증

최종57개는 결과 경계11·오라클 snapshot4·실제 컨테이너평가기7·기능rollback4·평가budget6·M06 sandbox2·영속budget7·runtime restart3·signed promotion journal13을 포함한다. 정상 후보 실행, 예산/오라클/허위결과 차단, SQL 재개방·별도PID·기능승격/rollback·공유원장 서명/잠금/중단 회귀를 함께 확인한다. 숫자는 최종 Node test 합계이며 중간24/34/56/독립13을 중복 합산하지 않는다.

앞선 rollback-move 기록에서 Docker pipe 미존재로 차단됐던4건도 엔진 시작 후 별도 실제 실행4/4 통과했다. 이4건은 최종57에 포함되므로 총61로 계산하지 않는다. 실제 엔진 제한 관측은 M06이 UID65534·network none·read-only root·자료mount1읽기전용·capDrop·noNewPrivileges·자원상한과 호스트파일/비밀환경/네트워크/루트쓰기 차단을 확인한다. 이는 Docker Desktop VM 안의 Linux 격리이며 새 상시 클라우드노드 배포나 rootless hardenedVM 증거가 아니다. 테스트 소유 jarvis-task 컨테이너는 종료 뒤 목록0을 관측했다.

최종 build/Core contract gate 통과. 고정 이미지 digest는 기존 Node24.8 이미지, 새로운 모델/외부라이브러리 설치0. [Node24.8 공식 worker 문서](https://nodejs.org/download/release/v24.8.0/docs/api/worker_threads.html)에서 transferList/close/structured clone 의미를 확인했다. 문서와 SHA 무결성은 실험의 독립 의미검증/안전성 증명을 대신하지 않는다.

## 남은 조건과 복원

공식 인수율은60%다. 기존 V3-093/095 회귀의 신뢰도를 보강했으나 실계정·상시배포·의미26/260·실기기·30일/200건·서명/다른PC 인수는 남는다. 제품 요청완료율/p50/p95·실제모델/PC연산비는 미측정이며 컨테이너 테스트시간을 제품성능으로 보고하지 않는다. 후보의 모든OS공격/전역변조/사례별OS분리는 이번에 완료하지 않았다.

복원은 evaluator 메시지통로/append/receipt버전 검사를 이전 코드로 되돌리는 방식이나 거짓통과 보호를 잃는다. 원래 SQL/위임/파일/예산/이력을 삭제하거나 구버전receipt에 새버전을 덧씌우지 않는다. 최신색인으로 남은쓰기·원문 의미·원격/실계정·배포를 이어 진행한다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'evaluation-channel-20261007',candidateId:'m12-signed-promotion-journal-and-recovery',kind:'workflow-test',reportedOutcome:'passed',observedAt,
hypothesis:'개선 후보가 직접 접근하는 parentPort와 후보의 JSON/배열 전역함수를 평가결과 경로에서 분리하면 실제 잘못된 반환과 미실행 후보가 오라클 통과로 둔갑하는 것을 막을 수 있다.',
lesson:'컨테이너 격리만으로 후보와 평가프로그램의 결과권한이 분리되는 것은 아니다. private port의 close/exit 양쪽을 관측하고 이전 통로의 캐시를 새 증거로 재사용하지 않아야 한다.',
limitations:'실제컨테이너3거짓통과 재현/수정·정상race1수정·최종57/57·Docker차단4재검증. Node 전체악성코드/모든과거comparison·운영/설치/실계정/장기 미완료·공식60유지.',
evidencePaths:['-report.md','-source.json','-baseline.txt','-intrinsic-baseline.txt','-final-versioned.txt','-final-fixed.txt','-build-fixed.txt','-contract-fixed.txt','-queue.txt','-docker-version.json','-container-residual-final.txt','artifacts/docker-recovery-20261007-previously-blocked.txt'].map(s=>s.startsWith('artifacts/')?s:prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제Docker復구·앞선차단4통과·parentPort/JSON/Array 거짓통과3재현수정·private결과port/close-exit race/SQL구버전cache보류·57/57/build/contract. 공식60·운영활성화0. 다음 일반원문·남은쓰기/원격·실계정·원래100인수/90%목표 유지.\n`);
