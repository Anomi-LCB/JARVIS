import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract, reviseGoalContract, checkGoalPlanCoverage, tokenizeGoalSource } from '../packages/core/src/mission/goal-contract.js';

test('explicit conjunctive file saves preserve both source clauses and additive targets',()=>{
 for(const objective of ["'first.txt'를 저장하고 'second.txt'도 저장해",'first.txt를 저장하고 second.txt도 저장해',"'📚 원본.txt'를 저장하고 “새 결과.txt”도 저장해"]){
  const c=createGoalContract({objective});assert.equal(c.requirements.length,2);
  assert.deepEqual(c.requirements.map(r=>[r.interpretation.status,r.interpretation.action]),[['recognized','save'],['recognized','save']]);
  for(const r of c.requirements)assert.equal(objective.slice(r.sourceSpan.start,r.sourceSpan.end),r.text);
 }
 assert.deepEqual(createGoalContract({objective:"'first.txt'를 저장하고 'second.txt'도 저장해"}).requirements.map(r=>r.interpretation.target),['first.txt','second.txt']);
});
test('quoted conjunctions and unresolved or prohibited followups never become silent partial requirements',()=>{
 const quoted=createGoalContract({objective:"'저장하고 삭제하고 파일.txt'를 저장해"});assert.equal(quoted.requirements.length,1);assert.equal(quoted.requirements[0].interpretation.target,'저장하고 삭제하고 파일.txt');
 for(const objective of ["'first.txt'를 저장하고 그것도 저장해","'first.txt'를 저장하지 말고 'second.txt'도 저장해","'first.txt'를 저장하고 자동으로 계정 권한을 늘려","지도 저장해"]){
  assert.ok(createGoalContract({objective}).requirements.some(r=>r.interpretation.status==='unresolved'),objective);
 }
});
test('unquoted document content reads bind the file rather than the noun content',()=>{
 for(const [text,path] of [['report.xlsx 내용을 읽어줘','report.xlsx'],['report.pdf 본문을 읽어줘','report.pdf'],['먼저 원문.txt의 내용을 읽어줘','원문.txt'],['report.xlsx 내용을 읽지 마','report.xlsx']]){
  const item=createGoalContract({objective:text}).requirements[0].interpretation;
  assert.equal(item.target,path);assert.equal(item.action,'read');assert.equal(item.status,'recognized');
 }
 assert.equal(createGoalContract({objective:'report.xlsx 내용을 읽지 마'}).requirements[0].interpretation.polarity,'prohibited');
 assert.equal(createGoalContract({objective:"'내용'을 읽어"}).requirements[0].interpretation.target,'내용');
});

test('three clauses preserve exact original spans including emoji, curly quotes and leading whitespace', () => {
  const objective = "  '📚원문'을 읽어; “설교 초안”을 요약해 그리고 '최종본'을 저장해  ";
  const contract = createGoalContract({ objective });
  assert.equal(contract.objective, objective);
  assert.equal(contract.offsetEncoding, 'utf16-code-units');
  assert.deepEqual(contract.requirements.map(item => item.text), ["'📚원문'을 읽어", '“설교 초안”을 요약해', "'최종본'을 저장해"]);
  assert.deepEqual(contract.requirements[0].sourceSpan, { start: 2, end: 12 });
  for (const item of contract.requirements) assert.equal(objective.slice(item.sourceSpan.start, item.sourceSpan.end), item.text);
  assert.equal(contract.semanticCoverage, 'unverified');
  assert.equal(contract.executionAuthorized, false);
});

test('terminal Korean sentence punctuation separates a clear list request from a following prohibition', () => {
  const objective = '현재 작업 폴더의 파일 이름 목록을 보여줘. 파일은 수정하지 마.';
  const tokenized = tokenizeGoalSource(objective);
  assert.deepEqual(tokenized.clauses, ['현재 작업 폴더의 파일 이름 목록을 보여줘.', '파일은 수정하지 마.']);
  assert.deepEqual(tokenized.sourceSpans.map(span => objective.slice(span.start, span.end)), tokenized.clauses);
  const contract = createGoalContract({ objective });
  assert.deepEqual(contract.requirements.map(item => [item.interpretation.status, item.interpretation.action,
    item.interpretation.polarity]), [['recognized', 'list', 'required'], ['recognized', 'change', 'prohibited']]);
  assert.equal(contract.constraints.length, 1);
});

