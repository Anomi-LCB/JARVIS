import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const prefix = 'artifacts/core-mobile-gateway-20261007';
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const observedAt = new Date().toISOString();
const log = read(`${prefix}-final-proof.txt`);
for (const pattern of [/tests 46\b/u, /pass 46\b/u, /fail 0\b/u, /skipped 0\b/u]) assert.match(log, pattern);
assert.match(read(`${prefix}-build.txt`), /Built static/u);
assert.match(read(`${prefix}-contract.txt`), /gatePassed: true/u);
const observation = JSON.parse(log.split(/\r?\n/u).find(line => line.startsWith('{"coreMobileGatewayObservation"'))).coreMobileGatewayObservation;
assert.equal(observation.handoffStatus, 'COMPLETED'); assert.equal(observation.workerCalls, 1); assert.ok(observation.actualNonemptyArtifacts > 0);
const acceptancePath = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse(read(acceptancePath)), gates = acceptance.stages.flatMap(stage => stage.gates);
assert.equal(gates.length, 100); assert.equal(gates.filter(gate => gate.status === 'verified').length, 48);
const requirementsHash = hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement }))));
const gate = gates.find(gate => gate.id === 'V3-043'); assert.equal(gate.status, 'pending');
const verification = { observedAt, acceptanceId: gate.id, originalRequirement: gate.requirement, originalRequirementsSha256: requirementsHash,
  tests: { files: 7, total: 46, passed: 46, failed: 0, skipped: 0, durationMs: 2521.1974 }, observation,
  build: 'passed', coreContract: 'passed', actualCoreHttp: true, actualMobileJavaScriptClient: true, actualBridgeProcess: true,
  physicalAndroid: false, cloudActivated: false, operatingServiceUpdated: false, externalCalls: 0, providerCost: null,
  cost: '미측정', verified: 48, scope: '중앙 Core와 모바일 HTTP 게이트웨이·실제 로컬 파일·중복 인계 차단. 현장 설치/클라우드/실기기 인수 아님.' };
writeFileSync(`${prefix}-verification.json`, JSON.stringify(verification, null, 2), { flag: 'wx' });
const sourcePaths = ['apps/bridge/src/core-gateway.js', 'apps/bridge/src/main.mjs', 'apps/bridge/src/bridge-runtime.js',
  'apps/runtime-compose/src/create-runtime.js', 'packages/core/src/main.mjs', 'scripts/core-service-runtime.mjs',
  'scripts/product-runtime.mjs', 'tests/core-mobile-gateway.test.js', 'tests/product-runtime-secrets.test.js'];
writeFileSync(`${prefix}-source.json`, JSON.stringify({ observedAt, scope: '전체 현재 파일 보존, 이번 변경 전체로 계산하지 않음',
  files: sourcePaths.map(path => ({ path, sha256: hash(readFileSync(path)), content: read(path) })) }, null, 2), { flag: 'wx' });
