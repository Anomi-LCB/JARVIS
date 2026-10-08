import test, {after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { sanitizeMissionArguments } from '../packages/core/src/planning/mission-action-arguments.js';
import {
  GoalExecutivePlanner,
  buildMissionPlanningPrompt,
  extractExplicitPresentationSlideTitles,
  extractExplicitWorkbookSheetNames
} from '../packages/core/src/mission/mission-planner.js';
import { cases as complexWorkflow50Cases } from '../scripts/complex-workflow-50-cases.mjs';
import { InputSource, ModuleId } from '../packages/shared/src/types.js';
import { MissionRuntime } from '../packages/core/src/mission/mission-runtime.js';
import { IntentParser } from '../packages/core/src/intent/intent-parser.js';
import { ActionType } from '../packages/shared/src/types.js';
import { cases as complexWorkflowCases } from '../scripts/complex-workflow-50-cases.mjs';
// Use a real current MissionRuntime, including private fields and result-read
// permission guards. These parsing fixtures remain synthetic observations;
// they are not claimed as real execution/completion evidence.
const criterionFixtures=new Map();
function criterionRuntime(options={}){
 const key=JSON.stringify(options.allowedRoots??[]);
 if(!criterionFixtures.has(key)){
  const auditRoot=mkdtempSync(join(tmpdir(),'jarvis-criterion-runtime-'));
  const runtime=createAgRuntime({env:{},allowedRoots:options.allowedRoots??[auditRoot],auditRoot,workerDaemonEnabled:false});
  criterionFixtures.set(key,{runtime,auditRoot});
 }
 return criterionFixtures.get(key).runtime.missionRuntime;
}
after(()=>{for(const {runtime,auditRoot} of criterionFixtures.values()){runtime.coreFacade.cognition.close();rmSync(auditRoot,{recursive:true,force:true});}});


test('workbook PDF request survives Mission argument sanitization without executable or policy fields',()=>{
 const args=sanitizeMissionArguments('excel.createWorkbook',{outputPath:'report.xlsx',renderPdf:true,pdfOutputPath:'report.pdf',
   rendererCommand:'untrusted',capabilityToken:'untrusted',signal:{aborted:false}});
 assert.deepEqual(args,{outputPath:'report.xlsx',renderPdf:true,pdfOutputPath:'report.pdf'});
});

test('Saving a named JSON file does not register a macro', () => {
  const parser = new IntentParser();
  assert.equal(parser.parse('정렬한 결과를 open-tasks.json으로 저장').actionType, ActionType.CREATE_FILE);
  assert.equal(parser.parse('PowerShell 명령 실행: 결과를 open-tasks.json으로 저장').actionType, ActionType.SHELL_EXECUTE);
  assert.equal(parser.parse('가나다순 고유 이름 목록을 unique.txt에 한 줄씩 저장').actionType, ActionType.CREATE_FILE);
  assert.equal(parser.parse('검색 결과를 found.txt에 기록해줘').actionType, ActionType.CREATE_FILE);
  assert.equal(parser.parse('작업 폴더 파일 목록 보여줘').actionType, ActionType.LIST_FILES);
  assert.equal(parser.parse('checklist.md 텍스트 파일을 만들어줘').actionType, ActionType.CREATE_FILE);
  assert.equal(parser.parse('MDN 공식 문서를 웹에서 검색해줘').actionType, ActionType.BROWSER_SEARCH);
  assert.equal(parser.parse('작업 폴더에서 회의 문서를 찾아줘').actionType, ActionType.SEARCH_FILES);
  assert.equal(parser.parse('plan.xlsx 엑셀 파일을 만들어줘. 일정 시트에 준비/실행 행을 넣어줘.').actionType, ActionType.CREATE_FILE);
  assert.equal(parser.parse('plan.xlsx 파일을 열어줘').actionType, ActionType.SHELL_EXECUTE);
});

test('Completion requires produced outputs while excluding explicit inputs and exclusions', () => {
  const check = (statement, names) => criterionRuntime().verifyCriterionEvidence( {
    observations:[{actionId:'a',artifacts:names.map(name=>({name})),verification:{status:'passed'}}]
  }, {statement}, ['a']);
  for (const [statement, names] of [
    ['sales.csv를 읽고 총액을 sales-summary.txt에 정리해줘', ['sales-summary.txt']],
    ['sales.csv를 UTF-8로 읽고 총액을 sales-summary.txt에 정리해줘', ['sales-summary.txt']],
    ['tasks.json에서 미완료 항목을 open-tasks.json으로 저장해줘', ['open-tasks.json']],
    ['attendees.txt의 중복 이름을 제거해 unique.txt에 저장해줘', ['unique.txt']],
    ['morning.csv와 evening.csv를 읽어 totals.csv로 저장해줘', ['totals.csv']],
    ['warehouse-a.csv와 warehouse-b.csv를 모두 읽고 inventory.xlsx를 만들어줘', ['inventory.xlsx']],
    ['study-a.txt, study-b.txt, study-c.txt를 찾아 모두 읽고 evidence.xlsx를 만들어줘', ['evidence.xlsx']],
    ['alpha.txt와 beta.txt를 각각 읽고 result.md를 만들어줘', ['result.md']],
    ['alpha.txt와 beta.txt를 전부 함께 먼저 읽고 result.md를 만들어줘', ['result.md']],
    ['ops/events.log와 ops/owners.csv를 찾아 모두 읽고 report.md를 만들어줘', ['report.md']],
    ['controls.csv와 존재하는 증거 파일 세 개를 모두 읽고 matrix.xlsx를 만들어줘', ['matrix.xlsx']],
    ['archive/report.txt는 보존하고 collision-review.md를 만들어줘', ['collision-review.md']],
    ['파일을 found.txt에 기록해줘. other.txt는 결과 목록에 넣지 마.', ['found.txt']]
  ]) {
    const evidence = check(statement, names);
    assert.equal(evidence.checks.find(item => item.checkId === 'named_artifacts_match')?.passed, true, statement);
    // This test proves input/output roles only. Arithmetic and content claims
    // require a separate typed verifier; artifact names cannot prove them.
    if (/총액/u.test(statement)) assert.equal(evidence.status, 'unverified', statement);
  }
  assert.equal(check('a.txt와 b.txt를 만들어줘',['a.txt']).passed,false);
  assert.equal(check('a.txt와 b.txt를 만들어줘',['b.txt']).passed,false);
  assert.equal(check('scores.html을 만들어줘',[]).passed,false);
  assert.equal(check('notice.txt의 행사일을 변경해줘',[]).passed,false);
  const listingOnly = criterionRuntime().verifyCriterionEvidence( {observations:[{actionId:'a',data:{items:[{name:'a.txt'}]}}]}, {statement:'a.txt를 만들어줘'}, ['a']);
  assert.equal(listingOnly.passed,false);
});

test('A verified exact read proves a named file-existence criterion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-read-exists-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'archive'));
  const path = join(root, 'archive', 'report.txt');
  await writeFile(path, '승인 7건');
  const actionId = 'read';
  const mission = {
    waves: [{ actions: [{ actionId, expectedToolName: 'filesystem.readText', arguments: { path: join(root, 'archive', 'report.txt') } }] }],
    observations: [{ actionId, toolName: 'filesystem.readText', outcome: 'success', data: { stdoutPreview: '승인 7건',
      fileEvidence: { name: 'report.txt', relativePath: 'archive/report.txt', rootIndex: 0, outsideAllowedRoots: false,
        pathHash: createHash('sha256').update(path).digest('hex') } }, verification: { status: 'passed' } }]
  };
  const result = criterionRuntime({allowedRoots:[root]}).verifyCriterionEvidence( mission, { statement: 'archive/report.txt 파일이 실제로 존재하고 text 형식을 통과한다.' }, [actionId]);
  assert.equal(result.status, 'unverified');
  assert.equal(result.checks.find(check => check.checkId === 'named_artifacts_match').passed, true);
  const existence = criterionRuntime({allowedRoots:[root]}).verifyCriterionEvidence( mission,
    { statement: 'archive/report.txt 파일이 실제로 존재한다.' }, [actionId]);
  assert.equal(existence.passed, true);
  const read = criterionRuntime({allowedRoots:[root]}).verifyCriterionEvidence( mission,
    { statement: 'archive/report.txt 파일을 읽는다.' }, [actionId]);
  assert.equal(read.passed, true);
});