test('twenty distinct explicit requirements remain present without filler requirements', () => {
  const expected = ['원문을 읽어', '본문을 요약해', '초안을 저장해', '임시파일을 삭제해', '요약본을 보내',
    '설정을 변경해', '목록을 읽어', '회의록을 요약해', '계획을 저장해', '메모를 수정해',
    '표를 읽어', '분석을 저장해', '후기를 요약해', '안내문을 전송해', '불용파일을 제거해',
    '시간표를 변경해', '참고문헌을 읽어', '인용문을 저장해', '강연을 요약해', '원본은 삭제하지 마'];
  const objective = expected.join('; ');
  const result = createGoalContract({ objective });
  assert.equal(result.requirements.length, 20);
  assert.deepEqual(result.requirements.map(item => item.text), expected);
  assert.equal(new Set(result.requirements.map(item => item.requirementId)).size, 20);
  assert.equal(result.constraints.length, 1);
  assert.equal(result.constraints[0].text, '원본은 삭제하지 마');
});

test('quoted delimiters and instructions stay literal; malformed quotes do not produce partial contracts', () => {
  const objective = "'a; 그리고 삭제해'를 읽어; 'b'를 저장해; 'c'를 요약해";
  const result = createGoalContract({ objective });
  assert.equal(result.requirements.length, 3);
  assert.equal(result.requirements[0].interpretation.action, 'read');
  assert.equal(result.requirements[0].interpretation.target, 'a; 그리고 삭제해');
  assert.equal(result.constraints.length, 0);
  assert.throws(() => tokenizeGoalSource("'파일을 읽어; 파일을 삭제해"), { code: 'A_GOAL_QUOTE_INVALID' });
  assert.throws(() => tokenizeGoalSource('파일을 읽어;; 초안을 저장해'), { code: 'A_GOAL_EMPTY_CLAUSE' });
});

test('requirements remain stable across an unrelated inserted clause but literal whitespace is meaningful', () => {
  const first = createGoalContract({ objective: "'A B'를 읽어; 초안을 저장해; 원본은 삭제하지 마" });
  const next = reviseGoalContract(first, { objective: "안내문을 요약해; 'A B'를 읽어; 초안을 저장해; 원본은 삭제하지 마" });
  assert.equal(next.goalId, first.goalId);
  assert.equal(next.revision, 2);
  assert.deepEqual(next.requirements.slice(1).map(item => item.requirementId), first.requirements.map(item => item.requirementId));
  assert.notDeepEqual(next.requirements[1].sourceSpan, first.requirements[0].sourceSpan);
  const changed = createGoalContract({ objective: "'A  B'를 읽어; 초안을 저장해; 원본은 삭제하지 마" });
  assert.notEqual(changed.requirements[0].requirementId, first.requirements[0].requirementId);
});

test('duplicate instructions have distinct IDs without hiding a duplicate requested effect', () => {
  const result = createGoalContract({ objective: '메일을 보내; 메일을 보내; 원본을 읽어' });
  assert.notEqual(result.requirements[0].requirementId, result.requirements[1].requirementId);
  assert.equal(result.requirements[0].text, result.requirements[1].text);
});

test('affirmative and negative same-target actions conflict while different targets do not', () => {
  const result = createGoalContract({ objective: '초안을 보내; 초안을 보내지 마; 원본을 읽어' });
  assert.equal(result.requirements[0].interpretation.polarity, 'required');
  assert.equal(result.requirements[1].interpretation.polarity, 'prohibited');
  assert.deepEqual(result.contradictions, [{ code: 'contradictory-requirements', requirementIds: result.requirements.slice(0, 2).map(item => item.requirementId) }]);
  assert.equal(createGoalContract({ objective: '초안을 보내; 비밀문서를 보내지 마; 원본을 읽어' }).contradictions.length, 0);
  assert.equal(createGoalContract({ objective: '메일을 절대 보내' }).requirements[0].interpretation.polarity, 'required');
});

test('negation, exclusion, corrections and unresolved references are preserved instead of guessed', () => {
  const result = createGoalContract({ objective: "원본은 삭제하지 말고 요약본을 저장해; '비공개'는 제외해; 아니, '민수'에게 대신 보내; 그 파일을 읽어" });
  assert.equal(result.requirements.length, 4);
  assert.equal(result.requirements[0].interpretation.compound, true);
  assert.equal(result.requirements[0].interpretation.status, 'unresolved');
  assert.equal(result.requirements[2].interpretation.correction, true);
  assert.deepEqual(result.requirements[3].interpretation.unresolvedReferences, ['그 파일']);
  assert.deepEqual(result.constraints.map(item => item.kind), ['prohibition', 'exclusion']);
  assert.equal(result.unresolvedRequirementIds.length, 4);
  const actions = result.requirements.map(item => ({ requirementIds: [item.requirementId] }));
  assert.equal(checkGoalPlanCoverage(result, actions).canDispatchExternalEffects, false);
});

