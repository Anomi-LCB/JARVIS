import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/service-authority-continuation-20261008',observedAt=new Date().toISOString();
for(const [suffix,count] of [['-regression.txt',41],['-bootstrap.txt',9]]){const text=await readFile(prefix+suffix,'utf8');if(!text.includes(`ℹ pass ${count}`)||!text.includes('ℹ fail 0')||!text.includes('ℹ skipped 0'))throw Error('FINAL_TESTS_REQUIRED');}
if(!(await readFile(prefix+'-first.txt','utf8')).includes('A_CORE_AUTHORITY_REVISION_CONFLICT'))throw Error('REPRO_REQUIRED');
for(const [suffix,marker] of [['-build.txt','Built static JARVIS'],['-contract.txt','gatePassed: true'],['-compile.txt','CoreRuntimeBindingVerified'],['-cli.txt','Status: created']])if(!(await readFile(prefix+suffix,'utf8')).includes(marker))throw Error('BUILD_PACKAGE_REQUIRED');
const sourcePaths=['packages/core/src/mission/sqlite-mission-store.js','packages/core/src/mission/mission-execution-authority.js','scripts/core-service-runtime.mjs','packages/core/src/install/core-service-packager.js','scripts/core-service-package.mjs','tests/service-authority-continuation.test.js','tests/lifecycle-case-native-core-host.test.js','tests/core-service-mission-authority.test.js','docs/service-authority-continuation.md'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
const acceptancePath='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptancePath,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates),counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));if(gates.length!==100)throw Error('SCOPE_CHANGED');
await writeFile(prefix+'-report.md',`# 고정 Windows 서비스 설정의 안전한 Core 재시작

관측 ${observedAt}. 공식 인수 ${JSON.stringify(counts)} /100 유지.

## 이전 증거의 한계와 재현

앞선 native 호스트 테스트는 정상 종료·부모 pipe EOF로 실행 권위를 반납하는 것을 입증했지만, 시작마다 fixture가 expectedToken을0→1→2→3으로 바꿨다. 실제 Windows 서비스 설정은 고정이므로 이것만으로 반복 재시작이 완성됐다고 볼 수 없었다. fixture를 고정0으로 바꿔 실제 컴파일 호스트에서 다시 수행하니 두 번째 시작이 A_CORE_AUTHORITY_REVISION_CONFLICT로 실패했다. first 로그를 보존했다. 이후 fixed 파일의 실패는 fixture 편집용 Python 호출 오류로 서비스 ID가 아직 반영되지 않았던 중간 실행이며 제품 수정 실패와 혼동하지 않는다.

## 구현

기본 명시적 expectedToken 규칙을 유지하면서 설치자가 선택한 동일 서비스의 연속성만 추가했다. 등록은 서비스 UUID와 최초 정확한 원장 번호에 결속된다. 같은 개인 업무 SQL DB의 mission_service_authority에 id/service_id/last_token/initial_token을 저장한다. 첫 등록과 매 인수는 기존 BEGIN IMMEDIATE 안에서 실행된다. 재시작은 서비스 ID·최초 번호·마지막 취득 번호가 현재 원장과 모두 일치할 때만 새 fencing 번호를 취득한다. 현재 활성 Core·활성 Mission·불명 effect·단조 clock·TTL 규칙은 유지한다.

다른 서비스 ID·최초 번호 변경은 거절한다. 다른 Core가 명시적으로 권위를 인수하면 마지막 번호가 달라져 이전 서비스가 자동으로 되찾을 수 없다. 이전 서비스의 expectedToken만 현재 번호로 바꿔도 복구되지 않는다. 다른 장치로 자동 failover하거나 DB 파일을 공유하지 않는다. 행의 이전 형식에서 initial_token이 없으면 nullable migration 후 등록 내용을 추정하지 않고 거절한다.

런타임은 서비스 ID가 있으면 Windows-service flag·전용 부모 stdin flag·SQLite·유효한 명시적 최초 번호를 요구한다. 이 값은 관리자 배포 설정이지 사용자 요청/문서/MCP 응답에서 받는 인수가 아니다. 계정·자료·위임 권한을 추가하지 않는다. 로컬 SQL와 설치 설정의 OS 쓰기 권한은 계속 보호해야 한다. env flag 자체를 적대적 로컬 관리자의 신원 인증이라고 주장하지 않는다.

패키지 선택 설정 serviceAuthority={id,initialExpectedToken,ttlMs}와 CLI --service-authority-file을 구현했다. reviewed installedRuntime이 필수이고 세 필드 이외 값/잘못된 UUID/번호/TTL은 거절한다. 생성 C# 호스트 환경에 해당 프로필과 stateRoot/operations.sqlite를 고정한다. 기존 설치·원장의 기본 경로를 자동 바꾸지 않는다. 운영 이전에는 백업·원장 이전·계정 키·서비스 ID 유지 검증이 필요하다.

## 실제 검증

현재 생성 PC payload/bundledNode/컴파일 Core 호스트의 고정 설정으로 네 번 시작했다. 정상 Mission 완료→OnStop→새 PID에서 현재 read_only 권한으로 서명 결과 회수→위임 철회 후 거절→세 번째 부모 호스트 SIGKILL/자식 EOF 정상종료→네 번째 즉시 인수가 통과했다. fixture가 시작마다 번호를 보정하지 않으며 생성 호스트가 고정 프로필을 설정한다. executedActions=1 유지, Windows current-user DPAPI protected/persistent/rawKeyStored=false를 실제 diagnostics에서 확인했다. providerVerified=false, SCM설치/service-account검증=false.

SQL·서비스·native·packaging·shutdown 공유41검사 통과. 추가 bootstrap 검사는 기존8개와 새 ‘시작 실패 뒤 동일 설정 복구’1개를 다시 실행해9/9 통과했다. 고유 검사는 총42개이며 중복 재실행을50개로 더하지 않았다. active competitor·다른 서비스·다른 Core 인수·최초 번호 변경·expired fence·RUNNING Mission·uncertain effect·잘못된 입력·실패한 bootstrap 반납을 검사했다. build/Core contract gate 통과. UI 변경 없어 브라우저 반복 검사는 하지 않았다.

artifacts/service-authority-continuation-20261008-package 에 현재777개 결속 파일/Node 포함 후보와 binding.json/authority.json을 보존했다. 새 CLI로 Core 서비스 패키지를 생성하고 실제 호스트를 컴파일해 --check-runtime 통과를 확인했다. 이전 후보/기록을 덮어쓰지 않았다. 이 후보는 격리 state·새 서비스 ID·admin-token hash 미설정이며 운영 설치용 완료본이 아니다.

## 남은 조건

관리자 환경 SCM 설치/서비스 계정/재부팅/다른 PC/서명/운영 전환·복원/장기 관측은 아직 미확인이다. 진행 중 Mission/불명 외부 효과가 있으면 정상 쓰기 시작을 계속 막고 명시적 recovery-only/비활성 워커로 대사해야 한다. 자동으로 복구 모드나 위임을 완화하지 않았다. 역할·클라우드/실계정·미지원 앱 전체가 완료된 뜻은 아니다. 실계정/유료 API 호출0, 제품 p50/p95·비용 미측정. 운영 F/cognition·개인 원장·기존 프로세스는 보존했다.

V3-043/047/099 부분 증거로 연결하되 공식60%를 유지한다. SCM·기기·실계정 준비 조건을 사용자에게 질문했으며 응답 없이 해당 인수를 성공 처리하지 않는다. 다음은 실제 서비스 계정과 운영 전환 검증, 또는 준비된 다른 연결의 종단 인수다. 복원은 서비스를 중지·대사하고 이전 수동 expectedToken 구성으로 명시적 인수한다. 새 연속성 행을 자동 삭제하지 않으며 다른 Core 인수로 이전 서비스의 자동 복귀가 차단되는 성질을 유지한다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-fixed.txt','-native.txt','-tests.txt','-regression.txt','-bootstrap.txt','-build.txt','-contract.txt','-package.txt','-cli.txt','-compile.txt'].map(s=>prefix+s).concat('artifacts/service-authority-continuation-20261008-package/summary.json');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'service-authority-continuation-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'서비스 ID·최초 번호·마지막 취득 번호를 SQL 권위와 원자 결속하면 고정 설정으로 동일 서비스만 반복 재시작하고 다른 Core 인수 뒤 자동 탈환을 차단할 수 있다.',lesson:'fixture가 재시작마다 fencing expectedToken을 바꾸면 고정 SCM 설정의 실제 부족을 감춘다. config 불변과 다른 권위 인수 반례를 함께 검사해야 한다.',limitations:'고정 설정 실제 compiledOnStart/OnStop/부모crash/현재 DPAPI/42고유검사/build/contract/CLI후보컴파일. SCM·서비스계정·운영 설치·재부팅·다른PC·실계정·장기 미완료. 비용/제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-043','V3-047','V3-099']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 고정 서비스 설정 expected0 재시작 실패 재현→serviceID/initial/last fencing SQL 원자 결속·다른Core 인수 뒤 자동복귀 거절·실native4시작/42고유검사/build/contract/CLI후보컴파일. SCM/서비스계정/재부팅/운영/다른PC 전체 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptancePath,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 고정 서비스 설정의 반복 재시작 failure 수정·SQL service binding/타Core 후 자동탈환 거절·실native4시작·42고유검사·build/contract/CLI후보컴파일. 공식${counts.verified}/100 유지. 실제 SCM/서비스계정 및 준비된 연결 인수 이어갈 것.\n`);
console.log(JSON.stringify({counts,evidenceCount:evidencePaths.length}));