test('Completion input-role parsing excludes every read-only corpus input that is not also an output', () => {
  for (const item of complexWorkflowCases) {
    const outputNames = new Set((item.expected?.files ?? [])
      .filter((file) => file.absent !== true)
      .map((file) => basename(file.path).toLowerCase()));
    const observations = [{
      actionId: 'a',
      artifacts: [...outputNames].map((name) => ({ name })),
      verification: { status: 'passed' }
    }];
    const evidence = criterionRuntime().verifyCriterionEvidence(

      { observations },
      { statement: item.command },
      ['a']
    );
    const namedCheck = evidence.checks.find((check) => check.checkId === 'named_artifacts_match');
    const readOnlyInputs = Object.keys(item.inputs ?? {})
      .map((path) => basename(path).toLowerCase())
      .filter((name) => !outputNames.has(name));
    const misclassified = (namedCheck?.expected ?? []).filter((name) => readOnlyInputs.includes(name));
    assert.deepEqual(misclassified, [], `case ${item.id}: ${misclassified.join(', ')}`);
  }
});

test('Completion requires email commit evidence only for corpus cases that request an actual send', () => {
  for (const item of complexWorkflowCases) {
    const artifactNames = (item.expected?.files ?? [])
      .filter((file) => file.absent !== true)
      .map((file) => basename(file.path).toLowerCase());
    const result = criterionRuntime().verifyCriterionEvidence(

      {
        observations: [{
          actionId: 'a',
          artifacts: artifactNames.map((name) => ({ name })),
          verification: { status: 'passed' }
        }]
      },
      { statement: item.command },
      ['a']
    );
    const emailCheck = result.checks.find((check) => check.checkId === 'external_commit_evidence_present');
    assert.equal(Boolean(emailCheck), Boolean(item.expected?.email), `case ${item.id}`);
  }

  const metric = criterionRuntime().verifyCriterionEvidence(

    { observations: [] },
    { statement: '이메일 클릭률과 전환율을 분석하고 날짜와 이메일 주소를 확인한다.' },
    []
  );
  assert.equal(metric.checks.some((check) => check.checkId === 'external_commit_evidence_present'), false);

  for (const statement of [
    '보고서를 내 구글 메일로 보내줘.',
    '보고서를 메일로 전송한다.',
    '내 Gmail 전송이 SMTP 공급자에서 검증된다.',
    'Send the verified report by email.'
  ]) {
    const send = criterionRuntime().verifyCriterionEvidence( { observations: [] }, { statement }, []);
    assert.equal(send.checks.some((check) => check.checkId === 'external_commit_evidence_present'), true, statement);
  }
});

