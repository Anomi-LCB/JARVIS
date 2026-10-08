import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/subtree-fence-20261007';
const read=path=>readFileSync(path,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,value)=>writeFileSync(`${prefix}-${suffix}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for(const [key,value] of [['tests',66],['pass',66],['fail',0],['skipped',0]])assert.match(read(`${prefix}-regression.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-reproduction.txt`),/"status":"COMPLETED"/);
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json';
const doc=JSON.parse(read(acceptancePath)),gates=doc.stages.flatMap(stage=>stage.gates);
const verified=gates.filter(gate=>gate.status==='verified').length;
assert.equal(gates.length,100);
const paths=['packages/core/src/personal-operations/mandate-scope.js','packages/core/src/mission/mission-field-summary-result.js','apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js','tests/discovered-workflow-data-scope.test.js','tests/personal-mandate-scope.test.js'];
write('source.json',{observedAt,files:paths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('report.md',`# 재귀 폴더 위임의 제외 범위 강제\n\n관측: ${observedAt}. 공식 인수 ${verified}/100 유지.\n\n실제 Core/E/PC B/G Mission에 재귀 메타데이터 권한, 개별 입력·출력 권한, 제외한 하위 폴더를 함께 지정했다. 수정 전 하위 폴더의 원문을 읽고 JSON을 저장해 COMPLETED로 표시했다. 재현은 subtree-fence-20261007-reproduction.txt에 보존했다. 첫 before/baseline 실행은 영속 기억 미설정·제외 ref의 스키마 조건 문제로 의미 있는 재현에 도달하지 못했다. 테스트에 격리 SQLite 성장 기억과 명시적으로 등록한 제외 ref를 준비한 뒤 제품 결함을 재현했으며, 제품의 기억 준비 조건을 완화하지 않았다.\n\nPC 재귀 열거의 실제 디렉터리·각 항목에 접근 전후 위임 검사를 연결했다. Core의 최종 원문·결과 재발견도 실제 방문 경로를 검사한다. file-tree: 메타데이터 참조만 상위의 재귀 권한을 상속하며 file: 바이트 읽기는 개별 허용이 필요하다. 명시적으로 등록된 제외 tree는 하위 메타데이터와 바이트 접근 모두 거부한다. 이름이 비슷한 형제 경로는 권한을 상속하지 않는다. 금지 폴더를 건너뛰고 유일한 파일이라고 주장하지 않고 전체 결과 확인을 차단한다.\n\n7개 검사 파일 66/66 통과, fail0/skip0. 실제 임시 원문·SQLite·PC 어댑터를 사용하는 Mission에서 허용 경로 완료, 제외 경로 출력 없음, 중간 철회·동적 경로·내용 권한·변조·결과 조회 차단을 확인했다. 실제 성공 Mission의 관측을 Core G에 다시 전달하고 별도 위임으로 하위 경로를 제외하면 검증 증거를 반환하지 않는 것도 확인했다. 외부 모델·유료 API·메일·거래·실계정 호출은 없다. 빌드와 Core 계약 통과. 전체 전기·장비 비용은 미측정이며 이 변경의 대규모 폴더 p50/p95 성능 개선은 주장하지 않는다.\n\nV3-032/033의 로컬 예외 강제 증거를 보강했다. 원래 인수 기준이나 상태는 변경하지 않는다. 모든 제공자 계정·장치의 위임 결합, 실사용 관측은 여전히 미완료다. 설치본 교체·운영 서비스 재시작은 하지 않았다. 개인 프로필과 실제 F/cognition 업무 기억을 변경하지 않았다.\n\n복원 시 mandate-scope의 tree 규칙, PC 실제 경로 검사, Core 재발견 검사를 함께 검토해야 하며 되돌리면 제외 폴더 접근이 다시 가능해질 수 있다. 다음 작업은 큰 재귀 목록에서 권한 철회·물리 경로 변경 검사를 유지하면서 중복 검사 비용을 측정하고, 위임의 계정·제공자 연결을 계속 검증하는 것이다.\n`);
const evidence=['report.md','source.json','before.txt','baseline.txt','reproduction.txt','focused.txt','regression.txt','build.txt','contract.txt'].map(suffix=>`${prefix}-${suffix}`);
write('attempt.json',{id:'subtree-fence-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths:evidence,
 hypothesis:'재귀 검색의 실제 하위 경로를 위임으로 재확인하면 허용된 상위 폴더 아래의 제외 범위 접근을 차단하면서 양성 작업 완료를 유지할 수 있다.',
 lesson:'수정 전 실제 Mission이 제외 하위 폴더 자료로 완료한 결함 재현. 실제 경로 검사·메타데이터 전용 상속·하위 예외 강제로 차단,66회귀와 build/contract 통과.',
 limitations:`격리 로컬 Mission과 임시 SQLite/파일 검증. 실계정·실기기·설치본 및 대규모 성능·총비용 미측정. 공식 ${verified}% 유지.`});
for(const id of ['V3-032','V3-033']){
 const gate=gates.find(gate=>gate.id===id);assert.notEqual(gate.status,'verified');
 gate.evidence.push(...evidence);(gate.limitations??=[]).push('2026-10-07: 실제 재귀 하위 경로의 예외 강제, metadata-only 권한 상속과 byte 권한 분리,66회귀/build/contract. 전체 계정·제공자·기기 위임 실증은 미완료.');
}
doc.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(doc,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 제외 하위 폴더의 실제 Mission 허위 완료 재현·수정. 실제 경로 위임,66회귀/build/contract. 공식${verified}% 유지, V3-032/033 부분 증거. 다음 대규모 메타데이터 검사 비용 및 제공자·계정 위임 결합.\n`);
console.log(JSON.stringify({observedAt,verified,tests:66}));
