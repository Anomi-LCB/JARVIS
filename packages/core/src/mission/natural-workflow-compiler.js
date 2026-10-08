import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { WORKFLOW_SCHEMA_VERSION } from './workflow-ir.js';
import { createGoalContract, tokenizeGoalSource } from './goal-contract.js';

export const NATURAL_WORKFLOW_COMPILER_VERSION = 'natural-workflow-ko-v12';
export const NATURAL_WORKFLOW_CACHE_LIMIT = 128;
const cache = new Map();
const Q = '(§\\d+§)';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const aggregate = { 합계: 'sum', 평균: 'avg', 최솟값: 'min', 최댓값: 'max' };
const order = { 오름차순: 'asc', 내림차순: 'desc' };
const quoteToken = /^§(\d+)§$/u;

/** Pure compilation: no filesystem reads, writes, data cache, model calls or fixture awareness. */
export function compileNaturalWorkflowObjective(objective, { workspaceRoot } = {}) {
  if (typeof objective !== 'string') return { status: 'absent', compilerVersion: NATURAL_WORKFLOW_COMPILER_VERSION };
  const text = objective.trim();
  if (!looksLikeWorkflow(text)) return { status: 'absent', compilerVersion: NATURAL_WORKFLOW_COMPILER_VERSION };
  if (!text || text.length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f§]/u.test(text)) return blocked('NATURAL_WORKFLOW_OBJECTIVE_INVALID');
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim() || /[\u0000-\u001f\u007f]/u.test(workspaceRoot)) return blocked('NATURAL_WORKFLOW_ROOT_REQUIRED');
  const root = resolve(workspaceRoot);
  const key = digest(`${NATURAL_WORKFLOW_COMPILER_VERSION}\0${root}\0${objective}`);
  // Cache revisions may change when grammar grows. Existing persisted workflow
  // identities must not change merely because a new grammar was added.
  const workflowIdentity = digest(`natural-workflow-ko-v9\0${root}\0${objective}`);
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return { ...structuredClone(hit), cacheHit: true };
  }
  let currentClause = null;
  try {
    const { clauses, strings, sourceSpans } = tokenize(objective);
    const goalContract = createGoalContract({ objective });
    if (clauses.length < 2 && !theologyReviewMatch(normalizeClause(clauses[0]??''))&&!safetySimulationMatch(normalizeClause(clauses[0]??''))&&!financialReportMatch(normalizeClause(clauses[0]??''))&&!healthReportMatch(normalizeClause(clauses[0]??''))&&!singleFieldSummaryMatch(normalizeClause(clauses[0]??''))&&!discoveredFieldSummaryMatch(normalizeClause(clauses[0]??''))&&!plainSummaryMatch(normalizeClause(clauses[0]??''))) {
      // A single unsplit sentence can still be a multi-step request such as
      // "read, summarize, save". Keep the deterministic compiler strict, but
      // give the goal planner a distinct signal to handle the full original
      // objective when it has a reasoning runner.
      throw failure('NATURAL_WORKFLOW_SINGLE_UNSEGMENTED', '한 절 안의 복합 요청은 일반 목표 계획기로 전달해야 합니다.');
    }
    if (clauses.length > 64) throw failure('NATURAL_WORKFLOW_CLAUSE_LIMIT', '절은 64개 이하여야 합니다.');
    const state = createState(root, strings);
    for (let index = 0; index < clauses.length; index += 1) {
      currentClause = index;
      const raw = clauses[index];
      const clause = normalizeClause(raw);
      state.lastReferenceBinding = null;
      const start = state.nodes.length;
      if (!compileClause(clause, state, goalContract.requirements[index])) throw failure('NATURAL_WORKFLOW_CLAUSE_UNSUPPORTED', `지원하지 않는 명령 절 ${index + 1}입니다.`);
      const requirement = goalContract.requirements[index];
      const nodeIds = state.nodes.slice(start).map(node => node.id);
      requirement.nodeIds = nodeIds;
      requirement.interpretation.status = 'deterministic-compiled';
      if (state.lastReferenceBinding) {
        const binding = state.lastReferenceBinding;
        requirement.referenceBindings = [{ ...binding, sourceSpan: {
          start: sourceSpans[index].start,
          end: sourceSpans[index].start + binding.text.length
        } }];
        requirement.interpretation.resolvedReferences = [{ text: binding.text, basis: 'single-prior-mission-output',
          requirementId: binding.requirementId, path: binding.path }];
        requirement.interpretation.unresolvedReferences = requirement.interpretation.unresolvedReferences
          .filter(reference => reference !== binding.text);
      }
      state.clauses.push({ index, text: restore(raw, strings), sourceText: objective.slice(sourceSpans[index].start, sourceSpans[index].end),
        sourceSpan: sourceSpans[index], requirementId: requirement.requirementId, nodeIds, status: 'compiled' });
    }
    if (!state.nodes.length) throw failure('NATURAL_WORKFLOW_EMPTY');
    const nodeRequirements = new Map(state.clauses.flatMap(clause => clause.nodeIds.map(id => [id, clause.requirementId])));
    for (const requirement of goalContract.requirements) {
      requirement.dependsOn = [...new Set(state.nodes.filter(node => requirement.nodeIds.includes(node.id))
        .flatMap(node => node.dependsOn.map(id => nodeRequirements.get(id))).filter(id => id !== requirement.requirementId))];
    }
    goalContract.unresolvedRequirementIds = [];
    goalContract.interpretationBasis = 'deterministic-workflow-grammar';
    goalContract.semanticCoverage = 'deterministic-grammar-only';
    const result = {
      status: 'compiled', compilerVersion: NATURAL_WORKFLOW_COMPILER_VERSION,
      objectiveSha256: digest(objective), workspaceRoot: root, goalContract,
      spec: { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflowId: `natural_${workflowIdentity.slice(0, 24)}`, description: '한국어 자연어 절 전체에서 결정적으로 생성한 로컬 워크플로', nodes: state.nodes, outputs: state.outputs },
      clauses: state.clauses, clauseCount: state.clauses.length, nodeCount: state.nodes.length,
      namedResults: Object.fromEntries(state.names), cacheHit: false
    };
    if(state.rediscoverOutput)result.rediscoverOutput=state.rediscoverOutput;
    cache.set(key, deepFreeze(structuredClone(result)));
    while (cache.size > NATURAL_WORKFLOW_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) {
    let goalContract = null;
    try { goalContract = createGoalContract({ objective }); } catch { /* Invalid syntax remains a whole-objective handoff. */ }
    return { ...blocked(error.code ?? 'NATURAL_WORKFLOW_COMPILE_FAILED', error.message, currentClause), goalContract,
      handoff: { objective, objectiveSha256: digest(objective), requiresWholeObjective: true } };
  }
}

