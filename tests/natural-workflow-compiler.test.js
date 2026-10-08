import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  compileNaturalWorkflowObjective as compile,
  clearNaturalWorkflowCompileCache,
  naturalWorkflowCompileCacheSize,
  NATURAL_WORKFLOW_CACHE_LIMIT
} from '../packages/core/src/mission/natural-workflow-compiler.js';
import { validateWorkflowSpec } from '../packages/core/src/mission/workflow-ir.js';

const workspaceRoot = resolve('artifacts/natural-compiler-unit');
const options = { workspaceRoot };
const read = "'input.json' JSON을 '원본'으로 읽고";
const finish = "'결과'를 'output.json' JSON으로 저장해";
function compiled(objective) {
  const result = compile(objective, options);
  assert.equal(result.status, 'compiled', JSON.stringify(result));
  assert.equal(result.clauses.length, result.clauseCount);
  assert.ok(result.clauses.every((clause) => clause.status === 'compiled' && clause.nodeIds.length > 0));
  return result;
}

test('natural workflow compiles unseen CSV fields, values, paths and dependencies without a prepared spec', () => {
  const result = compiled("먼저 'other-data/매출 2031.csv' CSV를 '판매 기록'으로 읽고; '판매 기록'에서 'status'가 'settled'인 행만 '확정'으로 걸러내고; '확정'을 'zone'별로 'invoice' 합계 'gross'를 계산해 '지역'으로 만들고; '지역'을 'gross' 내림차순으로 정렬해 '결과'로 만들고; '결과'를 'reports/unseen.csv' CSV로 저장하고; '결과'의 행 수가 7인지 검증해");
  assert.equal(result.nodeCount, 6);
  assert.equal(result.spec.nodes[0].args.path, resolve(workspaceRoot, 'other-data/매출 2031.csv'));
  assert.equal(result.spec.nodes[1].args.where.value, 'settled');
  assert.equal(result.spec.nodes[2].args.field, 'invoice');
  assert.equal(result.spec.nodes[5].args.equals, 7);
  assert.deepEqual(result.spec.nodes[2].dependsOn, ['step_002']);
  validateWorkflowSpec(result.spec);
});

test('compiled requirements retain raw source spans and actual data dependencies across three clauses', () => {
  const objective = "  'input.json' JSON을 '원본'으로 읽고; '원본'에서 필드 'id'만 추출해 '결과'로 만들고; '결과'를 'output.json' JSON으로 저장해  ";
  const result = compiled(objective);
  const contract = result.goalContract;
  assert.equal(contract.objective, objective);
  assert.equal(contract.requirements.length, 3);
  assert.equal(contract.requirements[0].sourceSpan.start, 2);
  assert.deepEqual(contract.requirements.map(item => item.nodeIds), [['step_001'], ['step_002'], ['step_003']]);
  assert.deepEqual(contract.requirements.map(item => item.dependsOn), [[], [contract.requirements[0].requirementId], [contract.requirements[1].requirementId]]);
  for (let index = 0; index < 3; index++) {
    const requirement = contract.requirements[index];
    assert.equal(objective.slice(requirement.sourceSpan.start, requirement.sourceSpan.end), requirement.text);
    assert.equal(result.clauses[index].sourceText, requirement.text);
    assert.equal(result.clauses[index].requirementId, requirement.requirementId);
  }
  assert.equal(contract.semanticCoverage, 'deterministic-grammar-only');
  assert.equal(contract.executionAuthorized, false);
  validateWorkflowSpec(result.spec);
});