test('Negative artifact criteria require exact, ordered absence evidence', () => {
  const root = join(tmpdir(), 'jarvis-absence-evidence');
  const target = join(root, 'inbox', 'report.txt');
  const moved = join(root, 'archive', 'report-incoming.txt');
  const action = (actionId, expectedToolName, args) => ({ actionId, expectedToolName, arguments: args, status: 'succeeded' });
  const observation = (actionId, toolName, data = {}, artifacts = []) => ({
    actionId, toolName, data, artifacts, outcome: 'success', verification: { status: 'passed' }
  });
  const criterion = { statement: 'inbox/report.txt 파일은 필수 입력을 받기 전까지 생성되지 않는다.' };
  const verify = (waves, observations, ids) => criterionRuntime({allowedRoots:[root]}).verifyCriterionEvidence(
 { waves, observations }, criterion, ids
  );

  const move = action('move', 'filesystem.moveFiles', { moves: [{ from: target, to: moved }] });
  const lateList = action('late-list', 'filesystem.listFiles', { directory: join(root, 'inbox'), maxItems: 20 });
  const c27 = verify(
    [{ actions: [move] }, { actions: [lateList] }],
    [observation('move', 'filesystem.moveFiles', {}, [{ name: 'report-incoming.txt', relativePath: 'archive/report-incoming.txt' }]), observation('late-list', 'filesystem.listFiles', { items: [] })],
    ['late-list']
  );
  assert.equal(c27.status, 'unverified'); // Present absence cannot prove a future conditional promise.
  assert.equal(c27.checks.some((check) => check.checkId === 'named_artifacts_match'), false);
  assert.equal(c27.checks.find((check) => check.checkId === 'named_artifact_absence_verified')?.passed, true);

  const earlyList = action('early-list', 'filesystem.listFiles', { directory: join(root, 'inbox'), maxItems: 20 });
  const create = action('create', 'filesystem.createTextFile', { path: target, content: 'later' });
  const early = verify(
    [{ actions: [earlyList] }, { actions: [create] }],
    [observation('early-list', 'filesystem.listFiles', { items: [] }), observation('create', 'filesystem.createTextFile', {}, [{ name: 'report.txt', relativePath: 'inbox/report.txt' }])],
    ['early-list']
  );
  assert.equal(early.passed, false);
  assert.ok(early.reasons.includes('named_artifact_absence_verified'));

  const unrelatedList = action('other-list', 'filesystem.listFiles', { directory: join(root, 'archive'), maxItems: 20 });
  assert.equal(verify([{ actions: [unrelatedList] }], [observation('other-list', 'filesystem.listFiles', { items: [] })], ['other-list']).passed, false);
});

test('Expected-stop missing paths accept only an exact unfiltered workspace search', () => {
  const root = join(tmpdir(), 'jarvis-missing-path-evidence');
  const criterion = { statement: 'transactions-september.csv 경로가 실제로 없음을 확인하고 존재하는 것처럼 추정하지 않는다.' };
  const verify = (query, directory = root) => {
    const action = { actionId: 'search', expectedToolName: 'filesystem.searchFiles', arguments: { query, directory, scope: 'workspace', maxResults: 5 }, status: 'succeeded' };
    const observation = { actionId: 'search', toolName: 'filesystem.searchFiles', outcome: 'success', data: { matches: [] }, verification: { status: 'passed' } };
    return criterionRuntime({allowedRoots:[root]}).verifyCriterionEvidence( { waves: [{ actions: [action] }], observations: [observation] }, criterion, ['search']);
  };
  assert.equal(verify('transactions-september.csv').status, 'unverified');
  assert.equal(verify('transactions-september.csv').checks.find(check => check.checkId === 'named_artifact_absence_verified').passed, true);
  assert.equal(verify('transactions.csv').passed, false);
  assert.equal(verify('transactions-september.csv', join(root, 'unrelated')).passed, false);
});