export function clearNaturalWorkflowCompileCache() { cache.clear(); }
export function naturalWorkflowCompileCacheSize() { return cache.size; }

function financialReportMatch(clause) { return match(clause, `${Q} (?:OFX )?금융자료를 대사해 ${Q}에 저장하고 다시 읽어 확인(?:해줘|해주세요|해)`); }
function safetySimulationMatch(clause) {
  return match(clause, `긴급전화·차량·도어락·전열기 안전 절차를 격리 모의 시험하고 ${Q}에 저장한 뒤 다시 읽어 검증(?:해줘|해주세요|해)`);
}
function healthReportMatch(clause) {
  return match(clause, `${Q} 건강 기록을 ${Q}부터 ${Q}까지 요약해 ${Q}에 저장하고 다시 읽어 확인(?:해줘|해주세요|해)`);
}
function theologyReviewMatch(clause) {
  return match(clause, `${Q} 신학 연구 자료의 분류·인용·본문·전제 연결만 검토해 ${Q}와 ${Q}에 저장하고 다시 읽어 확인(?:해줘|해주세요|해)`);
}
function looksLikeWorkflow(text) {
  // Ordinary single spec-path requests do not match the supported prose anchors below.
  // A quoted .workflow.json inside a data path/template must not suppress this compiler.
  return /(?:CSV|JSON|텍스트)(?:를|을)\s*["'“‘]/iu.test(text)
    || /안전 절차를 격리 모의 시험하고/u.test(text)
    || /파일에서 항목 .*정리해 .*저장하고 다시 읽어 확인/u.test(text)
    || /금융자료를 대사해 .*저장하고 다시 읽어 확인/u.test(text)
    || /건강 기록을 .*부터 .*까지 요약해 .*저장하고 다시 읽어 확인/u.test(text)
    || /신학 연구 자료의 분류·인용·본문·전제 연결만 검토해/u.test(text)
    || /폴더에서 .*파일을 찾아 항목 .*정리해 .*저장하고 다시 읽어 확인/u.test(text)
    || /폴더에서 .*파일을 찾아 .*요약해 .*저장하고 다시 찾아 읽어 확인/u.test(text)
    || /(?:으로|로)\s*(?:만들|읽)/u.test(text) && /[;；\n]|\s(?:그리고|그다음|다음으로|이어서|마지막으로)\s/u.test(text)
    || /폴더(?:의|에서).*?(?:조사|검색|중복)/u.test(text)
    || /(?:행 수가|개수가|인지 검증|SQL\s*["'])/u.test(text) && /[;；\n]/u.test(text);
}

function tokenize(text) {
  try { return tokenizeGoalSource(text); }
  catch (error) {
    const suffix = error.code?.replace('A_GOAL_', '') ?? 'OBJECTIVE_INVALID';
    throw failure(`NATURAL_WORKFLOW_${suffix === 'REQUIREMENT_LIMIT' ? 'CLAUSE_LIMIT' : suffix}`);
  }
}

function createState(root, strings) {
  return { root, strings, nodes: [], outputs: [], names: new Map(), clauses: [], fileWriters: new Map(), savedFileBindings: [], lastReferenceBinding: null };
}
function normalizeClause(raw) {
  return raw.replace(/^(?:먼저|그리고|다음으로|그다음(?:으로)?|이어서|마지막으로)\s*,?\s*/u, '')
    .replace(/[.!。]\s*$/u, '').trim()
    .replace(/\s+(줘|주세요)$/u, '$1')
    .replace(/읽으세요$/u, '읽어').replace(/만드세요$/u, '만들어')
    .replace(/(검증|저장|선택)하세요$/u, '$1해').replace(/걸러내세요$/u, '걸러내');
}
function match(clause, pattern) { return new RegExp(`^${pattern}$`, 'iu').exec(clause); }
function singleFieldSummaryMatch(clause){
  return match(clause,`${Q} 파일에서 항목 (.+?)(?:을|를) 정리해 ${Q}(?:에|으로|로) JSON으로 저장하고 다시 읽어 확인(?:해줘|해주세요|해)`);
}
function discoveredFieldSummaryMatch(clause){
  return match(clause,`${Q} 폴더에서 ${Q} 파일을 찾아 항목 (.+?)(?:을|를) 정리해 ${Q}(?:에|으로|로) JSON으로 저장하고 다시 읽어 확인(?:해줘|해주세요|해)`);
}
function plainSummaryMatch(clause){
  return match(clause,`${Q} 폴더에서 ${Q} 파일을 찾아 (.+?)(?:을|를) 요약해 ${Q}에 JSON으로 저장하고 다시 찾아 읽어 확인(?:해줘|해주세요|해)`);
}
function plainSummaryQuestions(topics){
  const catalogue={
    '실제 지출액':['실제 지출액 숫자만','digits'], '실제 납부액':['실제 납부 금액을 숫자만','digits'],
    '실제 입금액':['실제 입금액 숫자만','digits'], '실제 결제액':['실제 결제액 숫자만','digits'],
    '승인 상태':['승인 상태를 원문 단어로','source-phrase'], '계약 확정 상태':['계약 확정 상태를 원문 단어로','source-phrase'],
    '최종 확인 결과':['최종 확인 결과를 원문 표현으로','verification-status'],
    '최종 검증 결과':['최종 검증 결과를 원문 표현으로','verification-status'],
    '최종 참석자 수':['최종 참석자 수를 숫자만','digits'], '최종 참가자 수':['최종 참가자 수를 숫자만','digits'],
    '설문 응답자 수':['설문 응답자 수만 숫자로','digits']
  };
  const names=topics.split(/\s*(?:,|과|와|및)\s*/u);
  if(!names.length||names.length>10||new Set(names).size!==names.length)throw failure('NATURAL_WORKFLOW_FIELDS_LIMIT');
  const questions={},valueFormats={};
  for(const [index,name] of names.entries()){
    if(!Object.hasOwn(catalogue,name))throw failure('NATURAL_WORKFLOW_SUMMARY_TOPIC_UNSUPPORTED',`요약 항목을 아직 검증할 수 없습니다: ${name}`);
    const id=`field${index+1}`;[questions[id],valueFormats[id]]=catalogue[name];
  }
  return {questions,valueFormats};
}
function addSourceSummary(s,readId,fields,output,requirement){
  const extractId=add(s,'text.extractFields',{text:{$ref:{nodeId:readId,pointer:'/text',expectedType:'string'}},...multipleSourceFields(s,fields)});
  const saveId=add(s,'write.json',{path:output,value:{$ref:{nodeId:extractId,pointer:'',expectedType:'object'}}});
  saveOutput(s,saveId,output,'application/json',false,requirement?.requirementId);
  add(s,'data.readJson',{path:output},null,'/value',[saveId]);
}
function multipleSourceFields(s,items){
  const parts=items.split(/\s*,\s*/u),sourceFields={},questions={},valueFormats={},labels=new Set();
  if(parts.length<2||parts.length>10)throw failure('NATURAL_WORKFLOW_FIELDS_LIMIT');
  for(const [index,part] of parts.entries()){
    const numeric=match(part,`${Q}의 ${Q} 단위 숫자`),status=match(part,`${Q}의 승인 상태`),unknown=match(part,`${Q}의 미정 여부`);
    const found=numeric??status??unknown;
    if(!found)throw failure('NATURAL_WORKFLOW_FIELD_UNSUPPORTED');
    const label=q(s,found[1]),id=`field${index+1}`;
    if(labels.has(label))throw failure('NATURAL_WORKFLOW_FIELD_DUPLICATE');
    labels.add(label);
    sourceFields[id]=numeric?{label,kind:'integer',unit:q(s,numeric[2])}:status?{label,kind:'enum',choices:['승인','미승인','미정']}:{label,kind:'unknown-date'};
    questions[id]=`${label} ${numeric?'숫자만':status?'승인 상태':'미정 여부'}`;
    valueFormats[id]=numeric?'digits':status?'source-phrase':'iso-date-or-unknown';
  }
  return {sourceFields,questions,valueFormats};
}
function q(state, token) {
  const found = quoteToken.exec(token ?? '');
  if (!found) throw failure('NATURAL_WORKFLOW_QUOTED_VALUE_REQUIRED');
  return state.strings[Number(found[1])];
}
function fields(state, tokens) {
  return tokens.split(/\s*,\s*/u).map((token) => safeField(q(state, token)));
}
function safeField(value) {
  if (!value || value.length > 256 || value.split('.').some((part) => !part || forbidden.has(part)) || /[\u0000-\u001f]/u.test(value)) throw failure('NATURAL_WORKFLOW_FIELD_INVALID', value);
  return value;
}
function ref(state, token, expectedType = 'any') {
  const name = q(state, token);
  const named = state.names.get(name);
  if (!named) throw failure('NATURAL_WORKFLOW_REFERENCE_UNKNOWN', `정의되지 않은 데이터 이름: ${name}`);
  return { $ref: { nodeId: named.nodeId, pointer: expectedType === 'array' && named.collectionPointer ? named.collectionPointer : named.pointer, expectedType } };
}
function at(state, token, field, { relativeToValue = true, expectedType = 'any' } = {}) {
  const result = ref(state, token, expectedType);
  const pointer = safeField(field).split('.').map((part) => part.replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/');
  result.$ref.pointer = `${relativeToValue ? result.$ref.pointer : ''}/${pointer}`;
  return result;
}
function literal(state, value) {
  if (quoteToken.test(value)) return q(state, value);
  if (['true', 'false', 'null'].includes(value)) return JSON.parse(value);
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) && Number.isFinite(Number(value))) return Number(value);
  throw failure('NATURAL_WORKFLOW_LITERAL_INVALID', value);
}
function safePath(state, token) {
  const path = q(state, token);
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^[a-z][a-z\d+.-]*:\/\//iu.test(path)) throw failure('NATURAL_WORKFLOW_PATH_INVALID');
  const absolute = resolve(state.root, path);
  const relation = relative(state.root, absolute);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw failure('NATURAL_WORKFLOW_PATH_OUTSIDE_ROOT');
  return absolute;
}
function add(state, op, args, alias = null, pointer = '/items', extraDependencies = []) {
  const id = `step_${String(state.nodes.length + 1).padStart(3, '0')}`;
  const dependencies = new Set(extraDependencies);
  function scan(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) dependencies.add(value.$ref.nodeId);
    else Object.values(value).forEach(scan);
  }
  scan(args);
  state.nodes.push({ id, op, dependsOn: [...dependencies], args });
  if (alias !== null) {
    const name = q(state, alias);
    if (!name || name.length > 128 || forbidden.has(name)) throw failure('NATURAL_WORKFLOW_NAME_INVALID');
    if (state.names.has(name)) throw failure('NATURAL_WORKFLOW_NAME_DUPLICATE', name);
    const collectionPointer = ['compute.ledger', 'graph.toposort', 'graph.shortestPath', 'graph.criticalPath', 'solver.knapsack', 'solver.schedule'].includes(op) ? '/items' : null;
    state.names.set(name, { nodeId: id, pointer, ...(collectionPointer ? { collectionPointer } : {}) });
  }
  return id;
}
function saveOutput(state, id, path, mediaType, replace = false, sourceRequirementId = null) {
  const outputPath = relative(state.root, path).replace(/\\/gu, '/');
  const old = state.outputs.findIndex((output) => output.path.toLocaleLowerCase() === outputPath.toLocaleLowerCase());
  if (old >= 0) {
    if (!replace) throw failure('NATURAL_WORKFLOW_OUTPUT_DUPLICATE');
    state.outputs.splice(old, 1);
  }
  state.outputs.push({ nodeId: id, path: outputPath, mediaType });
  state.fileWriters.set(path.toLocaleLowerCase(), id);
  state.savedFileBindings = state.savedFileBindings.filter(item => item.path.toLocaleLowerCase() !== outputPath.toLocaleLowerCase());
  state.savedFileBindings.push({ nodeId: id, path: outputPath, mediaType, requirementId: sourceRequirementId });
}

function compileClause(c, s, requirement = null) {
  let m;
  const make = `${Q}(?:으로|로) 만들(?:고|어(?:줘|주세요)?)`;
  const read = '읽(?:고|어(?:줘|주세요)?)';
  const verify = '검증(?:하고|해(?:줘|주세요)?)';
  if((m=plainSummaryMatch(c))){
    const directory=safePath(s,m[1]),name=q(s,m[2]),output=safePath(s,m[4]);
    if(!name||/[\\/\u0000-\u001f]/u.test(name)||name==='.'||name==='..')throw failure('NATURAL_WORKFLOW_FILE_NAME_REQUIRED');
    if(name.toLocaleLowerCase()===basename(output).toLocaleLowerCase())throw failure('NATURAL_WORKFLOW_SOURCE_OVERWRITE');
    if(!/\.json$/iu.test(output))throw failure('NATURAL_WORKFLOW_SUMMARY_JSON_REQUIRED');
    const fields=plainSummaryQuestions(m[3]);
    const inventory=add(s,'fs.inventory',{path:directory,recursive:true,hash:false,maxEntries:10000});
    const selected=add(s,'data.filter',{items:{$ref:{nodeId:inventory,pointer:'/items',expectedType:'array'}},where:{field:'name',op:'eq',value:name}});
    const unique=add(s,'assert.count',{value:{$ref:{nodeId:selected,pointer:'/items',expectedType:'array'}},equals:1});
    const readId=add(s,'text.read',{path:{$ref:{nodeId:selected,pointer:'/items/0/path',expectedType:'string'}}},null,'/text',[unique]);
    const extractId=add(s,'text.extractFields',{text:{$ref:{nodeId:readId,pointer:'/text',expectedType:'string'}},...fields});
    const saveId=add(s,'write.json',{path:output,value:{$ref:{nodeId:extractId,pointer:'',expectedType:'object'}}});
    saveOutput(s,saveId,output,'application/json',false,requirement?.requirementId);
    add(s,'data.readJson',{path:output},null,'/value',[saveId]);
    s.rediscoverOutput=output;return true;
  }
  if ((m = safetySimulationMatch(c))) {
    const output = safePath(s, m[1]);
    if (!/\.json$/iu.test(output)) throw failure('NATURAL_WORKFLOW_SIMULATION_JSON_REQUIRED');
    const simulation = add(s, 'safety.simulation', { mode: 'isolated-simulation' });
    const writeId = add(s, 'write.json', { path: output, value: { $ref: { nodeId: simulation, pointer: '', expectedType: 'object' } } });
    saveOutput(s, writeId, output, 'application/json', false, requirement?.requirementId ?? null);
    add(s, 'data.readJson', { path: output }, null, '/value', [writeId]); return true;
  }
  if ((m=financialReportMatch(c))) {
    const input=safePath(s,m[1]),output=safePath(s,m[2]);
    if(input.toLocaleLowerCase()===output.toLocaleLowerCase())throw failure('NATURAL_WORKFLOW_SOURCE_OVERWRITE');
    const readId=add(s,'data.readJson',{path:input});
    const reportId=add(s,c.includes('OFX 금융자료')?'financial.ofxReport':'financial.report',{input:{$ref:{nodeId:readId,pointer:'/value',expectedType:'object'}}});
    const writeId=add(s,'write.text',{path:output,text:{$ref:{nodeId:reportId,pointer:'/reportMarkdown',expectedType:'string'}}});
    saveOutput(s,writeId,output,'text/plain',false,requirement?.requirementId??null);
    add(s,'text.read',{path:output},null,'/text',[writeId]);return true;
  }
  if ((m=theologyReviewMatch(c))) {
    const input=safePath(s,m[1]),report=safePath(s,m[2]),manifest=safePath(s,m[3]);
    if(new Set([input,report,manifest].map(path=>path.toLocaleLowerCase())).size!==3)throw failure('NATURAL_WORKFLOW_SOURCE_OVERWRITE');
    const readId=add(s,'data.readJson',{path:input});
    const reviewId=add(s,'theology.review',{input:{$ref:{nodeId:readId,pointer:'/value',expectedType:'object'}}});
    const reportWrite=add(s,'write.text',{path:report,text:{$ref:{nodeId:reviewId,pointer:'/report',expectedType:'string'}}});
    const manifestWrite=add(s,'write.json',{path:manifest,value:{$ref:{nodeId:reviewId,pointer:'',expectedType:'object'}}});
    saveOutput(s,reportWrite,report,'text/plain',false,requirement?.requirementId??null);
    saveOutput(s,manifestWrite,manifest,'application/json',false,requirement?.requirementId??null);
    add(s,'text.read',{path:report},null,'/text',[reportWrite]);
    add(s,'data.readJson',{path:manifest},null,'/value',[manifestWrite]);return true;
  }
  if ((m=healthReportMatch(c))) {
    const input=safePath(s,m[1]),output=safePath(s,m[4]);
    if(input.toLocaleLowerCase()===output.toLocaleLowerCase())throw failure('NATURAL_WORKFLOW_SOURCE_OVERWRITE');
    const startDate=q(s,m[2]),endDate=q(s,m[3]);
    if(!/^\d{4}-\d{2}-\d{2}$/u.test(startDate)||!/^\d{4}-\d{2}-\d{2}$/u.test(endDate)||startDate>endDate)throw failure('NATURAL_WORKFLOW_HEALTH_DATE_INVALID');
    const readId=add(s,'data.readJson',{path:input});
    const reportId=add(s,'health.report',{records:{$ref:{nodeId:readId,pointer:'/value/records',expectedType:'array'}},startDate,endDate});
    const writeId=add(s,'write.text',{path:output,text:{$ref:{nodeId:reportId,pointer:'/reportMarkdown',expectedType:'string'}}});
    saveOutput(s,writeId,output,'text/plain',false,requirement?.requirementId??null);
    add(s,'text.read',{path:output},null,'/text',[writeId]);return true;
  }
  if((m=discoveredFieldSummaryMatch(c))){
    const directory=safePath(s,m[1]),name=q(s,m[2]),output=safePath(s,m[4]);
    if(!name||/[\\/\u0000-\u001f]/u.test(name)||name==='.'||name==='..')throw failure('NATURAL_WORKFLOW_FILE_NAME_REQUIRED');
    if(name.toLocaleLowerCase()===basename(output).toLocaleLowerCase())throw failure('NATURAL_WORKFLOW_SOURCE_OVERWRITE');
    const inventory=add(s,'fs.inventory',{path:directory,recursive:true,hash:false,maxEntries:10000});
    const selected=add(s,'data.filter',{items:{$ref:{nodeId:inventory,pointer:'/items',expectedType:'array'}},where:{field:'name',op:'eq',value:name}});
    const unique=add(s,'assert.count',{value:{$ref:{nodeId:selected,pointer:'/items',expectedType:'array'}},equals:1});
    const readId=add(s,'text.read',{path:{$ref:{nodeId:selected,pointer:'/items/0/path',expectedType:'string'}}},null,'/text',[unique]);
    addSourceSummary(s,readId,m[3],output,requirement);return true;
  }
  if ((m=singleFieldSummaryMatch(c))) {
    const input=safePath(s,m[1]),output=safePath(s,m[3]);
    if(input.toLocaleLowerCase()===output.toLocaleLowerCase())throw failure('NATURAL_WORKFLOW_SOURCE_OVERWRITE');
    const readId=add(s,'text.read',{path:input});
    addSourceSummary(s,readId,m[2],output,requirement);
    return true;
  }
  if ((m = match(c, `(?:그|해당) 파일(?:을|를) ${Q}(?:로|으로) 다시 읽(?:고|어(?:줘|주세요)?)`))) {
    const candidates = s.savedFileBindings;
    if (candidates.length !== 1) throw failure(candidates.length ? 'NATURAL_WORKFLOW_REFERENCE_AMBIGUOUS' : 'NATURAL_WORKFLOW_REFERENCE_MISSING',
      candidates.length ? '현재 작업에서 저장한 파일이 여러 개라 지칭 대상을 구분할 수 없습니다.' : '현재 작업에서 앞서 저장한 파일을 찾을 수 없습니다.');
    const [saved] = candidates;
    const format = ({ 'application/json': 'JSON', 'text/csv': 'CSV', 'text/plain': '텍스트' })[saved.mediaType];
    if (!format) throw failure('NATURAL_WORKFLOW_REFERENCE_FORMAT_UNSUPPORTED', '다시 읽을 파일 형식을 확인할 수 없습니다.');
    const path = resolve(s.root, saved.path);
    const op = format === 'JSON' ? 'data.readJson' : format === 'CSV' ? 'data.readCsv' : 'text.read';
    add(s, op, { path }, m[1], format === 'CSV' ? '/items' : format === 'JSON' ? '/value' : '/text', [saved.nodeId]);
    s.lastReferenceBinding = { text: c.startsWith('해당') ? '해당 파일' : '그 파일', path: saved.path,
      mediaType: saved.mediaType, requirementId: saved.requirementId };
    return true;
  }
  if ((m = match(c, `${Q} (CSV|JSON|텍스트)(?:를|을) ${Q}(?:으로|로) ${read}`))) {
    const format = m[2].toUpperCase();
    const path = safePath(s, m[1]);
    const previous = s.fileWriters.get(path.toLocaleLowerCase());
    add(s, format === 'CSV' ? 'data.readCsv' : format === 'JSON' ? 'data.readJson' : 'text.read', { path }, m[3], format === 'CSV' ? '/items' : '/value', previous ? [previous] : []); return true;
  }
  if ((m = match(c, `${Q}의 ${Q}(?:를|을) ${Q}(?:으로|로) 선택(?:하고|해(?:줘|주세요)?)`))) {
    add(s, 'data.validate', { value: at(s, m[1], q(s, m[2])), failOnError: true }, m[3], '/value'); return true;
  }
  if ((m = match(c, `${Q}에서 이름 ${Q}(?:와|과) 소속 ${Q}에 일치하는 사람 한 명(?:을|만) ${Q}(?:으로|로) 골라(?:줘|주세요)?`))) {
    const selected=add(s,'data.filter',{items:ref(s,m[1],'array'),where:{all:[
      {field:'이름',operator:'eq',value:q(s,m[2])},{field:'소속',operator:'eq',value:q(s,m[3])}]}},m[4]);
    add(s,'assert.count',{value:{$ref:{nodeId:selected,pointer:'/items',expectedType:'array'}},equals:1});return true;
  }
  if ((m = match(c, `${Q}에서 이름 ${Q}에 일치하는 사람 한 명(?:을|만) ${Q}(?:으로|로) 골라(?:줘|주세요)?`))) {
    const selected=add(s,'data.filter',{items:ref(s,m[1],'array'),where:{field:'이름',operator:'eq',value:q(s,m[2])}},m[3]);
    add(s,'assert.count',{value:{$ref:{nodeId:selected,pointer:'/items',expectedType:'array'}},equals:1});return true;
  }
  if ((m = match(c, `${Q}에서 ${Q}(?:가|이) (.+?) 행만 ${Q}(?:으로|로) 걸러(?:내고|내(?:줘|주세요)?)`))) {
    const condition = parseCondition(s, m[3]);
    add(s, 'data.filter', { items: ref(s, m[1], 'array'), where: { field: safeField(q(s, m[2])), ...condition } }, m[4]); return true;
  }
  if ((m = match(c, `${Q}에서 ${Q}(?:가|이) ${Q}인 행(?:을|은) (?:제외하고|빼고) 나머지(?:를|는) ${Q}(?:으로|로) 만들(?:고|어(?:줘|주세요)?)`))) {
    // Quoted literal equality only: preserve missing/null/numeric values,
    // duplicates and ordering unless they exactly equal the excluded string.
    // A result alias such as "공개" supplies no privacy or execution grant.
    add(s,'data.filter',{items:ref(s,m[1],'array'),where:{field:safeField(q(s,m[2])),operator:'ne',value:q(s,m[3])}},m[4]);return true;
  }
  if ((m = match(c, `${Q}(?:를|을) (.+?)으로 (숫자로 )?정렬해 ${make}`))) {
    add(s, 'data.sort', { items: ref(s, m[1], 'array'), by: parseSort(s, m[2], Boolean(m[3])) }, m[4]); return true;
  }
  if ((m = match(c, `${Q}의 ${Q} 기준 중복을 제거해 ${make}`))) {
    add(s, 'data.unique', { items: ref(s, m[1], 'array'), by: safeField(q(s, m[2])) }, m[3]); return true;
  }
  if ((m = match(c, `${Q}(?:를|을) (.+?)별로 ${Q} (합계|평균|최솟값|최댓값) ${Q}(?:을|를) 계산해 ${make}`))) {
    add(s, 'data.groupAggregate', { items: ref(s, m[1], 'array'), groupBy: fields(s, m[2]), field: safeField(q(s, m[3])), operation: aggregate[m[4]], as: safeField(q(s, m[5])), includeValueAlias: false }, m[6]); return true;
  }
  if ((m = match(c, `${Q}(?:를|을) (.+?)별로 개수 ${Q}(?:을|를) 계산해 ${make}`))) {
    add(s, 'data.groupAggregate', { items: ref(s, m[1], 'array'), groupBy: fields(s, m[2]), operation: 'count', as: safeField(q(s, m[3])), includeValueAlias: false }, m[4]); return true;
  }
  if ((m = match(c, `${Q}(?:과|와) ${Q}(?:을|를) ${Q}(?:와|과) ${Q} 기준으로 (내부|왼쪽|오른쪽|전체) 조인해 ${make}`))) {
    add(s, 'data.join', { left: ref(s, m[1], 'array'), right: ref(s, m[2], 'array'), leftKey: safeField(q(s, m[3])), rightKey: safeField(q(s, m[4])), type: ({ 내부: 'inner', 왼쪽: 'left', 오른쪽: 'right', 전체: 'full' })[m[5]] }, m[6]); return true;
  }
  if ((m = match(c, `${Q}(?:을|를) 행 ${Q}, 열 ${Q}, 값 ${Q}의 (합계|평균|최솟값|최댓값|개수)로 피벗해 ${make}`))) {
    add(s, 'data.pivot', { items: ref(s, m[1], 'array'), row: safeField(q(s, m[2])), column: safeField(q(s, m[3])), value: safeField(q(s, m[4])), operation: aggregate[m[5]] ?? 'count' }, m[6]); return true;
  }
  if ((m = match(c, `${Q}의 필수 필드 (.+?)(?:을|를) 검증해 ${make}`))) {
    add(s, 'data.validate', { value: ref(s, m[1]), required: fields(s, m[2]), failOnError: true }, m[3], '/value'); return true;
  }
  if ((m = match(c, `${Q}에서 필드 (.+?)만 추출해 ${make}`))) {
    add(s, 'data.project', { items: ref(s, m[1], 'array'), fields: fields(s, m[2]) }, m[3]); return true;
  }
  if ((m = match(c, `${Q}에서 (.+?) (?:열|컬럼)만 선택해 ${make}`))) {
    // In this column-list phrasing, a quoted comma-separated list is shorthand
    // for separately quoted column names. The existing field syntax is unchanged.
    const selected = m[2].split(/\s*,\s*/u).flatMap(token => q(s, token).split(',').map(value => safeField(value.trim())));
    add(s, 'data.project', { items: ref(s, m[1], 'array'), fields: selected }, m[3]); return true;
  }
  if ((m = match(c, `${Q}에 ${Q} = (.+?)(?:를|을) 계산해 ${make}`))) {
    add(s, 'data.derive', { items: ref(s, m[1], 'array'), fields: { [safeField(q(s, m[2]))]: parseArithmetic(s, m[3]) } }, m[4]); return true;
  }
  if ((m = match(c, `${Q}의 ${Q} 배열을 ${Q}(?:으로|로) 펼쳐 ${make}`))) {
    add(s, 'data.flatten', { items: ref(s, m[1], 'array'), field: safeField(q(s, m[2])), as: safeField(q(s, m[3])) }, m[4]); return true;
  }
  if ((m = match(c, `${Q}에서 (\\d+)행부터 (\\d+)행을 추출해 ${make}`))) {
    add(s, 'data.limit', { items: ref(s, m[1], 'array'), offset: Number(m[2]), count: Number(m[3]) }, m[4]); return true;
  }
  if ((m = match(c, `${Q}(?:과|와) ${Q}(?:를|을) 합쳐 ${make}`))) {
    add(s, 'data.union', { items: ref(s, m[1], 'array'), others: [ref(s, m[2], 'array')] }, m[3]); return true;
  }
  if ((m = match(c, `${Q}(?:과|와) ${Q}(?:를|을) 키 (.+?), 비교 필드 (.+?)(?:로|으로) 대사해 ${make}`))) {
    add(s, 'data.reconcile', { items: ref(s, m[1], 'array'), other: ref(s, m[2], 'array'), keys: fields(s, m[3]), fields: fields(s, m[4]) }, m[5]); return true;
  }
  if ((m = match(c, `${Q}(?:을|를) 그룹 (.+?), 정렬 (.+?), 값 ${Q} 기준 (행번호|순위|밀집순위|누적합) ${Q}(?:를|을) 계산해 ${make}`))) {
    add(s, 'data.window', { items: ref(s, m[1], 'array'), partitionBy: fields(s, m[2]), orderBy: parseSort(s, m[3]), valueField: safeField(q(s, m[4])), kind: ({ 행번호: 'rowNumber', 순위: 'rank', 밀집순위: 'denseRank', 누적합: 'runningSum' })[m[5]], as: safeField(q(s, m[6])) }, m[7]); return true;
  }
  if ((m = match(c, `${Q}의 ${Q} 통계를 계산해 ${make}`))) {
    add(s, 'data.statistics', { items: ref(s, m[1], 'array'), field: safeField(q(s, m[2])) }, m[3], '/statistics'); return true;
  }
  if ((m = match(c, `${Q}의 필드 (.+?)(?:을|를) (.+?)(?:로|으로) 정규화해 ${make}`))) {
    const options = m[3].trim().split(/\s+/u);
    if (!options.length || new Set(options).size !== options.length || options.some((value) => !['공백제거', '소문자', '대문자', '빈값null'].includes(value)) || options.includes('소문자') && options.includes('대문자')) throw failure('NATURAL_WORKFLOW_NORMALIZE_OPTIONS_INVALID');
    add(s, 'data.normalize', { items: ref(s, m[1], 'array'), fields: fields(s, m[2]), trim: options.includes('공백제거'), case: options.includes('소문자') ? 'lower' : options.includes('대문자') ? 'upper' : 'none', nullEmpty: options.includes('빈값null') }, m[4]); return true;
  }
  if ((m = match(c, `${Q}의 필드 (.+?)에서 ${Q}(?:를|을) ${Q}(?:로|으로) 치환해 ${make}`))) {
    add(s, 'text.replace', { items: ref(s, m[1], 'array'), fields: fields(s, m[2]), search: q(s, m[3]), replacement: q(s, m[4]) }, m[5]); return true;
  }
  if ((m = match(c, `${Q}의 필드 (.+?)(?:을|를) (이메일|전화번호) 마스킹해 ${make}`))) {
    add(s, 'text.redact', { items: ref(s, m[1], 'array'), fields: fields(s, m[2]), preset: m[3] === '이메일' ? 'email' : 'phone' }, m[4]); return true;
  }
  if ((m = match(c, `${Q}(?:를|을) 소수 ([0-6])자리 원장으로 계산해 ${make}`))) {
    add(s, 'compute.ledger', { entries: ref(s, m[1], 'array'), scale: Number(m[2]) }, m[3], ''); return true;
  }
  if ((m = match(c, `(.+?) ${Q}(?:를|을) ${Q}(?:로|으로) 변환해 ${make}`))) {
    add(s, 'compute.units', { value: literal(s, m[1]), from: q(s, m[2]), to: q(s, m[3]) }, m[4], ''); return true;
  }
  if ((m = match(c, `${Q}의 그래프를 위상 정렬해 ${make}`))) {
    add(s, 'graph.toposort', { nodes: at(s, m[1], 'nodes', { relativeToValue: true, expectedType: 'array' }), edges: at(s, m[1], 'edges', { relativeToValue: true, expectedType: 'array' }) }, m[2], ''); return true;
  }
  if ((m = match(c, `${Q}의 그래프에서 ${Q}부터 ${Q}까지 최단 경로를 계산해 ${make}`))) {
    add(s, 'graph.shortestPath', { nodes: at(s, m[1], 'nodes', { relativeToValue: true, expectedType: 'array' }), edges: at(s, m[1], 'edges', { relativeToValue: true, expectedType: 'array' }), start: q(s, m[2]), end: q(s, m[3]) }, m[4], ''); return true;
  }
  if ((m = match(c, `${Q}의 임계 경로를 계산해 ${make}`))) {
    add(s, 'graph.criticalPath', { tasks: ref(s, m[1], 'array') }, m[2], ''); return true;
  }
  if ((m = match(c, `${Q}에서 용량 (\\d+)(?:으로|로) 최대가치 선택해 ${make}`))) {
    add(s, 'solver.knapsack', { items: ref(s, m[1], 'array'), capacity: Number(m[2]) }, m[3], ''); return true;
  }
  if ((m = match(c, `${Q}(?:을|를) 자원 (\\d+)개로 일정 계산해 ${make}`))) {
    add(s, 'solver.schedule', { tasks: ref(s, m[1], 'array'), resources: Number(m[2]) }, m[3], ''); return true;
  }
  if ((m = match(c, `${Q} 폴더의 파일을 재귀 해시 목록으로 조사해 ${make}`))) {
    add(s, 'fs.inventory', { path: safePath(s, m[1]), recursive: true, hash: true }, m[2]); return true;
  }
  if ((m = match(c, `${Q} 폴더에서 (문자열|정규식) ${Q}(?:를|을) 재귀 검색해 ${make}`))) {
    add(s, 'fs.search', { path: safePath(s, m[1]), pattern: q(s, m[3]), regex: m[2] === '정규식', recursive: true }, m[4]); return true;
  }
  if ((m = match(c, `${Q} 폴더의 내용 중복을 찾아 ${make}`))) {
    add(s, 'fs.duplicates', { path: safePath(s, m[1]), recursive: true }, m[2]); return true;
  }
  if ((m = match(c, `${Q}의 텍스트 통계를 계산해 ${make}`))) {
    add(s, 'text.stats', { text: ref(s, m[1], 'string') }, m[2], ''); return true;
  }
  if ((m = match(c, `${Q}에서 항목 (.+?)(?:을|를) 함께 추출(?:해서|해) ${make}`))) {
    add(s,'text.extractFields',{text:ref(s,m[1],'string'),...multipleSourceFields(s,m[2])},m[3],'');return true;
  }
  if ((m = match(c, `${Q}에서 ${Q}의 정정 후 현재 숫자를 ${Q} 단위로 추출(?:해서|해) ${make}`))) {
    // This exact grammar queries source revisions; it does not revise the user's goal.
    if(requirement){requirement.interpretation.correction=false;requirement.interpretation.correctionBasis='explicit-source-revision-query';}
    add(s,'text.extractFields',{text:ref(s,m[1],'string'),sourceFields:{value:{label:q(s,m[2]),kind:'corrected-integer',unit:q(s,m[3])}},
      questions:{value:`${q(s,m[2])} 정정 후 현재 숫자`},valueFormats:{value:'digits'}},m[4],'');return true;
  }
  if ((m = match(c, `${Q}에서 ${Q}의 ${Q} 주장을 ${Q} 단위 숫자로 추출(?:해서|해) ${make}`))) {
    add(s,'text.extractFields',{text:ref(s,m[1],'string'),sourceFields:{value:{label:q(s,m[3]),kind:'attributed-integer',actor:q(s,m[2]),unit:q(s,m[4])}},
      questions:{value:`${q(s,m[2])}의 ${q(s,m[3])} 주장`},valueFormats:{value:'digits'}},m[5],'');return true;
  }
  if ((m = match(c, `${Q}에서 ${Q}(?:을|를) ${Q} 단위 숫자로 추출(?:해서|해) ${make}`))) {
    add(s,'text.extractFields',{text:ref(s,m[1],'string'),sourceFields:{value:{label:q(s,m[2]),kind:'integer',unit:q(s,m[3])}},
      questions:{value:`${q(s,m[2])} 숫자만`},valueFormats:{value:'digits'}},m[4],'');return true;
  }
  if ((m = match(c, `${Q}에서 ${Q}의 승인 상태를 추출(?:해서|해) ${make}`))) {
    add(s,'text.extractFields',{text:ref(s,m[1],'string'),sourceFields:{value:{label:q(s,m[2]),kind:'enum',choices:['승인','미승인','미정']}},
      questions:{value:`${q(s,m[2])} 상태`},valueFormats:{value:'source-phrase'}},m[3],'');return true;
  }
  if ((m = match(c, `${Q}(?:과|와) ${Q}(?:을|를) (값 증가율|값 감소율|소요시간 기준 처리속도 증가율)로 비교해 ${Q}(?:과|와) 허용오차 (\\d+(?:\\.\\d+)?) 퍼센트포인트로 대조해 ${make}`))) {
    const metric={'값 증가율':'increase-percent','값 감소율':'decrease-percent','소요시간 기준 처리속도 증가율':'inverse-increase-percent'}[m[3]];
    add(s,'compute.compareChange',{before:ref(s,m[1],'object'),after:ref(s,m[2],'object'),claim:ref(s,m[4],'object'),metric,tolerancePercentPoints:m[5]},m[6],'');return true;
  }
  if (match(c, `${Q}(?:과|와) ${Q}(?:을|를) .{1,50}로 비교해 ${Q}(?:과|와) 허용오차 \\d+(?:\\.\\d+)? 퍼센트포인트로 대조해 ${make}`)) {
    throw failure('NATURAL_WORKFLOW_CHANGE_METRIC_REQUIRED','값 증가율·값 감소율·소요시간 기준 처리속도 증가율 중 비교 기준을 명시해 주세요.');
  }
  if ((m = match(c, `${Q}에서 ${Q}의 미정 여부를 확인(?:해서|해) ${make}`))) {
    add(s,'text.extractFields',{text:ref(s,m[1],'string'),sourceFields:{value:{label:q(s,m[2]),kind:'unknown-date'}},
      questions:{value:`${q(s,m[2])} 미정 여부`},valueFormats:{value:'iso-date-or-unknown'}},m[3],'');return true;
  }
  if ((m = match(c, `${Q}에 템플릿 ${Q}(?:을|를) 적용해 ${make}`))) {
    add(s, 'template.renderMany', { items: ref(s, m[1], 'array'), template: q(s, m[2]) }, m[3]); return true;
  }
  if ((m = match(c, `${Q}(?:을|를) ${Q} SQLite의 ${Q} 테이블에 (교체|추가) 저장해 ${make}`))) {
    compileSqliteImport(s, m[1], m[2], m[3], m[4] === '교체' ? 'replace' : 'append', null, m[5]); return true;
  }
  if ((m = match(c, `${Q}(?:을|를) ${Q} SQLite의 ${Q} 테이블에 키 ${Q}(?:로|으로) 갱신 저장해 ${make}`))) {
    compileSqliteImport(s, m[1], m[2], m[3], 'upsert', m[4], m[5]); return true;
  }
  if ((m = match(c, `${Q}에서 SQL ${Q}(?:를|을) 조회해 ${make}`))) {
    const sql = q(s, m[2]);
    if (!/^\s*(?:SELECT|WITH)\b/iu.test(sql) || /\b(?:insert|update|delete|drop|alter|attach|detach|vacuum|reindex|replace|create)\b/iu.test(sql)) throw failure('NATURAL_WORKFLOW_SQL_READ_ONLY_REQUIRED');
    add(s, 'sqlite.query', { databasePath: ref(s, m[1], 'object'), sql }, m[3]); return true;
  }
  if ((m = match(c, `${Q}의 ${Q} 테이블을 ${Q}(?:으로|로) ${read}`))) {
    const table = sqlIdentifier(q(s, m[2]));
    add(s, 'sqlite.query', { databasePath: ref(s, m[1], 'object'), sql: `SELECT * FROM "${table}"` }, m[3]); return true;
  }
  if ((m = match(c, `${Q}(?:를|을) ${Q} (JSON|CSV|텍스트)(?:으로|로) 저장(?:하고|해(?:줘|주세요)?)`))) {
    const path = safePath(s, m[2]);
    const format = m[3].toUpperCase();
    const id = add(s, format === 'JSON' ? 'write.json' : format === 'CSV' ? 'write.csv' : 'write.text', { path, [format === 'CSV' ? 'items' : format === 'JSON' ? 'value' : 'text']: ref(s, m[1], format === 'CSV' ? 'array' : 'any') });
    saveOutput(s, id, path, format === 'JSON' ? 'application/json' : format === 'CSV' ? 'text/csv' : 'text/plain', false, requirement?.requirementId ?? null); return true;
  }
  if ((m = match(c, `${Q}의 (?:행 수가|개수가) (\\d+)인지 ${verify}`))) {
    const name = s.names.get(q(s, m[1]));
    add(s, 'assert.count', { value: ref(s, m[1], name?.collectionPointer ? 'array' : 'any'), equals: Number(m[2]) }, null, ''); return true;
  }
  if ((m = match(c, `${Q}의 ${Q} 값이 (.+?)인지 ${verify}`))) {
    add(s, 'assert.equals', { actual: at(s, m[1], q(s, m[2])), expected: literal(s, m[3]) }, null, ''); return true;
  }
  return false;
}

function compileSqliteImport(s, source, target, tableToken, mode, key, alias) {
  const path = safePath(s, target);
  const previous = s.fileWriters.get(path.toLocaleLowerCase());
  const args = { items: ref(s, source, 'array'), databasePath: path, table: sqlIdentifier(q(s, tableToken)), mode };
  if (key) args.key = sqlIdentifier(q(s, key));
  const id = add(s, 'sqlite.import', args, alias, '', previous ? [previous] : []);
  saveOutput(s, id, path, 'application/vnd.sqlite3', true);
}
function sqlIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)) throw failure('NATURAL_WORKFLOW_SQL_IDENTIFIER_INVALID');
  return value;
}
function parseCondition(s, value) {
  const found = /^(.*?)\s*(초과인|이상인|미만인|이하인|포함인|아닌|인)$/u.exec(value);
  if (!found) throw failure('NATURAL_WORKFLOW_FILTER_INVALID');
  const parsed = literal(s, found[1].trim());
  return { operator: ({ 초과인: 'gt', 이상인: 'gte', 미만인: 'lt', 이하인: 'lte', 포함인: 'contains', 아닌: 'ne', 인: 'eq' })[found[2]], value: parsed, ...(typeof parsed === 'number' ? { numeric: true } : {}) };
}
function parseSort(s, value, numeric = false) {
  return value.split(/\s*,\s*/u).map((part) => {
    const m = match(part, `${Q} (숫자 )?(오름차순|내림차순)`);
    if (!m) throw failure('NATURAL_WORKFLOW_SORT_INVALID');
    return { field: safeField(q(s, m[1])), order: order[m[3]], ...(numeric || m[2] ? { numeric: true } : {}) };
  });
}

