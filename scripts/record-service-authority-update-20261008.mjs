import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/service-authority-update-20261008',observedAt=new Date().toISOString();
for(const [suffix,count] of [['-transactions.txt',4],['-regression.txt',11],['-native-fifth.txt',1]]){
 const result=await readFile(prefix+suffix,'utf8');
 if(!result.includes('ℹ pass '+count)||!result.includes('ℹ fail 0')||!result.includes('ℹ cancelled 0')||!result.includes('ℹ skipped 0'))throw Error('PASS_EVIDENCE_REQUIRED');
}
for(const [suffix,marker] of [['-first.txt','changed-authority-id'],['-build.txt','Built static JARVIS'],['-contract.txt','gatePassed: true']])if(!(await readFile(prefix+suffix,'utf8')).includes(marker))throw Error('REPRO_BUILD_REQUIRED');
const native=await readFile(prefix+'-native-fifth.txt','utf8');
for(const marker of ['"phase":"committed"','"phase":"rolled_back"','"missionReadVerified":true','"keyBytesAndMtimePreserved":true','"scmInstalled":false'])if(!native.includes(marker))throw Error('NATIVE_REQUIRED');
const paths=['apps/pc-agent/src/install/transactional-update.js','tests/core-service-update-transaction.test.js','tests/service-authority-native-update.test.js','tests/fixtures/native-update-owner.cs','tests/fixtures/native-update-scm.ps1','docs/service-authority-continuation.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-research.md',[
'# 공식 출처 재검토',observedAt,
'research:watch → ledger sync → status 순서 실행. 감시6곳 중 OpenAI3곳 HTML 해시 변경,3곳 동일,오류0. 해시 변화 자체를 기술 가치나 출시 증거로 계산하지 않았다.',
'[Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)는 관리형 세션·복구·샌드박스와 모델/도구/컨테이너 과금을 구분한다. [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)는 애플리케이션 소유 저장소·권한 판단과 SDK 실행 루프를 구분한다. 현재 JARVIS 서비스 권위·원장·검증을 교체하기보다 기존 경계에 제한된 어댑터로 연결하는 방향을 유지한다. 실제 API 호출/모델 비교는 계정·예산 준비 전 차단이다.',
'[공식 changelog](https://developers.openai.com/api/docs/changelog)의 Oct7 chat-latest snapshot 갱신을 원문에서 확인했다. 이동 snapshot을 고정 비교 버전으로 취급하지 않는다. 새로운 모델 성능·정확도·비용 절감은 실측하지 않았으며 제품 모델을 자동 변경하지 않았다. 로컬 실제 결함 수정에 우선순위를 유지했다.'
].join('\n\n'),{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(stage=>stage.gates);
if(gates.length!==100)throw Error('SCOPE_CHANGED');
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
'# 서비스 업데이트·복원과 Mission/보호 키 보존',observedAt,'공식 인수 '+JSON.stringify(counts)+'/100 유지.',
'## 실제 결함과 수정',
'생성 Core 업데이트 스크립트가 이전 manifest의 서비스 실행 권위 ID·최초 fencing 번호·개인 업무 DB·trust root·Mission 저장소가 달라도 서비스를 중지하고 업데이트할 수 있었다. changed-authority-id 반례에서 failure=null인 전환을 재현했다. first 로그를 보존했다.',
'서비스 중지 전 기존/후보 environment와 serviceAuthority를 비교한다. authority backend/enabled/serviceID/expectedToken/TTL/recoveryOnly 및 프로필 ID/initialExpectedToken/TTL 변경은 CORE_UPDATE_AUTHORITY_CONTRACT_MIGRATION_REQUIRED, 개인 업무 DB/trust root/Mission store 등 자료 경로 변경은 CORE_UPDATE_DATA_CONTRACT_MIGRATION_REQUIRED로 거절한다. 기존 vault/state/installed payload 계약 검사는 유지한다. 원장·위임·키 자동 이전이나 recovery-only 자동 완화는 없다.',
'## 실행 증거',
'Core31개/PC13개 SCM 모의 시나리오를 포함한4검사 통과. 신규5개 계약 변경 반례는 stop/start0으로 현재 서비스를 보존한다. 계획·고정 authority·installed binding·owned shutdown11개 회귀, build/Core contract gate 통과.',
'추가1개 통합 검사 안에서 실제 생성 C# native 호스트와 Node 포함777파일 runtime payload로2경로를 실행했다. 실제 Core HTTP로 합성 생활 업무를 생성하고, 한정 위임/read_only 세션과 자연어 Mission을 Core→E→B→G로 완료했다. 정상 업데이트 committed, 새 호스트 bootstrap 설정 오류 주입은 rolled_back으로 이전 host 복원. 양쪽에서 DPAPI 보호 키 파일 바이트와 수정 시각 보존, 같은 SQL 원장의 Mission을 새로운 현재 read_only 세션으로 조회·검증했다. executedActions=1, 기존 위임 ID 유지, providerVerified=false. native OnStart/OnStop 실제, SCM 등록·서비스 계정은 모의다.',
'고유 test16개=4+11+1.44 SCM 시나리오와2 native 경로는 별도 숫자다. API 서비스 종단 검증·키 비교와 장부 파일 무결성 검사를 구분한다.',
'## 중간 실패 보존',
'native-first: PowerShell whitelist PATHEXT/ComSpec 누락 fixture 컴파일 실패. native-second:120초 test timeout/cancel. native-third: 지속 native 자식이 execFile 출력 pipe를 상속해 SCM 완료 수신 지연. 추적된 합성 owner path/start ticks 확인 후 stop 파일로 정상 종료했고 해당 실행은 성공으로 계산하지 않았다. spawn stdio ignore로 시험 SCM 명령과 지속 자식 pipe를 분리했다. native-fourth: OnStart 반환을 HTTP 준비 완료로 오인한 race. bounded health 재조회 후 native-fifth2경로/1검사19.6초 통과. timeout 확장만으로 해결했다고 주장하지 않는다. 제품 health/update deadline은 늘리지 않았다.',
'## 한계와 다음 인수',
'운영 설치/실제 SCM/가상 서비스 계정/재부팅/다른 PC/배포 서명/30일 관측 미완료. 관리자 검사 제거는 시험 복사본에만 적용하고 제품에서는 유지한다. 이전 완료 runtime 후보를 읽어 사용했으며 기존 후보/보고서를 덮어쓰지 않았다. 실제 공급자·실계정·외부 발송·유료 호출0. 제품 전체 p50/p95·비용 미측정.',
'과거 timeout의 합성 임시 폴더 ZGFDMY 삭제 명령은 자동 정책 검토에서 blocked by policy로 거절됐다. 재우회 삭제하지 않았다. 해당 경로 실행 중 프로세스 없음은 확인했고 합성 시험 자료만 임시 경로에 남아 있다. 실제 계정 자격증명과 개인 F/cognition은 사용·복제하지 않았다. 최종 시험은 자체 isolated cleanup을 수행했다.',
'V3-043/047/099 부분 증거이며 인수율을 올리지 않는다. 다음 관리자 SCM/실제 서비스 계정 검증·클라우드 준비 또는 실계정 연결 인수. 복원은 계약이 같은 이전 패키지에 한정된다. 계약 변경 이전은 별도 백업·대사·현재 owner 확인이 필요하다.'
].join('\n\n'),{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-research.md','-first.txt','-native-first.txt','-native-second.txt','-native-third.txt','-native-fourth.txt','-native-fifth.txt','-transactions.txt','-regression.txt','-build.txt','-contract.txt','-watch.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'service-authority-update-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'업데이트 전 authority와 DB/key 계약을 고정하면 동일 서비스 업데이트와 시작 실패 후 복원에서 Mission·서명 키를 보존할 수 있다.',lesson:'동일 상태 폴더만 검사하면 환경별 DB/키/권위 변경을 놓친다. preflight 반례와 실제 native 완료 영수증 회수를 함께 검사해야 한다.',limitations:'16고유검사/44SCM모의/2실nativeHTTP경로. SCM설치·서비스계정·운영전환·다른PC·실계정·장기관측 미완료. 제품비용·지연 미측정. fixture중간실패4회 보존, 합성임시삭제 정책거절.'},null,2),{flag:'wx'});
for(const id of ['V3-043','V3-047','V3-099']){
 const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
 gate.limitations.push('2026-10-08: 업데이트 권위/DB/키 계약 변경 중지 전 거절·16검사·실native commit/rollback 완료Mission/키 보존. SCM/운영/서비스계정/다른PC 미완료.');
}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md','\n최신 '+prefix+'-report.md: 업데이트 contract 사전 거절·실native 성공/복원 Mission/키 보존·16검사/build/contract. 공식'+counts.verified+'/100 유지. 다음 관리자SCM/실서비스계정·클라우드 준비 또는 실제 연결 인수.\n');
console.log(JSON.stringify({counts,evidenceCount:evidencePaths.length}));