test('Source provenance requires live web capture, not synthetic previews', () => {
  const observation={actionId:'a',toolName:'browser.search',data:{searchResults:[{url:'https://developer.mozilla.org/'}],webProvenance:{live:false,capturedAt:'2026-09-03T00:00:00Z',navigationStatus:200}}};
  const check=()=>criterionRuntime().verifyCriterionEvidence( {observations:[observation]}, {statement:'공식 출처 확인'}, ['a']);
  observation.verification={status:'passed'};
  assert.equal(check().passed,false);
  observation.data.webProvenance.live=true;
  assert.equal(check().passed,true);
  observation.data.webProvenance.capturedAt=null;
  assert.equal(check().passed,false);
  observation.data.webProvenance.capturedAt='2026-09-03T00:00:00Z';
  observation.data.searchResults=[{url:'https://www.bing.com/search?q=MDN'}];
  assert.equal(check().passed,false);
  const twoSources=()=>criterionRuntime().verifyCriterionEvidence( {observations:[observation]}, {statement:'MDN 공식 출처 URL 두 개'}, ['a']);
  observation.data.searchResults=[{url:'https://developer.mozilla.org/all'}];
  assert.equal(twoSources().passed,false);
  observation.data.searchResults.push({url:'https://developer.mozilla.org/allSettled'});
  assert.equal(twoSources().passed,true);
});

test('Move arguments retain explicit source and destination pairs', () => {
  assert.deepEqual(sanitizeMissionArguments('filesystem.moveFiles',{moves:[{from:'inbox/report.txt',to:'archive/report-new.txt'}],policy:'allow'}),{moves:[{from:'inbox/report.txt',to:'archive/report-new.txt'}]});
});

test('Failed postconditions reach the planner instead of an adapter success message', () => {
  const error=MissionRuntime.prototype.errorFromRun.call({}, {execution:{executionResult:{summary:'명령을 실행했어요.'}},executionVerification:{status:'failed',checks:[{checkId:'non_rollback_postcondition_verified',status:'failed'}]}},{});
  assert.equal(error.code,'A_MISSION_EXECUTION_VERIFICATION_FAILED');
  assert.match(error.message,/non_rollback_postcondition_verified/);
  assert.doesNotMatch(error.message,/명령을 실행했어요/);
});

test('A missing-input notice cannot masquerade as a completed calculation', () => {
  const mission={observations:[{actionId:'a',artifacts:[{name:'result.txt'}],data:{items:[]},verification:{status:'passed'}}]};
  const result=criterionRuntime().verifyCriterionEvidence(mission,{statement:'input.csv를 근거로 총액을 result.txt로 만들어줘. 원본이 없으면 추정하지 말고 알려줘.'},['a']);
  assert.equal(result.passed,false);
  assert.ok(result.reasons.includes('required_input_evidence_present'));
});

test('Internal mission arguments retain exact filename and body through real file execution', async () => {
  const root = await mkdtemp(join(tmpdir(),'jarvis-arguments-'));
  const runtime = createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false});
  const path = join(root,'alpha.txt');
  const task = runtime.coreFacade.createMissionActionTask('alpha.txt 파일을 만들고 내용으로 "프로젝트 시작 승인 완료"를 써줘',{
    expectedToolName:'filesystem.createTextFile',preparedArguments:{path,content:'프로젝트 시작 승인 완료'},
    source:InputSource.TRIGGER,sourceModule:ModuleId.CORE,deviceId:'mission_executive'
  });
  assert.equal(task.plan.action.arguments.path,path);
  assert.equal(task.plan.action.arguments.content,'프로젝트 시작 승인 완료');
  const result=await runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(result.success,true);
  assert.equal(await readFile(path,'utf8'),'프로젝트 시작 승인 완료');
});

test('A prepared mission workbook action is executed once even with commas in its description', async () => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-atomic-workbook-'));
  const runtime=createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false});
  const task=runtime.coreFacade.createMissionActionTask('budget.xlsx 파일을 만들고, 예산 시트에 데이터를 입력하고, 합계 행을 작성해줘', {
    expectedToolName:'excel.createWorkbook',preparedArguments:{outputPath:join(root,'budget.xlsx'),sheetName:'예산',columns:['금액'],rows:[[160000]]},
    source:InputSource.TRIGGER,sourceModule:ModuleId.CORE,deviceId:'mission_executive'
  });
  assert.equal(task.plan.planGraph.nodes.filter(node=>node.nodeId.startsWith('action_')).length,1);
  const run=await runtime.orchestrationWorker.runTask(task.taskId);
  assert.equal(run.success,true);
});