test('twenty supported requirements preserve every source clause and the generated dependency chain', () => {
  const clauses = ["'input.json' JSON을 '원본'으로 읽고"];
  for (let number = 1; number <= 18; number++) {
    const source = number === 1 ? '원본' : `선택${number - 1}`;
    clauses.push(`'${source}'에서 필드 'id'만 추출해 '선택${number}'로 만들고`);
  }
  clauses.push("'선택18'을 'output.json' JSON으로 저장해");
  const objective = clauses.join('; ');
  const result = compiled(objective);
  assert.equal(result.nodeCount, 20);
  assert.equal(result.goalContract.requirements.length, 20);
  assert.deepEqual(result.goalContract.requirements.map(item => item.text), clauses);
  for (let index = 0; index < 20; index++) {
    const requirement = result.goalContract.requirements[index];
    assert.equal(objective.slice(requirement.sourceSpan.start, requirement.sourceSpan.end), clauses[index]);
    assert.deepEqual(requirement.dependsOn, index === 0 ? [] : [result.goalContract.requirements[index - 1].requirementId]);
    assert.deepEqual(requirement.nodeIds, [`step_${String(index + 1).padStart(3, '0')}`]);
  }
  validateWorkflowSpec(result.spec);
});

test('unsupported middle or unsegmented clauses hand off the whole original request without a partial executable spec', () => {
  for (const objective of [
    "  'input.json' JSON을 '원본'으로 읽고; 은행에 송금하되 원본은 삭제하지 말고; '원본'을 'output.json' JSON으로 저장해  ",
    "'input.json' JSON을 '원본'으로 읽고 요약해서 다른 앱에 보내줘"
  ]) {
    const result = compile(objective, options);
    assert.equal(result.status, 'blocked');
    assert.equal(result.spec, undefined);
    assert.equal(result.handoff.objective, objective);
    assert.equal(result.handoff.requiresWholeObjective, true);
    assert.equal(result.goalContract.objective, objective);
    assert.ok(result.goalContract.requirements.some(item => item.text.includes('보내') || item.text.includes('송금')));
  }
});

test('compile-cache provenance distinguishes padding while unchanged requirement IDs stay stable', () => {
  clearNaturalWorkflowCompileCache();
  const objective = `${read}; '원본'에서 필드 'id'만 추출해 '결과'로 만들고; ${finish}`;
  const first = compiled(objective);
  const padded = compiled(`  ${objective}  `);
  assert.equal(first.goalContract.requirements[0].sourceSpan.start, 0);
  assert.equal(padded.goalContract.requirements[0].sourceSpan.start, 2);
  assert.equal(padded.cacheHit, false);
  assert.deepEqual(first.goalContract.requirements.map(item => item.requirementId), padded.goalContract.requirements.map(item => item.requirementId));
});

test('column selection accepts conversational column lists and preserves field validation', () => {
  for (const columns of ["'ticketId,netTotal' 열", "'ticketId', 'netTotal' 컬럼"]) {
    const result = compiled(`${read}; '원본'에서 ${columns}만 선택해 '결과'로 만들고; ${finish}`);
    assert.deepEqual(result.spec.nodes[1].args.fields, ['ticketId', 'netTotal']);
    assert.equal(result.spec.nodes[1].op, 'data.project');
    validateWorkflowSpec(result.spec);
  }
  for (const columns of ["'id,__proto__'", "'id,,amount'"]) {
    const result = compile(`${read}; '원본'에서 ${columns} 열만 선택해 '결과'로 만들고; ${finish}`, options);
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'NATURAL_WORKFLOW_FIELD_INVALID');
  }
});

