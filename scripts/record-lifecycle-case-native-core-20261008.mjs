import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-native-core-20261008',observedAt=new Date().toISOString();
for(const [suffix,count] of [['-regression.txt',19],['-key.txt',4]]){const text=await readFile(prefix+suffix,'utf8');if(!text.includes(`ℹ pass ${count}`)||!text.includes('ℹ fail 0')||!text.includes('ℹ skipped 0'))throw Error('TEST_PROOF_REQUIRED');}
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS')||!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true')||!(await readFile(prefix+'-compile.txt','utf8')).includes('CoreRuntimeBindingVerified'))throw Error('PACKAGE_PROOF_REQUIRED');
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates),counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));if(gates.length!==100)throw Error('GATES_CHANGED');
const sources=['packages/shared/src/owned-service-shutdown.js','scripts/core-service-runtime.mjs','packages/core/src/install/core-service-packager.js','tests/lifecycle-case-native-core-host.test.js','tests/owned-service-shutdown.test.js','scripts/lifecycle-case-package-pilot-20261008.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# Windows Core 서비스 호스트의 정상 종료·권위 인수 결함 수정

관측 ${observedAt}. 공식 인수 ${JSON.stringify(counts)} / 전체100 유지.

## 재현과 원인

실제 생성 C# JarvisCoreRuntimeHost.exe를 컴파일하고 reflection으로 OnStart/OnStop을 호출해 현재 PC 패키지의 core-launch.mjs와 bundled Node를 실행했다. 별도 임시 state와 SQL 실행 권위, 합성 반품 기록을 사용했다. 첫 실패는 fixture가 ProgramData를 전달하지 않아 vault 환경 경로를 해석하지 못한 시험 구성 오류였다. ProgramData를 정상 전달한 두 번째 실행에서는 첫 Mission 완료 후 OnStop/OnStart 즉시 재시작이 A_CORE_AUTHORITY_ANOTHER_CORE_ACTIVE로 실패했다. 이 두 실패 로그를 삭제하지 않았다.

생성 호스트의 OnStop은 child.Kill()로 바로 프로세스를 종료했다. Core.close가 SQL 실행 권위를 release할 기회를 잃었고 기본30초 lease가 남았다. 같은 원장을 즉시 열려는 새 Core를 올바른 단일 실행 권위 검사기가 거절했다. 검사를 제거하거나 lease를 무조건 덮어써 해결하지 않았다.

## 제품 수정

서비스 호스트가 비공개 자식 stdin을 소유한다. JARVIS_WINDOWS_SERVICE=1 및 JARVIS_CORE_SERVICE_STDIN_SHUTDOWN=1을 호스트가 설정하고 정확한 JARVIS_CORE_SERVICE_STOP_V1 한 줄로 정상 종료를 요청한다. Core는 이 두 조건에서만 전용 pipe를 읽으며 기존 close로 워커/서버/원장/실행 권위를 정리한 뒤 종료한다. 호스트가 죽어 pipe가 EOF가 되는 경우에도 같은 close를 한번만 수행한다. 일반 Core stdin, 사용자 명령, HTTP/도구 입력에는 새 종료 권한을 부여하지 않았다. close 오류는 종료코드1이며 조용히 성공으로 바꾸지 않는다.

OnStop은 최대10초 정상 종료를 기다리고 끝나지 않을 때만 강제 종료한다. 이 경우 기존 lease/fencing·불명 효과 복구 규칙을 유지한다. 닫힌 pipe의 IOException/InvalidOperationException 뒤에도 제한 시간 대기와 fallback을 수행한다. OS 전체나 다른 프로세스의 실행 권위를 지우지 않는다.

## 관측 결과

현재 소스로 생성한 임시 PC payload + 실제 컴파일된 Core 서비스 호스트 + bundled Node: 첫 실행의 자연어 로컬 생활 기록 Mission 완료, 정상 OnStop 이후 새 PID 인수와 서명 결과 회수, executedActions=1 유지, 새 read_only 세션 요구, 위임 철회 후 결과 거절을 확인했다. 세 번째 호스트를 SIGKILL하자 private pipe EOF로 자식 Core가 사라졌고 네 번째 Core가 곧바로 다음 fencing token을 인수했다. 이 전체 경로는 하나의 네이티브 종단 테스트다.

관리자 diagnostics에서 windows-dpapi-current-user/persistent=true/protectedByOs=true/rawKeyStored=false를 확인했다. 이는 현재 Windows 사용자로 실행한 호스트의 보호 키이며 virtual-service-account 키 접근이나 사용자와 서비스 간 키 이전을 입증하지 않는다.

공유 회귀19개(서비스/권위/재시작/설치 binding/현재 payload/전용 pipe 포함) 통과, 최종 native+pipe4개 추가 재실행 통과. 같은 검사 반복을 서로 다른23개 검사로 집계하지 않았다. 실패0/생략0. build 및 Core API contract gate 통과. UI 변경 없어 새 브라우저 검사는 하지 않았다.

수정된 payload를 artifacts/lifecycle-case-native-package-20261008/package 에777개 결속 파일로 보존했다. 별도 core-service 패키지를 생성하고 실제 JarvisCoreRuntimeHost.exe를 컴파일한 뒤 --check-runtime 성공을 확인했다. 이전 immutable 후보는 덮어쓰지 않았다. 이 후보는 admin token hash 설정 전이고 운영 설치를 하지 않은 시험 산출물이다. 보존 후보의 host binding 확인과 임시 패키지에서 수행한 종단 테스트를 구분한다.

## 남은 조건과 복원

현재 세션의 WindowsPrincipal Administrator=false를 실제 확인했다. SCM 등록·다른 서비스 계정·재부팅·다른 PC·운영 설치/서명/장기 관측은 수행하지 않았다. reflection으로 실제 OnStart/OnStop을 호출한 것은 SCM 설치 성공과 다르다. 실계정/외부 모델 호출0, 운영 F/cognition·원장은 보존했다. 테스트가 만든 고유 ProgramData 서비스 폴더와 temp state만 경로 검증 후 정리했고 소유 자식을 종료했다. 비용/제품 p50/p95 미측정.

V3-041/047/099 부분 증거를 추가하며 완료로 올리지 않는다. 다음은 관리자 환경에서 테스트용 SCM 서비스의 설치/중지/재시작/서비스 계정 키 경로를 검사하고 기존 운영 서비스 전환·복원 인수로 이어가는 것이다. 복원할 때 생성 호스트와 Core 전용 pipe 처리를 함께 이전 버전으로 돌려야 하며 이전 Kill-only 방식에서는 권위 lease 만료 전에 재시작을 성공이라고 표시하지 않는다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-first.txt','-second.txt','-fixed.txt','-regression.txt','-final.txt','-key.txt','-build.txt','-contract.txt','-compile.txt','-package.txt'].map(s=>prefix+s).concat('artifacts/lifecycle-case-native-package-20261008/summary.json');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-native-core-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'실제 Windows Core 서비스 호스트가 자식 정상 종료를 기다리면 SQL 실행 권위를 반납하여 즉시 새 PID 복구와 검증 결과 회수가 가능하다.',lesson:'저장소 close와 Node 직접 재시작이 통과해도 생성 C# OnStop의 강제 종료는 권위 인수를 깨뜨릴 수 있다. 실제 native 호스트의 종료·부모 crash·개별 pipe·현재 권한을 함께 검증해야 한다.',limitations:'현재 사용자 reflection OnStart/OnStop·DPAPI·새PID/19회귀+최종4재실행/build/contract/호스트컴파일. 관리자false로 SCM/서비스계정/운영설치/서명/다른PC/장기관측 미완료. 비용/제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-041','V3-047','V3-099']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 실제 컴파일 Core 호스트 Kill-only 종료의 SQL권위 인수 실패 재현·전용stdin 정상종료/부모EOF복구 수정,19회귀/최종4재실행/build/contract/현재후보컴파일. 관리자false,SCM/다른서비스계정/재부팅/운영설치/서명/다른PC 미완료.');}
doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제 native Core OnStop 강제종료로 SQL권위 반납누락→전용 pipe 정상종료/부모EOF복구,19회귀·최종4재실행/build/contract·수정후보컴파일. 공식${counts.verified}/100 유지. 다음 관리자 SCM/서비스계정 키/운영 전환·복원.\n`);
console.log(JSON.stringify({counts,evidenceCount:evidencePaths.length}));