test('prior-turn references and ambiguous relative weekdays stay unresolved and cannot authorize external effects', () => {
  const priorTurn = createGoalContract({ objective: '저번에 말한 문서를 수정해' });
  assert.equal(priorTurn.requirements[0].interpretation.status, 'unresolved');
  assert.deepEqual(priorTurn.requirements[0].interpretation.unresolvedReferences, ['저번에 말한']);
  assert.equal(checkGoalPlanCoverage(priorTurn, [{ requirementIds: [priorTurn.requirements[0].requirementId] }])
    .canDispatchExternalEffects, false);

  const deictic = createGoalContract({ objective: '이 자료를 이메일로 보내' });
  assert.deepEqual(deictic.requirements[0].interpretation.unresolvedReferences, ['이 자료']);
  assert.equal(deictic.requirements[0].interpretation.status, 'unresolved');

  const literal = createGoalContract({ objective: "'그 자료'를 요약해" });
  assert.deepEqual(literal.requirements[0].interpretation.unresolvedReferences, [],
    'quoted literal names are not deictic references');

  const relative = createGoalContract({ objective: "다음 화요일까지 'report.txt'를 저장해; 이번주말에 초안을 보내; 'receipt.txt'를 보내기까지 3일 후",
    referenceTime: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul' });
  assert.deepEqual(relative.times.map(item => [item.text, item.status, item.date ?? null]), [
    ['다음 화요일', 'unresolved', null], ['이번주말', 'unresolved', null], ['3일 후', 'unresolved', null]
  ]);
  const coverage = checkGoalPlanCoverage(relative, relative.requirements.map(item => ({ requirementIds: [item.requirementId] })));
  assert.equal(coverage.canDispatchExternalEffects, false);
  assert.deepEqual(coverage.unresolvedTimeExpressions.map(item => item.text), ['다음 화요일', '이번주말', '3일 후']);
});

test('common Korean scheduling windows remain explicit and block external effects when no deterministic date is available', () => {
  const expressions = ['금주', '차주', '이번 주', '주중', '주말', '월말', '말일', '연말', '다음 달',
    '5영업일 이내', '조만간', '이따', '오전 중'];
  for (const expression of expressions) {
    const objective = `'source.txt'를 읽어; 'draft.txt'를 저장해; ${expression} 'draft.txt'를 보내`;
    const contract = createGoalContract({ objective, referenceTime: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul' });
    const unresolved = contract.times.find(item => item.status === 'unresolved'
      && objective.slice(item.sourceSpan.start, item.sourceSpan.end) === item.text
      && item.text.replaceAll(/\s/gu, '').includes(expression.replaceAll(/\s/gu, '')));
    assert.ok(unresolved, `${expression} must be preserved as an unresolved temporal constraint`);
    const coverage = checkGoalPlanCoverage(contract, contract.requirements.map(item => ({ requirementIds: [item.requirementId] })));
    assert.equal(coverage.canDispatchExternalEffects, false, `${expression} must not authorize an external action`);
  }
});

test('event-relative Korean timing remains unresolved instead of disappearing from the execution contract', () => {
  const expressions = ['아이 도착하면', '회의 끝난 뒤', '결제 승인되면', '예배 전에', '파일 업로드 완료 후'];
  for (const expression of expressions) {
    const objective = `'draft.txt'를 저장해; ${expression} 'draft.txt'를 보내`;
    const contract = createGoalContract({ objective, referenceTime: '2026-09-30T00:00:00.000Z', timeZone: 'Asia/Seoul' });
    const unresolved = contract.times.find(item => item.status === 'unresolved'
      && objective.slice(item.sourceSpan.start, item.sourceSpan.end) === item.text
      && item.text.includes(expression));
    assert.ok(unresolved, `${expression} must remain an explicit unresolved temporal constraint`);
    const coverage = checkGoalPlanCoverage(contract, contract.requirements.map(item => ({ requirementIds: [item.requirementId] })));
    assert.equal(coverage.canDispatchExternalEffects, false, `${expression} must not authorize an external action`);
  }
});

test('an unsegmented compound or extra unsupported instruction is not silently treated as an atomic understood requirement', () => {
  for (const objective of ['자료를 읽고 요약해서 저장해', '원본을 읽고 다른 앱에서 계약 조건을 대조해']) {
    const result = createGoalContract({ objective });
    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0].text, objective);
    assert.equal(result.requirements[0].interpretation.status, 'unresolved');
    assert.equal(checkGoalPlanCoverage(result, [{ requirementIds: [result.requirements[0].requirementId] }]).canDispatchExternalEffects, false);
  }
});

test('time hints use an explicit reference instant and local calendar; unsupported dates remain unresolved', () => {
  const result = createGoalContract({ objective: '내일 오후 3시까지 자료를 읽어; 2026-02-30에는 보내지 마; 다음 주 일정을 검토해',
    referenceTime: '2026-09-27T16:30:00.000Z', timeZone: 'Asia/Seoul' });
  assert.deepEqual(result.times.map(item => [item.text, item.date ?? item.localTime ?? null, item.status]), [
    ['내일', '2026-09-29', 'parsed-date'], ['오후 3시', '15:00', 'parsed-time'],
    ['2026-02-30', null, 'unresolved'], ['다음 주', null, 'unresolved']
  ]);
  assert.equal(createGoalContract({ objective: '내일 자료를 읽어' }).times[0].status, 'unresolved');
  assert.throws(() => createGoalContract({ objective: '자료를 읽어', timeZone: 'Not/A_Zone' }), { code: 'A_GOAL_TIME_ZONE_INVALID' });
});

test('date-time pairs reject nonexistent and repeated wall times while preserving unique local times', () => {
  const missing = createGoalContract({ objective: "2026-03-08 오전 2시 '회의.txt'를 저장해",
    timeZone: 'America/New_York' });
  const missingTime = missing.times.find(item => item.kind === 'time-of-day');
  assert.equal(missingTime.localTime, '02:00');
  assert.equal(missingTime.status, 'unresolved');
  assert.equal(missingTime.resolutionIssue, 'nonexistent-local-time');
  const missingCoverage = checkGoalPlanCoverage(missing, missing.requirements.map(item => ({ requirementIds: [item.requirementId] })));
  assert.equal(missingCoverage.canDispatchExternalEffects, false);
  assert.equal(missingCoverage.unresolvedTimeExpressions[0].resolutionIssue, 'nonexistent-local-time');

  const repeated = createGoalContract({ objective: "2026-11-01 오전 1시 30분 '회의.txt'를 저장해",
    timeZone: 'America/New_York' });
  const repeatedTime = repeated.times.find(item => item.kind === 'time-of-day');
  assert.equal(repeatedTime.localTime, '01:30');
  assert.equal(repeatedTime.status, 'unresolved');
  assert.equal(repeatedTime.resolutionIssue, 'ambiguous-local-time');

  const unique = createGoalContract({ objective: "2026-03-08 오전 3시 30분 '회의.txt'를 저장해",
    timeZone: 'America/New_York' });
  assert.equal(unique.times.find(item => item.kind === 'time-of-day').status, 'parsed-time');

  const korea = createGoalContract({ objective: "2026-03-08 오전 2시 '회의.txt'를 저장해",
    timeZone: 'Asia/Seoul' });
  assert.equal(korea.times.find(item => item.kind === 'time-of-day').status, 'parsed-time');

  const lordHoweGap = createGoalContract({ objective: "2026-10-04 오전 2시 15분 '회의.txt'를 저장해",
    timeZone: 'Australia/Lord_Howe' });
  const gapTime = lordHoweGap.times.find(item => item.kind === 'time-of-day');
  assert.equal(gapTime.status, 'unresolved');
  assert.equal(gapTime.resolutionIssue, 'nonexistent-local-time');

  const lordHoweFold = createGoalContract({ objective: "2026-04-05 오전 1시 45분 '회의.txt'를 저장해",
    timeZone: 'Australia/Lord_Howe' });
  const foldTime = lordHoweFold.times.find(item => item.kind === 'time-of-day');
  assert.equal(foldTime.status, 'unresolved');
  assert.equal(foldTime.resolutionIssue, 'ambiguous-local-time');

  const lordHoweUnique = createGoalContract({ objective: "2026-10-04 오전 2시 45분 '회의.txt'를 저장해",
    timeZone: 'Australia/Lord_Howe' });
  assert.equal(lordHoweUnique.times.find(item => item.kind === 'time-of-day').status, 'parsed-time');
});

test('relative weekdays resolve against the explicit local week and preserve exact source spans', () => {
  const objective = '이번 주 금요일에 초안을 저장해; 다음 주 월요일 오전 9시에 검토해; 다다음 주 일요일까지 보고해';
  const result = createGoalContract({ objective, referenceTime: '2026-09-22T02:00:00.000Z', timeZone: 'Asia/Seoul' });
  const dates = result.times.filter(item => item.kind === 'date');
  assert.deepEqual(dates.map(item => [item.text, item.date, item.status]), [
    ['이번 주 금요일', '2026-09-25', 'parsed-date'],
    ['다음 주 월요일', '2026-09-28', 'parsed-date'],
    ['다다음 주 일요일', '2026-10-11', 'parsed-date']
  ]);
  for (const item of dates) assert.equal(objective.slice(item.sourceSpan.start, item.sourceSpan.end), item.text);
  assert.deepEqual(result.times.filter(item => item.kind === 'time-of-day').map(item => item.localTime), ['09:00']);
});

test('relative weekday stays unresolved without an instant and quoted dates stay literal', () => {
  const unresolved = createGoalContract({ objective: '다음 주 금요일까지 초안을 저장해' });
  assert.deepEqual(unresolved.times.map(item => [item.text, item.date, item.status]), [['다음 주 금요일', null, 'unresolved']]);
  const literal = createGoalContract({ objective: "'다음 주 금요일'이라는 문구를 읽어" });
  assert.equal(literal.times.length, 0);
});

test('KRW amounts preserve integer minor units, comparators and original text without floating point rounding', () => {
  const result = createGoalContract({ objective: '총액 10,000원 이하를 비교해; 예산 1.25만원 미만으로 찾아; 0.5원은 쓰지 마' });
  assert.deepEqual(result.amounts.map(item => [item.minorUnits, item.comparator, item.status]), [
    [10000, 'lte', 'parsed'], [12500, 'lt', 'parsed'], [null, null, 'unresolved']
  ]);
  for (const item of result.amounts) assert.equal(result.objective.slice(item.sourceSpan.start, item.sourceSpan.end), item.text);
  assert.equal(createGoalContract({ objective: "'가격 100원'을 읽어" }).amounts.length, 0);
});

test('a correction preserves unaffected requirements and compares removed requirements with confirmed and uncertain effects', () => {
  const first = createGoalContract({ objective: '원본을 읽어; 초안을 보내; 요약본을 저장해', successCriteria: ['요약본 파일이 존재한다.'] });
  const next = reviseGoalContract(first, { objective: '원본을 읽어; 초안을 보내지 마; 요약본을 저장해', executedEffects: [
    { effectId: 'read-1', requirementId: first.requirements[0].requirementId, status: 'confirmed' },
    { effectId: 'send-1', requirementId: first.requirements[1].requirementId, status: 'unknown' }
  ] });
  assert.deepEqual(next.revisionChange.removedRequirementIds, [first.requirements[1].requirementId]);
  assert.equal(next.revisionChange.effectConflicts[0].code, 'uncertain-effect-before-revision');
  assert.equal(next.revisionChange.retainedEffects[0].effectId, 'read-1');
  assert.equal(next.revisionChange.compensationAuthorized, false);
  assert.deepEqual(next.successCriteria, first.successCriteria);
  assert.equal(first.revision, 1);
});

test('success-criterion source bindings move with retained requirements and invalidated bindings block external effects', () => {
  const plain = createGoalContract({ objective: '원본을 읽어; 초안을 저장해; 메모를 요약해' });
  const criterion = { criterionId: 'file', statement: '초안이 존재한다.', requirementId: plain.requirements[1].requirementId,
    sourceSpan: plain.requirements[1].sourceSpan, artifactRole: 'output', verificationSpec: { version: 1, kind: 'file.exists', path: 'draft.txt' } };
  const first = createGoalContract({ objective: plain.objective, successCriteria: [criterion] });
  const moved = reviseGoalContract(first, { objective: '안내문을 읽어; 원본을 읽어; 초안을 저장해; 메모를 요약해' });
  assert.deepEqual(moved.successCriteria[0].sourceSpan, moved.requirements[2].sourceSpan);
  const removed = reviseGoalContract(first, { objective: '원본을 읽어; 메모를 요약해' });
  assert.equal(removed.successCriteria[0].statement, '초안이 존재한다.');
  assert.deepEqual(removed.revisionChange.invalidatedCriterionIds, ['file']);
  assert.equal(checkGoalPlanCoverage(removed, removed.requirements.map(item => ({ requirementIds: [item.requirementId] }))).canDispatchExternalEffects, false);
});

test('structural coverage refuses omitted, unknown and executable-negative requirement links', () => {
  const contract = createGoalContract({ objective: '원본을 읽어; 초안을 저장해; 원본은 삭제하지 마' });
  const [read, save, noDelete] = contract.requirements.map(item => item.requirementId);
  assert.deepEqual(checkGoalPlanCoverage(contract, [{ requirementIds: [read] }]).missingRequirementIds, [save, noDelete]);
  assert.equal(checkGoalPlanCoverage(contract, [{ requirementIds: [read, save, noDelete] }]).canDispatchExternalEffects, false);
  assert.equal(checkGoalPlanCoverage(contract, [{ requirementIds: [read, save, 'invented'], constraintRequirementIds: [noDelete] }]).canDispatchExternalEffects, false);
  const valid = checkGoalPlanCoverage(contract, [{ requirementIds: [read, save], constraintRequirementIds: [noDelete] }]);
  assert.equal(valid.canDispatchExternalEffects, true);
  assert.equal(valid.semanticAccuracyVerified, false);
  assert.equal(valid.executionAuthorized, false);
});

test('external criterion requirement IDs are preserved and mapped only with explicit matching source provenance', () => {
  const objective = '원본을 읽어; 초안을 저장해; 메모를 요약해';
  const sourceSpan = { start: 8, end: 15 };
  assert.equal(objective.slice(sourceSpan.start, sourceSpan.end), '초안을 저장해');
  const result = createGoalContract({ objective, successCriteria: [
    { criterionId: 'total', statement: '초안이 존재한다.', requirementId: 'req_total', sourceSpan },
    { criterionId: 'missing', statement: '자료가 연결된다.', requirementId: 'req_unknown' }
  ] });
  assert.equal(result.successCriteria[0].requirementId, 'req_total');
  assert.equal(result.successCriteria[1].requirementId, 'req_unknown');
  assert.equal(result.criterionBindings[0].requirementId, result.requirements[1].requirementId);
  assert.equal(result.criterionBindings[0].basis, 'exact-source-span');
  assert.deepEqual(result.unresolvedCriterionIds, ['missing']);
  assert.equal(checkGoalPlanCoverage(result, result.requirements.map(item => ({ requirementIds: [item.requirementId] }))).canDispatchExternalEffects, false);
  const revised = reviseGoalContract(result, { objective: `안내문을 읽어; ${objective}` });
  assert.equal(revised.successCriteria[0].requirementId, 'req_total');
  assert.deepEqual(revised.successCriteria[0].sourceSpan, revised.requirements[2].sourceSpan);
  assert.equal(revised.criterionBindings[0].status, 'bound');
});

test('a conflicting criterion span cannot silently override its existing internal requirement ID', () => {
  const plain = createGoalContract({ objective: '원본을 읽어; 초안을 저장해' });
  const result = createGoalContract({ objective: plain.objective, successCriteria: [{ statement: '완료',
    requirementId: plain.requirements[0].requirementId, sourceSpan: plain.requirements[1].sourceSpan }] });
  assert.deepEqual(result.unresolvedCriterionIds, ['criterion_1']);
  assert.equal(result.criterionBindings[0].status, 'unresolved');
});

test('constraint-only coverage is supported while malformed action links are rejected', () => {
  const result = createGoalContract({ objective: '원본은 삭제하지 마' });
  assert.equal(checkGoalPlanCoverage(result, [{ constraintRequirementIds: [result.requirements[0].requirementId] }]).canDispatchExternalEffects, true);
  assert.throws(() => checkGoalPlanCoverage(result, [{ constraintRequirementIds: 'wrong' }]), { code: 'A_GOAL_PLAN_INVALID' });
});

test('invalid revisions, empty or excessive clauses and duplicate criterion IDs fail before output', () => {
  assert.throws(() => createGoalContract({ objective: '원본을 읽어', revision: 0 }), { code: 'A_GOAL_REVISION_INVALID' });
  assert.throws(() => createGoalContract({ objective: Array(65).fill('원본을 읽어').join(';') }), { code: 'A_GOAL_REQUIREMENT_LIMIT' });
  assert.throws(() => createGoalContract({ objective: '원본을 읽어', successCriteria: [{ criterionId: 'same', statement: 'A' }, { criterionId: 'same', statement: 'B' }] }), { code: 'A_GOAL_CRITERION_ID_DUPLICATE' });
});