const examples = [
  ['select', "'원본'의 'payload.rows'를 '결과'로 선택하고", 'data.validate'],
  ['equal filter', "'원본'에서 'active'가 true인 행만 '결과'로 걸러내고", 'data.filter'],
  ['inequal filter', "'원본'에서 'state'가 'bad' 아닌 행만 '결과'로 걸러내고", 'data.filter'],
  ['numeric filter', "'원본'에서 'score'가 4.5 이상인 행만 '결과'로 걸러내고", 'data.filter'],
  ['multi-sort', "'원본'을 'team' 오름차순, 'score' 내림차순으로 정렬해 '결과'로 만들고", 'data.sort'],
  ['unique', "'원본'의 'email' 기준 중복을 제거해 '결과'로 만들고", 'data.unique'],
  ['group', "'원본'을 'team', 'month'별로 'score' 평균 'mean'을 계산해 '결과'로 만들고", 'data.groupAggregate'],
  ['group-count', "'원본'을 'team'별로 개수 'count'를 계산해 '결과'로 만들고", 'data.groupAggregate'],
  ['join', "'원본'과 '원본'을 'customerId'와 'id' 기준으로 왼쪽 조인해 '결과'로 만들고", 'data.join'],
  ['pivot', "'원본'을 행 'team', 열 'month', 값 'amount'의 합계로 피벗해 '결과'로 만들고", 'data.pivot'],
  ['validate', "'원본'의 필수 필드 'id', 'name'을 검증해 '결과'로 만들고", 'data.validate'],
  ['project', "'원본'에서 필드 'id', 'name'만 추출해 '결과'로 만들고", 'data.project'],
  ['derive', "'원본'에 'total' = ('qty' * 'price') - 2.5를 계산해 '결과'로 만들고", 'data.derive'],
  ['flatten', "'원본'의 'lines' 배열을 'line'으로 펼쳐 '결과'로 만들고", 'data.flatten'],
  ['limit', "'원본'에서 2행부터 5행을 추출해 '결과'로 만들고", 'data.limit'],
  ['union', "'원본'과 '원본'을 합쳐 '결과'로 만들고", 'data.union'],
  ['reconcile', "'원본'과 '원본'을 키 'id', 'team', 비교 필드 'name', 'score'로 대사해 '결과'로 만들고", 'data.reconcile'],
  ['window', "'원본'을 그룹 'team', 정렬 'score' 내림차순, 값 'score' 기준 밀집순위 'rank'를 계산해 '결과'로 만들고", 'data.window'],
  ['statistics', "'원본'의 'score' 통계를 계산해 '결과'로 만들고", 'data.statistics'],
  ['normalize', "'원본'의 필드 'name', 'email'을 공백제거 소문자 빈값null로 정규화해 '결과'로 만들고", 'data.normalize'],
  ['replace', "'원본'의 필드 'name'에서 '주식회사'를 '(주)'로 치환해 '결과'로 만들고", 'text.replace'],
  ['redact', "'원본'의 필드 'email'을 이메일 마스킹해 '결과'로 만들고", 'text.redact'],
  ['ledger', "'원본'을 소수 2자리 원장으로 계산해 '결과'로 만들고", 'compute.ledger'],
  ['units', "1250 'm'를 'km'로 변환해 '결과'로 만들고", 'compute.units'],
  ['toposort', "'원본'의 그래프를 위상 정렬해 '결과'로 만들고", 'graph.toposort'],
  ['shortest', "'원본'의 그래프에서 'A'부터 'D'까지 최단 경로를 계산해 '결과'로 만들고", 'graph.shortestPath'],
  ['critical', "'원본'의 임계 경로를 계산해 '결과'로 만들고", 'graph.criticalPath'],
  ['knapsack', "'원본'에서 용량 12로 최대가치 선택해 '결과'로 만들고", 'solver.knapsack'],
  ['schedule', "'원본'을 자원 3개로 일정 계산해 '결과'로 만들고", 'solver.schedule'],
  ['inventory', "'tree' 폴더의 파일을 재귀 해시 목록으로 조사해 '결과'로 만들고", 'fs.inventory'],
  ['search', "'tree' 폴더에서 정규식 'ERR[0-9]+'를 재귀 검색해 '결과'로 만들고", 'fs.search'],
  ['duplicates', "'tree' 폴더의 내용 중복을 찾아 '결과'로 만들고", 'fs.duplicates'],
  ['text-stats', "'원본'의 텍스트 통계를 계산해 '결과'로 만들고", 'text.stats'],
  ['template', "'원본'에 템플릿 '고객: {{name}}; 그리고 그대로'를 적용해 '결과'로 만들고", 'template.renderMany'],
  ['sqlite', "'원본'을 'out.sqlite' SQLite의 'rows' 테이블에 교체 저장해 '결과'로 만들고", 'sqlite.import']
];