function parseArithmetic(s, input) {
  const tokens = input.match(/§\d+§|(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?|[+*/()%-]/giu) ?? [];
  if (!tokens.length || tokens.join('') !== input.replace(/\s/gu, '') || tokens.length > 128) throw failure('NATURAL_WORKFLOW_EXPRESSION_INVALID');
  let position = 0;
  function primary(depth) {
    if (depth > 24) throw failure('NATURAL_WORKFLOW_EXPRESSION_DEPTH');
    const token = tokens[position++];
    if (token === '(') {
      const result = expression(0, depth + 1);
      if (tokens[position++] !== ')') throw failure('NATURAL_WORKFLOW_EXPRESSION_INVALID');
      return result;
    }
    if (token === '-') return { op: 'subtract', left: 0, right: primary(depth + 1) };
    if (quoteToken.test(token ?? '')) return { field: safeField(q(s, token)) };
    if (token !== undefined && Number.isFinite(Number(token))) return Number(token);
    throw failure('NATURAL_WORKFLOW_EXPRESSION_INVALID');
  }
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  function expression(minimum, depth) {
    let left = primary(depth);
    while ((precedence[tokens[position]] ?? -1) >= minimum) {
      const operator = tokens[position++];
      const right = expression(precedence[operator] + 1, depth + 1);
      left = { op: ({ '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'modulo' })[operator], left, right };
    }
    return left;
  }
  const ast = expression(0, 0);
  if (position !== tokens.length) throw failure('NATURAL_WORKFLOW_EXPRESSION_INVALID');
  return ast;
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function failure(code, message = code) { return Object.assign(new Error(message), { code }); }
function blocked(code, message = code, clauseIndex = null) { return { status: 'blocked', code, message, clauseIndex, compilerVersion: NATURAL_WORKFLOW_COMPILER_VERSION }; }
function restore(value, strings) { return value.replace(/§(\d+)§/gu, (_, index) => JSON.stringify(strings[Number(index)])); }
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
