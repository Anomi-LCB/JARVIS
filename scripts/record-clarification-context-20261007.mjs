import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/clarification-context-20261007',root='artifacts/clarification-context-pilot-20261007-jwqTnx';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,''));
const result=json(`${root}/result.json`);assert.equal(result.rows.length,2);
for(const row of result.rows){assert.equal(row.status,'COMPLETED');assert.equal(row.readCalls,1);assert.equal(row.writeCalls,1);
 assert.equal(row.sourceSha256,hash(readFileSync(`${root}/${row.mode}/source.txt`)));assert.equal(row.outputSha256,hash(readFileSync(`${root}/${row.mode}/result.txt`)));
 assert.equal(row.outputIndependentMatch,true);assert.ok(row.resolved.length>0);}
assert.deepEqual(result.rows.map(r=>r.interventions),[0,1]);
assert.equal(readFileSync(`${root}/typed-answer-restart/result.txt`,'utf8'),`확인된 항목\n${readFileSync(`${root}/typed-answer-restart/source.txt`,'utf8')}`);
for(const [path,count] of [[`${prefix}-regression.txt`,135],[`${prefix}-current-focused.txt`,4]]){const text=readFileSync(path,'utf8');assert.match(text,new RegExp(`tests ${count}`));assert.match(text,/fail 0/);assert.match(text,/skipped 0/);}
assert.match(readFileSync(`${prefix}-build.txt`,'utf8'),/Built static/);
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates),gate=gates.find(g=>g.id==='V3-020');
assert.equal(gate.status,'in_progress');assert.equal(gates.length,100);
const originalRequirementsSha256=hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))))),observedAt=new Date().toISOString();
const summary={observedAt,pilotObservedAt:result.observedAt,gateId:gate.id,originalRequirement:gate.requirement,originalRequirementsSha256,decision:'in_progress',
 verified:gates.filter(g=>g.status==='verified').length,scope:result.scope,
 rows:result.rows.map(({mode,status,interventions,plannerCalls,readCalls,writeCalls,durationMs,sourceSha256,outputSha256})=>({mode,status,interventions,plannerCalls,readCalls,writeCalls,durationMs,sourceSha256,outputSha256})),
 resolvedFactScope:'exact anchored source filename/recipient question forms or mapped approved answers from the same goal revision; no semantic paraphrase equivalence or general necessity proof',
 externalModelCalls:0,cost:'미측정',remaining:'general natural-language question necessity/independence and semantic answer completeness remain unverified; installed UI and live-use intervention reduction remain separate'};
writeFileSync(`${prefix}-verification.json`,JSON.stringify(summary,null,2),{flag:'wx'});
const sources=['packages/core/src/mission/clarification-context.js','packages/core/src/mission/mission-clarification.js','packages/core/src/mission/mission-runtime.js',
 'tests/clarification-context.test.js','scripts/clarification-context-pilot-20261007.mjs'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,sources:sources.map(path=>{const bytes=readFileSync(path);return {path,sha256:hash(bytes),content:bytes.toString('utf8')};})},null,2),{flag:'wx'});