for (const [name, clause, operation] of examples) {
  test(`canonical ${name} clause compiles entirely`, () => {
    const result = compiled(`${read}; ${clause}; ${finish}`);
    assert.equal(result.spec.nodes[1].op, operation);
    assert.equal(result.nodeCount, 3);
  });
}

test('SQLite update names preserve database publication dependency and last producer', () => {
  const result = compiled(`${read}; '원본'을 'out.sqlite' SQLite의 'rows' 테이블에 교체 저장해 'DB'로 만들고; '원본'을 'out.sqlite' SQLite의 'rows' 테이블에 키 'id'로 갱신 저장해 'DB2'로 만들고; 'DB2'의 'rows' 테이블을 '결과'로 읽고; ${finish}`);
  assert.deepEqual(result.spec.nodes[2].dependsOn, ['step_002', 'step_001']);
  assert.equal(result.spec.nodes[3].args.sql, 'SELECT * FROM "rows"');
  assert.equal(result.spec.outputs[0].nodeId, 'step_003');
  validateWorkflowSpec(result.spec);
});

test('all unsupported clauses and unsafe ambiguity block without partial spec', () => {
  for (const [objective, code] of [
    [`${read}; 모든 계정을 해킹해; '원본'를 'o.json' JSON으로 저장해`, 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED'],
    [`${read}; '미정'를 'o.json' JSON으로 저장해`, 'NATURAL_WORKFLOW_REFERENCE_UNKNOWN'],
    [`${read}; 'b.json' JSON을 '원본'으로 읽고`, 'NATURAL_WORKFLOW_NAME_DUPLICATE'],
    [`'../escape.json' JSON을 '원본'으로 읽고; '원본'를 'o.json' JSON으로 저장해`, 'NATURAL_WORKFLOW_PATH_OUTSIDE_ROOT'],
    [`${read}; '원본'를 '../escape.json' JSON으로 저장해`, 'NATURAL_WORKFLOW_PATH_OUTSIDE_ROOT'],
    [`${read}; '원본'의 '__proto__.x'를 '결과'로 선택하고`, 'NATURAL_WORKFLOW_FIELD_INVALID'],
    [`${read}; '원본'에 'total' = process.exit(0)를 계산해 '결과'로 만들고`, 'NATURAL_WORKFLOW_EXPRESSION_INVALID'],
    [`${read}; '원본'의 필드 'name'을 소문자 대문자로 정규화해 '결과'로 만들고`, 'NATURAL_WORKFLOW_NORMALIZE_OPTIONS_INVALID'],
    [`${read}; '원본'를 'same.json' JSON으로 저장하고; '원본'를 'same.json' JSON으로 저장해`, 'NATURAL_WORKFLOW_OUTPUT_DUPLICATE'],
    [`${read}; '원본'를 'unterminated JSON으로 저장해`, 'NATURAL_WORKFLOW_QUOTE_INVALID'],
    [`${read};; '원본'를 'o.json' JSON으로 저장해`, 'NATURAL_WORKFLOW_EMPTY_CLAUSE']
  ]) {
    const result = compile(objective, options);
    assert.equal(result.status, 'blocked', objective);
    assert.equal(result.code, code, objective);
    assert.equal(result.spec, undefined);
  }
});

test('ordinary requests and existing prepared workflow routing remain absent', () => {
  for (const objective of ['안녕 오늘 기분 어때?', '뉴스를 요약해 줘', 'task.workflow.json 명세를 실행해 줘', '파일을 정리해']) assert.equal(compile(objective, options).status, 'absent');
});

test('quote-aware connectors and explicit polite endings retain all requirements', () => {
  const result = compiled("먼저 'input.json' JSON을 '원본'으로 읽으세요 그리고 '원본'의 'payload.rows'를 '행'으로 선택하세요 그다음 '행'에 템플릿 '그리고 다음으로; 그대로'를 적용해 '문서'로 만드세요 마지막으로 '문서'를 'out.txt' 텍스트로 저장해 주세요");
  assert.equal(result.clauseCount, 4);
  assert.equal(result.spec.nodes[2].args.template, '그리고 다음으로; 그대로');
  assert.equal(result.spec.nodes[1].args.value.$ref.pointer, '/value/payload/rows');
  const blockedResult = compile("'input.json' JSON을 '원본'으로 읽어 그리고 알 수 없는 처리를 해 그다음 '원본'를 'out.json' JSON으로 저장해", options);
  assert.equal(blockedResult.status, 'blocked');
  assert.equal(blockedResult.clauseIndex, 1);
});

test('statistics fields and graph collection references follow named logical results', () => {
  const result = compiled(`${read}; '원본'의 'value' 통계를 계산해 '통계'로 만들고; '통계'의 'mean' 값이 20인지 검증해`);
  assert.equal(result.spec.nodes[2].args.actual.$ref.pointer, '/statistics/mean');
  const schedule = compiled(`${read}; '원본'을 자원 2개로 일정 계산해 '일정'으로 만들고; '일정'의 개수가 3인지 검증하고`);
  assert.equal(schedule.spec.nodes[2].args.value.$ref.pointer, '/items');
  assert.equal(schedule.spec.nodes[2].args.value.$ref.expectedType, 'array');
});

test('JSON, CSV and text reread nodes explicitly depend on the earlier staged writer', () => {
  for (const format of ['JSON', 'CSV', '텍스트']) {
    const result = compiled(`${read}; '원본'를 'stage.txt' ${format}로 저장하고; 'stage.txt' ${format}를 '재조회'로 읽고; '재조회'의 행 수가 2인지 검증해`);
    assert.deepEqual(result.spec.nodes[2].dependsOn, ['step_002']);
  }
});

test('an exact single earlier Mission output resolves “그 파일” and binds its writer provenance', () => {
  for (const [referent, particle] of [['그 파일', '을'], ['해당 파일', '을']]) {
    const objective = `${read}; '원본'을 'outputs/report.json' JSON으로 저장하고; ${referent}${particle} '재조회'로 다시 읽고; '재조회'의 행 수가 2인지 검증해`;
    const result = compiled(objective);
    assert.equal(result.spec.nodes[2].op, 'data.readJson');
    assert.equal(result.spec.nodes[2].args.path, resolve(workspaceRoot, 'outputs/report.json'));
    assert.deepEqual(result.spec.nodes[2].dependsOn, ['step_002']);
    const binding = result.goalContract.requirements[2].referenceBindings[0];
    assert.deepEqual(binding, {
      text: referent, path: 'outputs/report.json', mediaType: 'application/json',
      requirementId: result.goalContract.requirements[1].requirementId,
      sourceSpan: { start: result.goalContract.requirements[2].sourceSpan.start,
        end: result.goalContract.requirements[2].sourceSpan.start + referent.length }
    });
    assert.equal(result.goalContract.requirements[2].interpretation.unresolvedReferences.length, 0);
    assert.equal(result.goalContract.requirements[2].interpretation.resolvedReferences[0].basis, 'single-prior-mission-output');
    validateWorkflowSpec(result.spec);
  }
});

test('missing or multiple earlier output candidates block “그 파일” without a partial spec', () => {
  const cases = [
    [`${read}; 그 파일을 '재조회'로 다시 읽고`, 'NATURAL_WORKFLOW_REFERENCE_MISSING'],
    [`${read}; '원본'을 'outputs/a.json' JSON으로 저장하고; '원본'을 'outputs/b.json' JSON으로 저장하고; 그 파일을 '재조회'로 다시 읽고`, 'NATURAL_WORKFLOW_REFERENCE_AMBIGUOUS']
  ];
  for (const [objective, code] of cases) {
    const result = compile(objective, options);
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, code);
    assert.equal(result.spec, undefined);
    assert.equal(result.handoff.objective, objective);
  }
});