test('Public task options cannot inject mission arguments or forge a trusted mission route', async () => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-arguments-guard-'));
  const runtime=createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false});
  const preparedArguments={path:join(root,'injected.txt'),content:'injected'};
  const task=runtime.coreFacade.createTask('alpha.txt 파일 만들어줘',{preparedArguments,preparedMissionArguments:preparedArguments});
  assert.notEqual(task.plan.action.arguments.path,preparedArguments.path);
  const spoofed=runtime.coreFacade.createTask('작업 폴더 파일 목록 보여줘',{
    expectedToolName:'filesystem.createTextFile',preparedArguments,
    source:InputSource.TRIGGER,sourceModule:ModuleId.CORE,deviceId:'mission_executive'});
  assert.equal(spoofed.plan.action.toolName,'filesystem.listFiles');
  assert.equal(spoofed.plan.action.arguments.content,undefined);
});

test('Trusted mission route uses the registered expected tool and sanitized prepared arguments', () => {
  const root=join(tmpdir(),'jarvis-trusted-browser-route');
  const runtime=createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false});
  const query='https://docs.python.org/3/library/asyncio-task.html#asyncio.timeout';
  const task=runtime.coreFacade.createMissionActionTask('Python 공식 asyncio timeout 및 TimeoutError 문서 페이지 내용을 읽어줘',{
    expectedToolName:'browser.search',
    preparedArguments:{query,maxResults:5,toolName:'filesystem.createTextFile',capabilityToken:'forbidden'},
    source:InputSource.TRIGGER,sourceModule:ModuleId.CORE,deviceId:'mission_executive'
  });
  assert.equal(task.plan.action.actionType,ActionType.BROWSER_SEARCH);
  assert.equal(task.plan.action.toolName,'browser.search');
  assert.equal(task.plan.action.arguments.query,query);
  assert.equal(task.plan.action.arguments.maxResults,5);
  assert.equal(task.plan.action.arguments.toolName,undefined);
  assert.equal(task.plan.action.arguments.capabilityToken,undefined);
});

test('Arguments never carry model-supplied authorization or capabilities', () => {
  assert.deepEqual(sanitizeMissionArguments('filesystem.createTextFile',{path:'x',content:'y',expectedSha256:'a'.repeat(64),policy:{decision:'allow'},toolName:'shell.execute',capabilityToken:'secret'}),{path:'x',content:'y',expectedSha256:'a'.repeat(64)});
  assert.deepEqual(sanitizeMissionArguments('email.send',{
    to:'external@example.com',subject:'bounded',policy:{decision:'allow'},toolName:'shell.execute',capabilityToken:'secret'
  }),{to:'external@example.com',subject:'bounded'});
});

test('Planner keeps bounded observation content and argument changes alter the plan fingerprint', () => {
  const context={mission:{objective:'요약',successCriteria:[],constraints:[],budgets:{}},capabilities:[{toolName:'filesystem.createTextFile'}],observations:[{data:{stdoutPreview:'실제 입력 내용',searchResults:[{title:'공식',url:'https://example.com',snippet:'출처 설명'}]}}]};
  const prompt=buildMissionPlanningPrompt(context);
  assert.match(prompt,/실제 입력 내용/);assert.match(prompt,/출처 설명/);
  const planner=new GoalExecutivePlanner();
  const payload={decision:'continue',actions:[{id:'a',command:'alpha.txt 파일 만들기',expectedToolName:'filesystem.createTextFile',arguments:{path:'alpha.txt',content:'A'}}]};
  const a=planner.sanitizePlan(payload,context);
  payload.actions[0].arguments.content='B';
  const b=planner.sanitizePlan(payload,context);
  assert.notEqual(a.fingerprint,b.fingerprint);
});