writeFileSync(`${prefix}-report.md`,`# 질문 맥락 재사용과 독립 읽기 개선\n\n공식 인수46/100 유지. V3-020 원래 요구: ${gate.requirement}\n\n## 이번 변경\n\n이미 답한 질문을 planner가 다시 내도 같은 goal revision의 승인된 질문별 answers를 재사용한다. 새 질문만 남기며 모두 답했으면 사용자 gate를 다시 만들지 않고 기존 관측/답변을 가지고 재계획한다. 원문에 명시된 한 파일명 또는 명시 수신자는 좁게 정의된 질문 문법에만 직접 연결한다. 여러 파일·별칭·모호한 수신자는 추정하지 않는다. 실행 승인은 추가하지 않는다.\n\n질문 key는 trim/끝 물음표만 정규화한다. 파일/계정의 대소문자와 따옴표 속 연속 공백을 보존하여 다른 대상에 답을 재사용하지 않는다. 목표 정정 revision이나 rejected/다른 gate 유형의 답은 재사용하지 않는다. 매핑되지 않은 자유 텍스트 batch를 모든 질문 답으로 추정하지 않는다. 구조적으로 채워진 답변의 의미적 정확성은 기존처럼 unverified다.\n\n질문이 모두 이미 해소돼도 허용된 독립 readText/listFiles는 실제 관측 wave로 계속한다. clarificationContextResolved wave에도 기존 등록된 로컬 읽기 계약 검사를 적용하고, write/외부 행동을 함께 넣은 ask_user 계획은 재사용 전에 거절한다.\n\n## 실제 실행\n\n합성 자료와 고정 planner지만 실제 Core/E/B/G, 실제 파일 읽기/저장, 영속 restart를 사용했다. known-source: 원문 source.txt/result.txt를 이미 알고 있는 질문2개를 다시 묻지 않고0회 사용자 개입/읽기1/쓰기1/COMPLETED. typed-answer-restart: 필요한 두 필드를 한 batch로 받음1회, 부분 answers 거절, restart 뒤 planner가 같은 질문을 다시 내도 새 gate0/추가 read0, 제목 답변을 실제 출력 첫 줄에 연결해COMPLETED. 출력은 저장 후 직접 읽고 제목+원본 bytes 및SHA를 독립 비교했다. 이 두 실행이 일반 자연어 질문 필요성 전체를 증명하지는 않는다.\n\n초기 파일럿은 원문 requirementIds를 주입 계획에 붙이지 않아 저장 후 completion coverage에서PAUSED였다. 실패 로그 ${prefix}-pilot.txt를 보존하고, 연결 누락을 시험 계획에서 수정했다. source completion 검사를 완화하지 않았다. 초기 후속 파일럿은 output이 fixture constant였으므로 최종 파일럿에서 실제 read observation과 승인된 제목 답변을 writer 입력으로 연결했다. 최종 증거는 ${root}/result.json만 사용한다.\n\n135회귀 통과·실패0·skip0, 마지막 key 보존 변경 후4집중 및 실제2파일럿 통과,build 성공. 중복 실행 수를 새로운 고유 평가 수로 합산하지 않는다. 외부모델0,비용미측정. 시간은 결과JSON의 각 실행 durationMs이며 사용자의 답변 대기 시간이 없는 시험 조건이다.\n\n## 남은 인수\n\n원문/답변 재사용으로 반복 질문을 줄였지만, 일반 질문의 결과 영향과 읽기 대상의 의미적 독립성·답변 의미 완결성을 전체적으로 판정하는 독립 평가가 아직 없다. V3-020 in_progress 유지. 일반 표현, 질문 의존 행동, 오래된/충돌하는 답변에 대한 원문 계약·별도 의미 평가를 이어 진행한다. UI/운영 서비스/실계정/위임을 바꾸지 않았다. 복원은 source snapshot 기준으로 이번 module/import/runtime branch만 검토하고 사용자 작업 및 전체 저장소 상태는 보존한다.\n`,{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-verification.json`,`${prefix}-source.json`,`${prefix}-regression.txt`,`${prefix}-current-focused.txt`,`${prefix}-build.txt`,`${root}/result.json`,
 `${root}/known-source/source.txt`,`${root}/known-source/result.txt`,`${root}/typed-answer-restart/source.txt`,`${root}/typed-answer-restart/result.txt`,`${prefix}-pilot.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'clarification-context-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',observedAt:result.observedAt,
 hypothesis:'정확한 원문 필드와 같은 goal revision의 mapped answers를 재사용하면 결과를 바꾸지 않는 반복 질문은 제거하고 독립 파일 읽기는 계속할 수 있다.',reportedOutcome:'passed',evidencePaths,
 lesson:'답변 존재/goal revision/질문별 mapping은 재사용 근거가 되지만 semantic answer completeness는 아니다. 대상 대소문자와 literal 공백을 보존한다.',
 limitations:'actual local Core/E/B/G+persisted restart/고정planner·합성text2건/135회귀+최종4집중/build. 일반필요성·의미독립성·설치UI/실사용개입감소 미검증. V3-020 진행중/전체46/100,비용미측정.'},null,2),{flag:'wx'});
for(const path of [`${prefix}-report.md`,`${prefix}-verification.json`,`${root}/result.json`,`${prefix}-regression.txt`])if(!gate.evidence.includes(path))gate.evidence.push(path);
const prior=Array.isArray(gate.limitations)?gate.limitations:[gate.limitations];gate.limitations=[...prior,'2026-10-07 exact source/mapped answer 재사용·revision/대소문자/공백 경계 추가. 실제2건0/1개입·read/write 각1·restart/부분답거절/제목실제반영,135회귀+4집중. 일반 질문 필요성·읽기독립성·의미 완결성 및 설치 실사용 미검증 유지.'];
acceptance.updatedAt=observedAt;assert.equal(hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))))),originalRequirementsSha256);
writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 원문 파일명/명시수신자와 같은revision 질문별답 재사용,모두해소시 독립읽기계속/추가질문0. 실제local2건COMPLETED·read/write각1·restart/답변제목산출물반영·135회귀+최종4집중/build. V3-020 일반질문필요성/독립성/의미완결성 남아in_progress,전체46/100. 다음: source-bound 질문 의존성·독립 평가와 V3-029 최종권한 재검사 인수 감사.\n`);
console.log(JSON.stringify({verified:summary.verified,evidenceFiles:evidencePaths.length,evidenceBytes:evidencePaths.reduce((sum,path)=>sum+readFileSync(path).length,0)}));