test('a person referent never inherits an earlier file binding', () => {
  const objective = `${read}; '원본'을 'outputs/report.json' JSON으로 저장하고; 그 사람에게 메시지를 보내`;
  const result = compile(objective, options);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED');
  assert.equal(result.spec, undefined);
  assert.equal(result.handoff.objective, objective);
});

test('unquoted numeric filter and explicitly numeric sort preserve type intent', () => {
  const result = compiled("'codes.csv' CSV를 '원본'으로 읽고; '원본'에서 'count'가 3인 행만 '셋'으로 걸러내고; '셋'를 'amount' 내림차순으로 숫자로 정렬해 '결과'로 만들고; '결과'를 'out.json' JSON으로 저장해");
  assert.equal(result.spec.nodes[1].args.where.numeric, true);
  assert.equal(result.spec.nodes[2].args.by[0].numeric, true);
  const lexical = compiled("'codes.csv' CSV를 '원본'으로 읽고; '원본'에서 'code'가 '003'인 행만 '셋'으로 걸러내고; '셋'를 'code' 내림차순으로 정렬해 '결과'로 만들고; '결과'를 'out.json' JSON으로 저장해");
  assert.equal(lexical.spec.nodes[1].args.where.numeric, undefined);
  assert.equal(lexical.spec.nodes[2].args.by[0].numeric, undefined);
  const mixed = compiled(`${read}; '원본'를 'team' 오름차순, 'score' 숫자 내림차순으로 정렬해 '결과'로 만들고; ${finish}`);
  assert.equal(mixed.spec.nodes[1].args.by[1].numeric, true);
});