test('Planner rejects publisher homepages and replans a news report with exact observed article URLs', async () => {
  const objective = '다음 작업을 순서대로 완료해줘. 1) 오늘 뉴스 기사 세 건을 골라. 2) 각 기사의 실제로 읽은 출처 URL을 hot-news-report.md에 저장해. 3) URL 세 개를 확인해.';
  const observations = [1, 2, 3].map((index) => ({
    actionId: `news_${index}`,
    outcome: 'success',
    toolName: 'news.fetchHeadlines',
    verification: { status: 'passed' },
    data: {
      news: {
        live: true,
        replay: false,
        fixture: false,
        fetched: true,
        sourceUrl: `https://news.google.com/rss?category=${index}`,
        items: [{
          title: `기사 ${index}`,
          url: `https://news.google.com/rss/articles/item-${index}?oc=5`,
          publishedAt: `2026-09-03T0${index}:00:00.000Z`,
          source: `매체 ${index}`,
          sourceUrl: `https://publisher-${index}.example/`
        }]
      }
    }
  }));
  const context = {
    mission: {
      objective,
      successCriteria: [],
      constraints: [],
      remainingBudget: { plannerCalls: 2, activeRuntimeMs: 20_000 }
    },
    capabilities: [{ toolName: 'filesystem.createTextFile' }],
    observations
  };
  const payload = (content) => ({
    decision: 'continue',
    actions: [{
      id: 'report',
      command: 'hot-news-report.md 텍스트 파일을 만들어줘',
      expectedToolName: 'filesystem.createTextFile',
      arguments: { path: 'C:\\workspace\\hot-news-report.md', content }
    }],
    criteriaAssessment: []
  });
  const planner = new GoalExecutivePlanner();
  const homepageContent = observations.map((item) => item.data.news.items[0].sourceUrl).join('\n');
  assert.throws(
    () => planner.sanitizePlan(payload(homepageContent), context),
    (error) => error?.code === 'A_MISSION_NEWS_ARTICLE_CITATION_MISMATCH'
      && error?.retryable === true
      && error?.expectedMinimum === 3
      && error?.citedArticleCount === 0
  );
  const feedContent = observations.map((item) => item.data.news.sourceUrl).join('\n');
  assert.throws(
    () => planner.sanitizePlan(payload(feedContent), context),
    (error) => error?.code === 'A_MISSION_NEWS_ARTICLE_CITATION_MISMATCH'
      && error?.citedArticleCount === 0
  );
  const articleContent = observations.map((item) => item.data.news.items[0].url).join('\n');
  assert.equal(planner.sanitizePlan(payload(articleContent), context).actions.length, 1);

  const prompts = [];
  const retryingPlanner = new GoalExecutivePlanner({
    runner: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify(payload(prompts.length === 1 ? homepageContent : articleContent));
    },
    timeoutMs: 10_000,
    retryTimeoutMs: 5_000,
    maxTransientRetries: 1,
    runtimeReserveMs: 0
  });
  const planned = await retryingPlanner.planNextWave(context);
  assert.equal(planned.decision, 'continue');
  assert.equal(planned.planning.attemptCount, 2);
  assert.equal(planned.planning.transientFailures[0].code, 'A_MISSION_NEWS_ARTICLE_CITATION_MISMATCH');
  assert.match(prompts[1], /feedUrl과 publisherHomepageUrl은 인용하지 마세요/);
});

test('Planner does not apply the exact-news-URL guard to unrelated text artifacts', () => {
  const planner = new GoalExecutivePlanner();
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'notes',
      command: 'notes.txt 텍스트 파일을 만들어줘',
      expectedToolName: 'filesystem.createTextFile',
      arguments: { path: 'C:\\workspace\\notes.txt', content: '일반 메모' }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'filesystem.createTextFile' }],
    mission: {
      objective: '오늘 뉴스 기사 세 건의 실제로 읽은 출처 URL을 hot-news-report.md에 저장한 뒤 notes.txt에 작업 메모를 남겨.',
      successCriteria: []
    },
    observations: []
  });
  assert.equal(plan.actions.length, 1);
});

test('Planner restores exact explicit workbook sheet names from the mission objective', () => {
  const planner = new GoalExecutivePlanner();
  const objective = '다음 작업을 순서대로 완료해줘. 1) sales.csv를 읽어. 2) 행별 계산과 월별 요약을 두 시트로 나눈 sales-analysis.xlsx를 만들고 총매출을 포함해.';
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'sales-analysis.xlsx 엑셀 파일을 행별계산과 월별요약 두 시트로 만들어줘',
      expectedToolName: 'excel.createWorkbook',
      arguments: {
        outputPath: 'C:\\workspace\\sales-analysis.xlsx',
        sheets: [
          { sheetName: '행별계산', columns: ['월'], rows: [['2026-07']] },
          { sheetName: '월별요약', columns: ['월'], rows: [['2026-07']] }
        ]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'excel.createWorkbook' }],
    mission: { objective, successCriteria: [] }
  });
  assert.deepEqual(plan.actions[0].arguments.sheets.map((sheet) => sheet.sheetName), ['행별 계산', '월별 요약']);
});

test('Planner restores C15 exact names when the model adds a descriptive suffix', () => {
  const planner = new GoalExecutivePlanner();
  const objective = '학생별·과목별 결과를 learning-analysis.xlsx의 두 시트에 작성해.';
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'learning-analysis.xlsx를 학생별평균과 과목별평균 시트로 만들어줘',
      expectedToolName: 'excel.createWorkbook',
      arguments: {
        outputPath: 'C:\\workspace\\learning-analysis.xlsx',
        sheets: [
          { sheetName: '학생별평균', columns: ['학생'], rows: [['김하늘']] },
          { sheetName: '과목별평균', columns: ['과목'], rows: [['수학']] }
        ]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'excel.createWorkbook' }],
    mission: { objective, successCriteria: [] }
  });
  assert.deepEqual(plan.actions[0].arguments.sheets.map((sheet) => sheet.sheetName), ['학생별', '과목별']);
});