writeFileSync(`${prefix}-report.md`, `# 모바일 연결의 단일 Core 실행 경로

공식 인수율은 **48/100**. V3-043은 대기에서 진행 중으로 옮겼다. 기존 100개 요구 및 분모는 유지했다.

## 발견과 구현

제품 실행기가 Core와 모바일 브리지에서 각각 createAgRuntime을 호출해 두 실행 엔진을 생성하는 결함을 발견했다. Core API URL이 설정돼 있어도 브리지의 작업·승인·실행은 별도 CoreFacade에 들어가던 구조였다.

메인 Core의 공유 BridgeRuntime을 /mobile 네임스페이스에 연결했다. 이 객체는 CoreFacade·실행 워커·기억·정책을 공유한다. 브리지는 고정된 로컬 Core에 HTTP/SSE/WebSocket을 전달하는 전용 프로세스로 변경했다. 기기 토큰과 기존 페어링 파일은 Core가 보관하고 브리지의 기기 서명키·검토 토큰은 제거했다. 성장 검토도 기존 메인 Core 소유자 세션의 권한을 확인한다.

원래 Host·원격 주소·forwarded 헤더를 먼저 검사하며 경로 정규화 후 /mobile을 붙여 관리자 경로 이탈을 막는다. Core 장애와 응답 손실은 실패 상태로 남기며 외부 쓰기를 재시도하거나 별도 엔진을 생성하지 않는다. 초기 응답 시간 제한과 SSE 연결 유지, WebSocket 양쪽 소켓 정리를 구현했다. 제품 health 신원은 Core 모바일 활성화와 브리지 core-api 실행 모드를 요구해 이전 엔진의 응답을 새 구조 활성화로 오인하지 않는다. URL 없는 독립 CLI 실행은 개발 opt-in 외에는 차단한다.

## 실제 관측

실제 격리 Core 서비스와 HTTP BridgeClient에서 페어링→작업 생성→승인→실행 인계→메인 워커→로컬 보고서 파일→결과 재조회까지 진행했다. 생성 파일 ${observation.actualNonemptyArtifacts}개를 다시 읽어 비어 있지 않은 내용을 확인했다. 두 번째 확인에서도 워커 호출은 1회였다. 파일의 주관적 품질·본문 요구 전체를 이 검사로 입증하지 않는다.

Core 재시작 뒤 기존 기기 토큰의 인증을 확인했고 잘못된 토큰은 거부됐다. 같은 요청 ID는 추가 작업을 만들지 않았다. SSE 시작, WebSocket 프레임 전달/종료, public Host/forwarded 주소 거부, 인코딩된 경로의 네임스페이스 유지, 응답 손실 후 POST 호출 1회와 Core 장애 503을 확인했다. 별도 실제 브리지 CLI 프로세스를 실행해 작업 디렉터리에 파일/원장을 만들지 않았으며 Core URL 누락도 독립 엔진을 만들기 전에 거부했다.

관련 7개 파일 46/46 통과, 실패/제외 0, 최종 runner 2521.1974ms. 이 시간은 제품 p50/p95가 아니다. PC outbound·Core authority fence 및 기존 모바일 준비도·클라이언트·토큰·소켓 회귀를 포함한다. 빌드와 Core 계약 gate도 통과했다. 최초 시험의 토큰 metadata/deviceToken 혼동, nonce replay 반환값, task 승인 fixture 오류와 테스트 서버 WebSocket 정리 누락은 최종 검사 전에 수정했다. 최초 실패 로그는 보존했다.

## 한계와 다음 단계

실제 Android·클라우드·현장 PC 설치본은 이번 실행 대상이 아니다. 새 게이트웨이는 로컬 HTTP Core origin만 허용하며 클라우드 연결에는 별도 인증된 전송이 필요하다. 기존 기기 파일 경로/키를 사용하는 설정은 구현했지만 운영 중인 기존 계정의 이전을 실제 완료했다고 주장하지 않는다. 단일 장치/동일 Core HTTP 검사와 기존 outbound 회귀를 모든 실제 장치·외부 서비스의 성공으로 확대하지 않는다. V3-043 전체 인수 완료로 승격하지 않았다.

기존 브리지의 산출물 자동 열기는 중앙 서비스에서 활성화하지 않았다. 복합 자연어 Mission 경로, 인계의 장기 복구, 실제 설치본 갱신/원격 연결 검증이 다음 작업이다. 운영 서비스/사용자 앱은 변경하지 않았고 외부 전송·유료 호출은 0, 실제 비용 미측정이다.

복원은 게이트웨이·Core 모바일 라우팅/설정만 좁게 검토한다. 사용자 기억·페어링·원장·다른 변경을 삭제하지 않는다. 파일 해시는 현재 소스 보존이며 독립 실행 증거와 구분한다.
`, { flag: 'wx' });
const evidencePaths = [`${prefix}-report.md`, `${prefix}-verification.json`, `${prefix}-source.json`, `${prefix}-first.txt`,
  `${prefix}-second.txt`, `${prefix}-regression.txt`, `${prefix}-final-proof.txt`, `${prefix}-build.txt`, `${prefix}-contract.txt`, 'docs/core-mobile-gateway.md'];
writeFileSync(`${prefix}-attempt.json`, JSON.stringify({ id: 'core-mobile-gateway-20261007', candidateId: 'agent-platform-observed-scenario-status',
  kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
  hypothesis: '브리지의 독립 Core 생성 대신 메인 Core의 기존 모바일 정책/실행 객체를 공유하면 모바일 요청을 단일 원장으로 연결하면서 인증과 승인 경계를 유지할 수 있다.',
  lesson: 'Core URL 설정만으로 실행 권위가 통합되지 않는다. 실제 task/worker 동일성·파일·프로세스·재시작·중복 반례를 확인해야 한다.',
  limitations: '공식48/100·V3-043진행 중.46통과/build/contract. 실제 로컬 HTTP/CLI/파일, 실기기·클라우드·운영 설치본 미검증. 비용미측정.' }, null, 2), { flag: 'wx' });
gate.status = 'in_progress'; gate.evidence.push(...evidencePaths.slice(0, 3)); gate.reviewedAt = observedAt;
gate.limitations.push('2026-10-07 메인 Core /mobile API·상태 없는 브리지·실제 HTTP/CLI·로컬 파일/중복 인계 차단·46회귀/build/contract. 실제 Android/클라우드/설치본/현장 이전은 별도 인수.');
assert.equal(hash(JSON.stringify(gates.map(({ id, requirement }) => ({ id, requirement })))), requirementsHash);
acceptance.updatedAt = observedAt; writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 브리지 독립 Core 제거·메인 /mobile API·실제 HTTP/CLI/로컬 파일·46회귀/build/contract. V3-043 대기→진행 중, 공식48유지. 다음 설치본/인증된 원격 장치와 복합 Mission 연결.\n`);
console.log(JSON.stringify({ verified: 48, evidenceBytes: evidencePaths.reduce((sum, path) => sum + readFileSync(path).length, 0) }));
