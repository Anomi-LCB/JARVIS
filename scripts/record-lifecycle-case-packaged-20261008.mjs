import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/lifecycle-case-packaged-20261008',observedAt=new Date().toISOString();
for(const [suffix,count] of [['-tests.txt',3],['-regression.txt',24]]){const text=await readFile(prefix+suffix,'utf8');if(!text.includes(`ℹ pass ${count}`)||!text.includes('ℹ fail 0')||!text.includes('ℹ skipped 0'))throw Error('TEST_EVIDENCE_REQUIRED');}
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS'))throw Error('BUILD_REQUIRED');
const packageSummary=JSON.parse(await readFile('artifacts/lifecycle-case-package-pilot-20261008/summary.json','utf8'));
const acceptancePath='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await readFile(acceptancePath,'utf8')).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
const counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
if(gates.length!==100)throw Error('ACCEPTANCE_COUNT_CHANGED');
const sources=['tests/lifecycle-case-packaged-restart.test.js','tests/fixtures/lifecycle-case-restart-child.mjs','scripts/lifecycle-case-package-pilot-20261008.mjs'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 최신 PC 패키지의 생활 업무 조회·재시작 검사

관측 ${observedAt}. 공식 인수 ${JSON.stringify(counts)} / 전체100 유지.

## 실제 수행

저장소의 런타임이 아니라 현재 writeInstallerPackage가 생성한 임시 pc-agent-runtime 모듈을 fixture의 동적 import로 직접 실행했다. 테스트 전용 경로 선택이며 제품의 import나 권한 규칙은 변경하지 않았다. PATH/SystemRoot/TEMP/TMP만 전달하고 실제 계정·모델 키를 자식에게 상속하지 않는다. state는 설치 코드 밖의 임시 폴더다.

정상/원본 변경/서명 변조/준비도 철회/위임 철회 5개 조건을 별도 create/recover PID 쌍으로 수행했다. 실제 configuredCore·SQL Mission 권위·Windows DPAPI 보호 키·E/B/G를 사용했다. 정상만 현재 결과를 반환하고 네 반례는 내용 없이 거절했다. 모든 회수에서 기존 executedActions=1을 유지했다. 이는 로컬 합성 반품 기록 조회이며 Shopify 실제 연결/반품 제출이 아니다.

기존 packaged-core-runtime 검사도 현재 core-launch.mjs로 실행해 파일 생성·재시작 이력·UI proxy 결과·원본 변경 거절·코드 폴더/junction 상태 경로 거절·변조 모듈 import 전 무결성 거절을 확인했다. pc-ui-payload 검사 포함 3테스트 통과. 공용 fixture 변경의 원래 서비스 재시작11 + UI클라이언트13 =24회귀 통과. 총27테스트 실패0/생략0, build 통과. 새 UI 변경은 없어 추가 브라우저 검사는 하지 않았으며 이전 화면 증거를 이번 실행으로 재집계하지 않았다.

## 업데이트 후보 보존

artifacts/lifecycle-case-package-pilot-20261008/package 에 현재 소스와 UI·Node ${packageSummary.nodeVersion} 포함 ${packageSummary.fileCount}개 해시 결속 파일을 생성했다. summary.json에 핵심 payload 해시를 보존했다. Node 해시는 이전 고정 provenance에서 가져왔으며 공식 릴리스 서명 검증을 새로 했다는 뜻은 아니다. 이 보존 패키지와 테스트의 임시 패키지는 별개이며 보존 패키지 EXE 실행을 입증하지 않는다.

이번 점검에서 새 제품 결함은 발견하지 않았다. 테스트가 저장소 코드만 실행하던 검증 빈틈을 보완했다. 설치 프로그램 EXE/서비스 host 컴파일·서명·운영 서비스 교체는 하지 않았다. 현재 사용 중인 설치본이 최신으로 바뀌었다고 표시하지 않는다. 임시 자식은 종료했고 운영 DB/F/cognition/실계정은 변경하지 않았다. 외부 유료 모델 호출0, 실제 비용과 제품 p50/p95는 미측정.

## 조사 연결 및 한계

research:watch → ledger sync → status 실행. 감시6곳 중 OpenAI3곳 HTML 해시 변경/3곳 동일/오류0. 원문 Agents API·SDK·changelog를 재조회했지만 해시 변화만으로 새 출시를 확정하지 않았다. SDK의 서버 소유 상태/권한과 관리형 API 구분은 기존 JARVIS 중심 혼합형을 유지할 근거다. [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [changelog](https://developers.openai.com/api/docs/changelog). 이번에는 새 제공자 설치/호출/활성화를 하지 않았다. 계정·예산 준비 및 독립 의미 평가가 필요하다는 기존 차단을 유지한다.

V3-041/077/099 부분 증거다. 전체 공급자 대사·생활 처리·다른 PC 실제 설치/서명/복원은 남아 있어 인수율을 올리지 않았다. 다음은 최신 패키지의 native host 실행·서비스 계정 키 접근과 실제 설치 전환 검증이다. 복원: 생성 후보를 채택하지 않으면 운영 변화가 없으며 테스트 전용 package-root 선택을 제거해도 원래 fixture 경로는 유지된다.
`,{flag:'wx'});
const evidencePaths=[prefix+'-report.md',prefix+'-source.json',prefix+'-tests.txt',prefix+'-regression.txt',prefix+'-build.txt',prefix+'-package.txt','artifacts/lifecycle-case-package-pilot-20261008/summary.json','artifacts/research-heartbeat-20261008-package-watch.txt','artifacts/research-heartbeat-20261008-package-sync.txt'];
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-packaged-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'현재 생성 PC payload의 실제 Core 그래프에서도 새 PID 로컬 생활 기록 회수와 권한/자료 변조 거절이 유지된다.',lesson:'저장소 직접 import와 실제 패키지 모듈 import를 분리해 검증해야 최신 기능이 배포 그래프에 포함됐는지 알 수 있다.',limitations:'격리 합성 입력/Windows current-user DPAPI,27검사/build. 보존 패키지 EXE 컴파일·SCM·운영 설치·실공급자·다른PC·장기관측 미완료. 비용/제품지연 미측정.'},null,2),{flag:'wx'});
for(const id of ['V3-041','V3-077','V3-099']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 현재 생성 PC payload 실제 Core 모듈의 새PID5조건/27검사/build,Node포함 업데이트 후보 보존. 운영설치EXE/SCM/서명/실공급자/다른PC 인수 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptancePath,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 현재 PC package 소스 실제 Core 새PID5조건·27검사/build·Node포함 후보 보존. 공식${counts.verified}/100 유지. 다음 native host/서비스 계정 키 접근/운영 설치 전환.\n`);
console.log(JSON.stringify({recordPrepared:true,counts,evidenceCount:evidencePaths.length}));