test('All explicit multi-sheet commands in the 50-case corpus are statically classified', () => {
  const explicitWorkbookCases = complexWorkflow50Cases.flatMap((missionCase) => (
    (missionCase.expected?.files ?? [])
      .filter((file) => file.type === 'xlsx' && Array.isArray(file.sheets) && file.sheets.length > 1)
      .map((file) => ({ missionCase, file }))
  ));
  assert.ok(explicitWorkbookCases.length >= 20);
  for (const { missionCase, file } of explicitWorkbookCases) {
    assert.deepEqual(
      extractExplicitWorkbookSheetNames(missionCase.command, `C:\\workspace\\${file.path}`),
      file.sheets,
      `C${missionCase.id} ${file.path}`
    );
  }
});

test('Planner does not rewrite ordinary workbook sheet names without an explicit name list', () => {
  const planner = new GoalExecutivePlanner();
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'sales-analysis.xlsx 엑셀 파일을 만들어줘',
      expectedToolName: 'excel.createWorkbook',
      arguments: {
        outputPath: 'C:\\workspace\\sales-analysis.xlsx',
        sheets: [
          { sheetName: 'Raw Data', columns: ['month'], rows: [['2026-07']] },
          { sheetName: 'Monthly Summary', columns: ['month'], rows: [['2026-07']] }
        ]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'excel.createWorkbook' }],
    mission: { objective: 'sales-analysis.xlsx를 만들고 데이터를 두 시트로 정리해.', successCriteria: [] }
  });
  assert.deepEqual(plan.actions[0].arguments.sheets.map((sheet) => sheet.sheetName), ['Raw Data', 'Monthly Summary']);
});

test('Planner enforces exact explicit workbook sheet names over model substitutions', () => {
  const planner = new GoalExecutivePlanner();
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'sales-analysis.xlsx 엑셀 파일을 만들어줘',
      expectedToolName: 'excel.createWorkbook',
      arguments: {
        outputPath: 'C:\\workspace\\sales-analysis.xlsx',
        sheets: [
          { sheetName: '원본', columns: ['월'], rows: [] },
          { sheetName: '대시보드', columns: ['월'], rows: [] }
        ]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'excel.createWorkbook' }],
    mission: {
      objective: '행별 계산과 월별 요약을 두 시트로 나눈 sales-analysis.xlsx를 만들어.',
      successCriteria: []
    }
  });
  assert.deepEqual(plan.actions[0].arguments.sheets.map((sheet) => sheet.sheetName), ['행별 계산', '월별 요약']);
});

test('Planner rejects an explicit workbook sheet-count mismatch so it can replan', () => {
  const planner = new GoalExecutivePlanner();
  assert.throws(() => planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'sales-analysis.xlsx 엑셀 파일을 만들어줘',
      expectedToolName: 'excel.createWorkbook',
      arguments: {
        outputPath: 'C:\\workspace\\sales-analysis.xlsx',
        sheets: [{ sheetName: '행별 계산', columns: ['월'], rows: [] }]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'excel.createWorkbook' }],
    mission: {
      objective: '행별 계산과 월별 요약을 두 시트로 나눈 sales-analysis.xlsx를 만들어.',
      successCriteria: []
    }
  }), (error) => error?.code === 'A_MISSION_EXPLICIT_WORKBOOK_SHEET_NAME_MISMATCH');
});

test('Planner restores exact explicit slide titles and order from the mission objective', () => {
  const planner = new GoalExecutivePlanner();
  const objective = '다음 작업을 순서대로 완료해줘. 1) faq.txt를 읽어. 2) 상담원 교육용 support-training.pptx를 개요·비밀번호·결제·계정삭제·상향체계 순서의 정확히 5장으로 만들어.';
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'support-training.pptx 프레젠테이션 파일을 만들어줘',
      expectedToolName: 'powerpoint.create',
      arguments: {
        path: 'C:\\workspace\\support-training.pptx',
        deckTitle: '상담원 교육',
        slides: [
          { title: '개요', bullets: ['overview'] },
          { title: '결제 및 영수증', bullets: ['payment'] },
          { title: '비밀번호 재설정', bullets: ['password'] },
          { title: '계정 삭제', bullets: ['account'] },
          { title: '상향 체계', bullets: ['escalation'] }
        ]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'powerpoint.create' }],
    mission: { objective, successCriteria: [] }
  });
  assert.deepEqual(
    plan.actions[0].arguments.slides.map((slide) => slide.title),
    ['개요', '비밀번호', '결제', '계정삭제', '상향체계']
  );
  assert.deepEqual(
    plan.actions[0].arguments.slides.map((slide) => slide.bullets[0]),
    ['overview', 'password', 'payment', 'account', 'escalation']
  );
});