test('a workflow suffix in data, literals or template never escapes strict clause coverage', () => {
  const result = compiled("'data.workflow.json' JSON을 '원본'으로 읽고; '원본'에 템플릿 'report.workflow.json'을 적용해 '문서'로 만들고; '문서'를 'out.json' JSON으로 저장해");
  assert.equal(result.clauseCount, 3);
  const refused = compile("'data.workflow.json' JSON을 '원본'으로 읽고; 알아서 불가능한 일을 해; '원본'를 'out.json' JSON으로 저장해", options);
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.clauseIndex, 1);
});

test('unspecified masking uses the primitive default instead of an invented compiler override', () => {
  const result = compiled(`${read}; '원본'의 필드 'note'을 이메일 마스킹해 '보호'로 만들고; '보호'의 필드 'note'을 전화번호 마스킹해 '결과'로 만들고; ${finish}`);
  assert.equal(Object.hasOwn(result.spec.nodes[1].args, 'mask'), false);
  assert.equal(Object.hasOwn(result.spec.nodes[2].args, 'mask'), false);
});

test('compile cache is bounded, immutable across callers and root scoped', () => {
  clearNaturalWorkflowCompileCache();
  const objective = `${read}; '원본'를 'o.json' JSON으로 저장해`;
  const first = compiled(objective);
  first.spec.nodes[0].args.path = 'CORRUPTED';
  first.clauses[0].text = 'CORRUPTED';
  const second = compiled(objective);
  assert.equal(second.cacheHit, true);
  assert.notEqual(second.spec.nodes[0].args.path, 'CORRUPTED');
  assert.notEqual(second.clauses[0].text, 'CORRUPTED');
  const otherRoot = compile(objective, { workspaceRoot: resolve(workspaceRoot, 'other') });
  assert.equal(otherRoot.cacheHit, false);
  assert.notEqual(otherRoot.spec.workflowId, second.spec.workflowId);
  for (let i = 0; i < NATURAL_WORKFLOW_CACHE_LIMIT + 5; i += 1) compiled(`'input-${i}.json' JSON을 '원본'으로 읽고; '원본'를 'o.json' JSON으로 저장해`);
  assert.equal(naturalWorkflowCompileCacheSize(), NATURAL_WORKFLOW_CACHE_LIMIT);
  assert.equal(compiled(objective).cacheHit, false);
});
