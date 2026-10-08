import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const prefix = 'artifacts/android-distribution-artifact-20261007';
const observedAt = new Date().toISOString();
const read = path => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
const write = (name, data) => writeFileSync(`${prefix}-${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const artifactLog = read(`${prefix}-observed.txt`);
assert.match(artifactLog, /BUILD SUCCESSFUL/u);
const fixtureResult = JSON.parse(artifactLog.split(/\r?\n/u).find(line => line.startsWith('{"passed":')));
assert.equal(fixtureResult.passed, 17);
assert.equal(fixtureResult.failed, 0);
assert.ok(fixtureResult.checks.every(c => c.expectedAllowed === c.observedAllowed));
const generated = JSON.parse(artifactLog.split(/\r?\n/u).find(line => line.startsWith('{"actualGeneratedArtifacts":')));
assert.deepEqual(generated.results.map(r => [r.channel, r.passed]), [['private-lab', true], ['play-store', true]]);
assert.match(read('artifacts/android-distribution-20261007-manifests-final.txt'), /BUILD SUCCESSFUL/u);
const productLog = read(`${prefix}-gradle-final2.txt`);
assert.match(productLog, /BUILD SUCCESSFUL/u);
assert.match(productLog, /JARVIS distribution verified: private-lab/u);
assert.match(productLog, /JARVIS distribution verified: play-store/u);
const nodeLog = read(`${prefix}-node-tests.txt`);
for (const [key, value] of [['tests', 9], ['pass', 9], ['fail', 0], ['skipped', 0]]) {
    assert.equal(Number(nodeLog.match(new RegExp(`ℹ ${key} (\\d+)`))?.[1]), value);
}
const sourceFiles = ['apps/mobile/android/app/build.gradle', 'apps/mobile/android/app/distribution-policy.gradle',
    'tests/android-distribution-policy/build.gradle', 'tests/android-distribution-policy/settings.gradle',
    'docs/android-distribution-boundary.md'];
write('source.json', { observedAt, files: sourceFiles.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), content: read(path) })) });
const snapshots = [];
for (const variant of ['debug', 'release']) {
    const title = variant[0].toUpperCase() + variant.slice(1);
    for (const [kind, path] of [
        ['manifest', `apps/mobile/android/app/build/intermediates/merged_manifest/${variant}/process${title}MainManifest/AndroidManifest.xml`],
        ['config', `apps/mobile/android/app/build/generated/source/buildConfig/${variant}/local/eureka/jarvis/BuildConfig.java`]
    ]) {
        const snapshot = `${variant}-${kind}.txt`;
        write(snapshot, read(path));
        snapshots.push({ path, snapshot: `${prefix}-${snapshot}`, generatedAt: statSync(path).mtime.toISOString(), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
}
write('verification.json', { observedAt, fixtures: fixtureResult, generatedArtifacts: generated, snapshots,
    gradleGenerationPassed: true, productGradleValidationPassed: true, nodeRegression: { passed: 9, failed: 0, skipped: 0 },
    signedApkProduced: false, physicalDeviceTested: false, playReviewPassed: false,
    remoteAppIdentityAttested: false, actualCost: null, productLatencyPercentiles: null });
write('report.md', `# Android 배포 경로 구분 인수\n\n관측 ${observedAt}. V3-083의 원래 요구인 “Play 배포용 공식 API/Intent/허용 규칙과 개인 시험용 기기 조작 경로를 구분한다”를 검토했다. 이전 JS 계약만 있었던 상태에서 실제 Gradle Manifest/BuildConfig 생성과 자동 배포 차단까지 연결했다.\n\n## 실제 결과\n\n실제 Android Gradle 생성은 성공했다(기존61270 종료0,13분6초). debug는 private-lab,release는 play-store이며 release 병합 Manifest에서 화면 오버레이·구형 외부 저장소 권한을 제거하고 평문 통신을 끈 것을 확인했다. 파일을 단순 해시로 확인한 것이 아니라 실제 XML 노드/namespace·서비스·권한과 생성된 채널 필드를 같은 Gradle 검증기로 대조했다. 앱의 verifyDebugDistribution/verifyReleaseDistribution 작업도 모두 성공했다. package/bundle/assemble 작업은 해당 검사에 의존한다. 기존 서명키 필수 조건은 유지하며 이번에 APK/AAB를 생성하거나 배포하지 않았다.\n\n정상 알림/음성 권한·namespace 별칭·주석·private 설정의 양성 대조와 금지권한6종·접근성 서비스2종·cleartext true/누락·잘못된 채널·알 수 없는 채널·DTD의 반례 **17/17**이 기대 판정과 일치했다. 기존 공식 문서URI/ARTEMIS 차단/실제 임시 keystore 조회 회귀는 **9/9**,실패0·미실행0이다. 기존 실제 Expo 화면 helper 연결/33개 검사/Webbuild 증거도 함께 검토했으며 이를 신규26건으로 합산하지 않는다.\n\n## 실패와 수정\n\n최초 제품 검증은 XML namespace 속성을 잘못 읽어 정상 release를 거부했다. XmlParser의 QName 구현은 groovy.namespace.QName이므로 namespaceURI/localPart를 명시적으로 비교하도록 수정했다. 반례 시험의 최초 standalone Gradle 실행도 settings 파일이 없어 실패해 독립 테스트 프로젝트로 정리했다. 초기 실패 로그를 보존하고 수정 후 동일 정상/음성/실제 산출물을 재검사했다. 이전 SigningConfig 배치 오류와 오프라인 캐시 누락도 기존 보고서의 실패 이력으로 보존한다.\n\n## 인수 범위와 한계\n\n이번 승격은 공식 API/Intent와 개인 기기 조작의 경로 구분에 한정한다. ARTEMIS의 play-store 설치 설정은 모든 HTTP 호출 전에 차단하고 실제 화면의 문서 보기 URI를 공식 OS 경로로 제한한다. 뷰어 열기는 본문읽기 완료가 아니다. 설치 채널 설정은 원격 앱 신원 인증이 아니며 별도 신원/권한 계약이 필요하다. 실기기 ARTEMIS 비교(V3-082),전체 기기 인수(V3-081),Play 심사·서명된 최종 앱·스토어 등록·클라우드 운영은 이번 완료에 포함하지 않는다. 비용/p50/p95는 미측정이며 유료 호출·개인계정·기억·운영서비스를 변경하지 않았다.\n\n공식 인수는51→52/100. 원래100개 요구를 바꾸지 않았다. 복원은 배포 검증 스크립트/Gradle 연결을 검토하되 기존 release 서명/공식 URI/ARTEMIS 차단을 임의로 해제하지 않는다. 다음은 남은 독립 로컬 인수 조건이며 실기기/계정 필요 항목을 이 결과로 대체하지 않는다.\n`);
const evidencePaths = ['report.md', 'verification.json', 'source.json', 'observed.txt', 'gradle-final2.txt', 'gradle-final.txt', 'gradle.txt', 'fixtures.txt', 'fixtures-diagnosis.txt', 'fixtures-attributes.txt', 'node-tests.txt', ...snapshots.map(s => s.snapshot.slice(prefix.length + 1))].map(name => `${prefix}-${name}`);
write('attempt.json', { id: 'android-distribution-artifact-20261007', candidateId: 'agent-platform-observed-scenario-status', kind: 'workflow-test', reportedOutcome: 'passed', observedAt, evidencePaths,
    hypothesis: '실제 병합 Manifest와 BuildConfig 검증을 배포 작업에 연결하면 개인 시험 설정이 Play 경로로 유입되는 것을 막을 수 있다.',
    lesson: '소스 문자열 검사는 최종 병합 파일 검증을 대신하지 않으며 XML namespace 객체 구현 차이도 정상/음성 대조로 검사해야 한다.',
    limitations: '경로 구분083만 인수. 실기기/서명 APK/Play 심사/원격앱 신원/클라우드 미검증. 비용 및 제품 지연 미측정.' });
const ledgerPath = 'docs/universal-control-v3-acceptance.json';
const ledger = JSON.parse(read(ledgerPath));
const gates = ledger.stages.flatMap(s => s.gates);
assert.equal(gates.length, 100);
assert.equal(gates.filter(g => g.status === 'verified').length, 51);
const gate = gates.find(g => g.id === 'V3-083');
assert.equal(gate.status, 'in_progress');
assert.equal(gate.requirement, 'Play 배포용 공식 API/Intent/허용 규칙과 개인 시험용 기기 조작 경로를 구분한다.');
gate.status = 'verified';
gate.reviewedAt = observedAt;
gate.evidence.push(...evidencePaths);
gate.limitations.push('2026-10-07 최신: 실제Gradle 생성·제품 검증debug/release 성공,namespace XML/채널 반례17통과·기존회귀9통과로 원래083 경로 구분 인수. 이전 진행중 로그를 대체한다. 실제기기082·신원081/원격앱인증·서명APK/Play심사는 별도 미완료.');
ledger.updatedAt = observedAt;
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
appendFileSync('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: Android 실제병합/BuildConfig/제품Gradle배포검사·반례17/회귀9 통과로 V3-083 verified. 공식52/100. 기존61270/27631 종료0, live빌드없음. 실제기기/Play심사/서명APK/원격앱신원 인수는 별도. 다음 독립 미완료 로컬 조건으로 진행한다.\n`);
console.log(JSON.stringify({ verified: 52, acceptanceId: gate.id, observedAt }));