test('Explicit slide-title extraction covers the exact list forms used by the complex workflows', () => {
  const expected = new Map([
    ['03', ['개요', '취소', '타임아웃', '정리', '체크리스트']],
    ['05', ['실행 전', '실행', '판정', '오류 대응']],
    ['36', ['환영', '가치', '보안', '일정', '문의']],
    ['39', ['개요', '비밀번호', '결제', '계정삭제', '상향체계']]
  ]);
  for (const [caseId, titles] of expected) {
    const missionCase = complexWorkflow50Cases.find((item) => item.id === caseId);
    const presentation = missionCase.expected.files.find((file) => file.type === 'pptx');
    assert.deepEqual(
      extractExplicitPresentationSlideTitles(missionCase.command, `C:\\workspace\\${presentation.path}`),
      titles,
      `C${caseId} ${presentation.path}`
    );
  }
});

test('Planner leaves presentation titles alone when the requested count does not enumerate every title', () => {
  const planner = new GoalExecutivePlanner();
  const objective = '제목·목표·세 전략축·위험과 다음 행동을 순서로 strategy-board.pptx를 정확히 7장으로 만들어.';
  const slides = Array.from({ length: 7 }, (_, index) => ({ title: `모델 제목 ${index + 1}`, bullets: [] }));
  const plan = planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'strategy-board.pptx를 만들어줘',
      expectedToolName: 'powerpoint.create',
      arguments: { path: 'C:\\workspace\\strategy-board.pptx', slides }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'powerpoint.create' }],
    mission: { objective, successCriteria: [] }
  });
  assert.equal(extractExplicitPresentationSlideTitles(objective, 'strategy-board.pptx'), null);
  assert.deepEqual(plan.actions[0].arguments.slides, slides);
});

test('Planner rejects an explicit slide-title count mismatch so it can replan', () => {
  const planner = new GoalExecutivePlanner();
  assert.throws(() => planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'support-training.pptx를 만들어줘',
      expectedToolName: 'powerpoint.create',
      arguments: {
        path: 'C:\\workspace\\support-training.pptx',
        slides: [{ title: '개요', bullets: [] }]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'powerpoint.create' }],
    mission: {
      objective: 'support-training.pptx를 개요·비밀번호·결제·계정삭제·상향체계 순서의 정확히 5장으로 만들어.',
      successCriteria: []
    }
  }), (error) => error?.code === 'A_MISSION_EXPLICIT_PRESENTATION_SLIDE_COUNT_MISMATCH');
});

test('Planner replans when explicit slide titles cannot be matched to their generated bodies', () => {
  const planner = new GoalExecutivePlanner();
  assert.throws(() => planner.sanitizePlan({
    decision: 'continue',
    actions: [{
      id: 'a1',
      command: 'support-training.pptx를 만들어줘',
      expectedToolName: 'powerpoint.create',
      arguments: {
        path: 'C:\\workspace\\support-training.pptx',
        slides: [
          { title: '첫 번째 교육', bullets: ['어느 항목인지 식별할 수 없는 본문'] },
          { title: '두 번째 교육', bullets: ['어느 항목인지 식별할 수 없는 본문'] },
          { title: '세 번째 교육', bullets: ['어느 항목인지 식별할 수 없는 본문'] },
          { title: '네 번째 교육', bullets: ['어느 항목인지 식별할 수 없는 본문'] },
          { title: '다섯 번째 교육', bullets: ['어느 항목인지 식별할 수 없는 본문'] }
        ]
      }
    }],
    criteriaAssessment: []
  }, {
    capabilities: [{ toolName: 'powerpoint.create' }],
    mission: {
      objective: 'support-training.pptx를 개요·비밀번호·결제·계정삭제·상향체계 순서의 정확히 5장으로 만들어.',
      successCriteria: []
    }
  }), (error) => error?.code === 'A_MISSION_EXPLICIT_PRESENTATION_SLIDE_ALIGNMENT_MISMATCH');
});

test('Structured mission path still passes the allowed-root enforcement', async () => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-arguments-path-'));
  const runtime=createAgRuntime({env:{},allowedRoots:[root],auditRoot:join(root,'audit'),workerDaemonEnabled:false});
  const task=runtime.coreFacade.createMissionActionTask('outside.txt 파일 만들어줘',{
    expectedToolName:'filesystem.createTextFile',preparedArguments:{path:join(root,'..','outside.txt'),content:'must not write'},
    source:InputSource.TRIGGER,sourceModule:ModuleId.CORE,deviceId:'mission_executive'});
  const result=await runtime.orchestrationWorker.runTask(task.taskId);
  assert.notEqual(result.success,true);
});
