import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/mcp-permission-revision-20261007';
const read=path=>readFileSync(path,'utf8').replace(/^\uFEFF/u,'');
const sha=value=>createHash('sha256').update(value).digest('hex');
const final=read(`${prefix}-final.txt`);
assert.match(final,/tests 222/);assert.match(final,/pass 222/);assert.match(final,/fail 0/);assert.match(final,/skipped 0/);
assert.match(read(`${prefix}-build.txt`),/Built static/);
const rows=final.split(/\r?\n/).filter(line=>line.startsWith('{"mode":')).map(line=>JSON.parse(line));
assert.deepEqual(rows.map(r=>r.mode),['probe','dispatch','policy','verifier','cached']);
assert.deepEqual(rows.map(r=>r.calls),[0,0,0,1,1]);
const acceptancePath='docs/universal-control-v3-acceptance.json';
const acceptance=JSON.parse(read(acceptancePath)),gates=acceptance.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-029');
assert.equal(gates.length,100);assert.equal(gate.status,'in_progress');
const originalRequirementsSha256=sha(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))));
const observedAt=new Date().toISOString();
const summary={observedAt,gateId:gate.id,requirement:gate.requirement,decision:'in_progress',verified:gates.filter(g=>g.status==='verified').length,
 originalRequirementsSha256,rows,regression:{tests:222,passed:222,failed:0,skipped:0},externalModelCalls:0,cost:'미측정',
 scope:'actual loopback HTTP MCP + two SQLite manager instances; synthetic arithmetic/document source and test policy; actual Core/E/B/G Mission receipt invalidation',
 limitation:'MCP permission generation is not yet captured as a Mission planning availability snapshot. Remote/provider/device deployment and cross-process atomic dispatch revocation remain separate.'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(summary,null,2),{flag:'wx'});
const sources=['packages/core/src/personal-operations/mcp-connections.js','packages/core/src/capabilities/mcp-capability-package.js','tests/mcp-permission-revision.test.js','tests/mcp-mission-integration.test.js','tests/mcp-reviewed-document.test.js'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,sources:sources.map(path=>({path,sha256:sha(readFileSync(path)),content:read(path)}))},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# MCP 권한 철회·재허용 경합 수정\n\n공식 인수 ${summary.verified}/100 유지. V3-029: ${gate.requirement}\n\n## 실제 결함과 수정\n\n실제 localhost MCP 서버와 같은 SQLite DB를 읽는 별도 manager를 사용했다. 조회 중, 최종 실행 세션의 tools/list 중, 검증 중 권한을 철회한 뒤 같은 도구를 재허용하면 이전 요청/결과가 살아나는 결함4건을 수정 전 재현했다. 최초 실패 로그는 ${prefix}-before.txt에 보존했다.\n\n권한 집합 변경마다 영속 permissionRevision을 새로 기록한다. 동일 권한 재저장은 기존 revision을 유지한다. discovery는 authoritative 현재 grant/revision을 합쳐 저장하므로 오래된 probe가 새 권한 이력을 덮지 않는다. 조회 전/후와 RPC 바로 전 revision을 비교한다. 최종 정책 callback 뒤 마지막 DB 조회를 두어 callback 자체의 권한 변경도 차단한다. 계약 변경으로 grant가 사라지는 기존 NOT_AUTHORIZED 분류는 유지한다.\n\n검증 전·후와 영수증 DB 저장 transaction 안에서 현재 권한/revision을 확인한다. 영수증에 revision을 저장하고 결과 조회 및 실제 G receipt verifier가 이를 대조한다. 철회 후 재허용은 과거 민감 결과를 되살리지 않는다. 과거 receipt 자체는 역사 기록으로 보존되며 새 권한으로 새 requestId를 실행해야 새 결과를 사용할 수 있다. 과거 revision 없는 DB/receipt는 null로 비교하며 다음 실제 grant 변경부터 새 세대를 적용한다.\n\n## 관측\n\n5개 새 경계: probe/dispatch/policy 변경은 도구 호출0, verifier 변경은 이미 실행한 호출1을 보존하되 영수증 생성0, cache 변경은 최초 정상 호출1의 결과 재접근 차단. 서로 다른 SQLite manager의 철회/재허용이며 별도 OS 프로세스 선형화 증거는 아니다. 실제 Core/E/B/G MCP Mission의 정상 COMPLETED·공급자 호출1 뒤 권한을 바꾸면 기존 criterion 증거가 false가 되고 재호출0인 경우도 검사했다.\n\n회귀 222통과·실패0·skip0, 전체22187.3747ms. 이 수치는 테스트 runner 전체 시간이며 실사용 p50/p95가 아니다. 초기 확대 회귀220통과/2실패는 ${prefix}-regression.txt에 보존했다. 한 실패는 기존 오류 분류를 보존하는 순서로 수정했고, 다른 하나는 기존 시험이 철회 후 과거 cache 부활을 전제로 변조를 검사했기 때문이다. 그 시험은 과거 접근 차단을 추가한 뒤 새 requestId의 실제 검증 결과로 변조·만료 거부를 계속 검사한다. 오라클을 완화하지 않았다. build 성공. 외부 모델 호출0, 새 권한/운영 서비스 변경 없음, 비용미측정.\n\n## 남은 인수와 복원\n\nMCP adapter의 권한 세대는 아직 Mission 계획 단계 CapabilityAvailability snapshot에 연결되지 않았다. 지금 수정은 실행 도중과 검증/결과 접근 경계다. 계획과 실행 사이의 regrant를 재계획 대상으로 만들고 준비도 UI에 설명하는 연결이 다음 작업이다. 원격 장치/실계정 및 다른 OS 프로세스의 RPC dispatch와 철회를 원자적으로 묶는 보장은 미검증이다. V3-029를 완료로 올리지 않는다. source snapshot으로 이번 MCP revision/receipt 검사만 검토 복원할 수 있으며 실제 사용자 DB나 다른 작업 전체를 되돌리지 않는다.\n`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-before.txt`,`${prefix}-regression.txt`,`${prefix}-final.txt`,`${prefix}-build.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'mcp-permission-revision-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt:rows.at(-1).observedAt,evidencePaths,
 hypothesis:'영속 권한 revision을 실행과 검증에 결속하면 철회 후 동일 권한 재허용이 이전 요청/민감 결과를 되살리는 경합을 차단한다.',
 lesson:'현재 grant 집합만 확인하면 revoke/regrant 이력이 사라진다. 정책 callback 이후와 검증 transaction 안에서도 현재 세대를 대조하고 역사 영수증을 새 실행 권한으로 쓰지 않는다.',
 limitations:summary.limitation+' 전체46/100 유지; 222회귀/build; 실제 localhost/SQLite/합성자료; 비용미측정.'},null,2),{flag:'wx'});
for(const path of evidencePaths.slice(0,3))if(!gate.evidence.includes(path))gate.evidence.push(path);
const previous=Array.isArray(gate.limitations)?gate.limitations:[gate.limitations];
gate.limitations=[...previous,'2026-10-07 MCP revoke/regrant ABA 실제4실패 재현→5경계 수정/실제Mission G receipt 세대 차단/222회귀. 계획 시 MCP availability snapshot 연결 및 실계정/프로세스 원자 dispatch 인수는 남음.'];
acceptance.updatedAt=observedAt;assert.equal(sha(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))),originalRequirementsSha256);
writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: MCP 권한 철회·재허용 경합4실패 재현,영속revision/최종정책후조회/검증transaction/결과접근/G 영수증세대 연결. 새5경계·실제Mission G 반례·222회귀/build. V3-029 in_progress/전체46/100. 다음: MCP 권한세대를 계획 CapabilityAvailability snapshot과 실행 직전 검증에 연결.\n`);
console.log(JSON.stringify({verified:summary.verified,evidenceFiles:evidencePaths.length,evidenceBytes:evidencePaths.reduce((sum,path)=>sum+readFileSync(path).length,0)}));
