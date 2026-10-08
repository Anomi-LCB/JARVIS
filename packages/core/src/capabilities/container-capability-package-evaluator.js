import { createHash } from 'node:crypto';
import { runContainerExecution } from '../runtime/container-execution-environment.js';
import { PersistentEvaluationBudget } from './persistent-evaluation-budget.js';
import { snapshotEvaluationRequirements, assertEvaluationRequirementCoverage } from './evaluation-requirement-contract.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const RESULT_CHANNEL_VERSION='private-message-port-v1';
function assertCurrentResultChannel(result){
  if(result?.receipt?.resultChannelVersion!==RESULT_CHANNEL_VERSION)throw Object.assign(new Error('Historical evaluation needs a fresh stage and current result channel'),{code:'A_EVALUATION_RESULT_CHANNEL_REEVALUATION_REQUIRED'});
  return result;
}

/**
 * Executes the exact staged ESM artifact's adapter methods in JARVIS's pinned,
 * offline container and compares outputs against host-held evaluation cases.
 * Expected outputs are deliberately not mounted into the candidate container.
 * The package admission authority must separately prove that this artifact is
 * the same module from which runtime adapter/verifier functions were loaded.
 */
export function createContainerCapabilityPackageEvaluator({
  casesForPackage,
  executeContainer = runContainerExecution,
  dockerPath,
  timeoutMs = 15_000,
  maxEvaluations = null,
  persistentBudget = null,
  requirementContract = null,
  observeEvaluationCost = null,
  resultContract = null
} = {}) {
  if (typeof casesForPackage !== 'function') throw new TypeError('casesForPackage oracle is required');
  if(resultContract!==null && resultContract!=='local-workflow-files-v1') throw new TypeError('Unsupported host evaluation result contract');
  if (typeof executeContainer !== 'function') throw new TypeError('executeContainer must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new RangeError('Evaluation timeoutMs must be 100..120000');
  if (maxEvaluations !== null && (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1)) throw new RangeError('maxEvaluations must be a positive safe integer or null');
  if (persistentBudget !== null && !(persistentBudget instanceof PersistentEvaluationBudget)) throw new TypeError('PersistentEvaluationBudget is required');
  if (observeEvaluationCost !== null && typeof observeEvaluationCost !== 'function') throw new TypeError('Host cost observer must be a function');
  if (persistentBudget?.status().monetaryPolicy && !observeEvaluationCost) throw Object.assign(new Error('Monetary evaluations require a host cost observer'), {code:'A_EVALUATION_COST_OBSERVER_REQUIRED'});
  let attempts = 0;
  const requirements = snapshotEvaluationRequirements(requirementContract);
  const preparations=new Map();

  const evaluate = async function evaluateCapabilityPackage(input) {
    const startedAt = performance.now(), deadline = startedAt + timeoutMs;
    const remaining = minimum => {
      const value = Math.floor(deadline - performance.now());
      if (value < minimum) throw evaluationDeadline();
      return value;
    };
    // Bind both executable bytes and receipt identity before the first await.
    // Provider-owned references must not change what is dispatched later.
    input = Object.freeze({
      artifactSource: input?.artifactSource,
      stageId: input?.stageId,
      requirementContractSha256: requirements?.sha256 ?? null,
      artifactSha256: input?.artifactSha256,
      packageDigest: input?.packageDigest,
      toolName: input?.toolName,
      manifest: Object.freeze({ packageId: input?.manifest?.packageId, version: input?.manifest?.version })
    });
    if (typeof input?.artifactSource !== 'string'
      || sha256(input.artifactSource) !== input.artifactSha256) {
      throw Object.assign(new Error('Candidate source bytes do not match the staged artifact digest.'), { code: 'A_CAPABILITY_PACKAGE_ARTIFACT_DIGEST_MISMATCH' });
    }
    if (maxEvaluations !== null && attempts >= maxEvaluations) throw Object.assign(new Error('Host evaluation call budget exhausted'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_BUDGET_EXHAUSTED' });
    const preparation=preparations.get(input.stageId);preparations.delete(input.stageId);
    const persistentTicket = preparation?persistentBudget.startPrepared(preparation,input,timeoutMs):persistentBudget?.start(input, timeoutMs);
    if (persistentTicket?.cachedResult) return assertCurrentResultChannel(persistentTicket.cachedResult);
    // Reserve before the first await: concurrent requests cannot both use the
    // same remaining call. Failed attempts consume the reservation as well.
    attempts++;
    try {
    const suite = await beforeDeadline(signal => casesForPackage(Object.freeze({
      packageId: input.manifest?.packageId,
      version: input.manifest?.version,
      toolName: input.toolName,
      packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256
    }), { signal }), remaining(1));
    const cases = validateSuite(suite);
    assertEvaluationRequirementCoverage(requirements, cases);
    const suiteId = suite.suiteId;
    const suiteSha256 = sha256(canonical(cases));
    const runtimeCases = cases.map(({ id, method, args, packet }) => ({ id, method, args, packet }));
    const candidateProgram = [
      "import { parentPort, workerData } from 'node:worker_threads';",
      "const completionPort=workerData.completionPort;delete workerData.completionPort;",
      "const publishCompletion=completionPort.postMessage.bind(completionPort);",
      "const closeCompletion=completionPort.close.bind(completionPort);",
      "parentPort.close();",
      "import { readFile } from 'node:fs/promises';",
      ...(resultContract ? ["import { mkdir } from 'node:fs/promises';", "import {createHash} from 'node:crypto';", "await mkdir('/tmp/workspace',{recursive:true});"] : []),
      "const cases = JSON.parse(await readFile('/task/cases.json', 'utf8'));",
      "const results = [];const appendResult=Array.prototype.push.bind(results);",
      "const artifact = await import('file:///task/candidate.mjs');",
      "if (typeof artifact.createAdapter !== 'function') throw new Error('candidate must export createAdapter(context)');",
      ...(resultContract ? [] : ["const adapter = await artifact.createAdapter({});"]),
      isJsonValue.toString(),
      "for (const [caseIndex,item] of cases.entries()) {",
      ...(resultContract ? [
        "  const workspaceRoot='/tmp/workspace/case-'+caseIndex;await mkdir(workspaceRoot,{recursive:true});",
        "  const adapter=await artifact.createAdapter({allowedRoots:[workspaceRoot]});"
      ] : []),
      "  if (!['shadow', 'execute'].includes(item.method) || typeof adapter[item.method] !== 'function') throw new Error('unsupported candidate method');",
      resultContract ? "  let value = await adapter[item.method]({...item.args,workspaceRoot}, item.packet);" : "  const value = await adapter[item.method](item.args, item.packet);",
      ...(resultContract ? [
        "  if(value.status==='success'){const files=[];for(const file of value.evidence.manifest){",
        "    if(typeof file.path!=='string'||!file.path.startsWith(workspaceRoot+'/')||file.path.split('/').includes('..'))throw new Error('EVALUATION_OUTPUT_PATH_INVALID');",
        "    const bytes=await readFile(file.path),digest=createHash('sha256').update(bytes).digest('hex');",
        "    if(digest!==file.sha256||bytes.length!==file.size)throw new Error('EVALUATION_PUBLICATION_CHANGED');",
        "    files.push({name:file.path.slice(workspaceRoot.length+1),text:bytes.toString('utf8'),sha256:digest,size:bytes.length});}",
        "    files.sort((a,b)=>a.name.localeCompare(b.name));value={status:value.status,nodeCount:value.evidence.workflow.nodeCount,receiptCount:value.evidence.workflow.receipts.length,files};",
        "  }else{value={status:value.status,errorCode:value.error?.code??null};}"
      ] : []),
      "  if (!isJsonValue(value)) throw new Error('candidate result must contain finite plain JSON values');",
      "  appendResult({ id: item.id, actual: value });",
      "}",
      "publishCompletion(results);closeCompletion();"
    ].join('\n');
    // Candidate stdout is not an evaluator receipt. A worker exit without a
    // result must fail even when the candidate exits with code zero.
    const harness = [
      "import { Worker, MessageChannel } from 'node:worker_threads';",
      isJsonValue.toString(),
      "const completionChannel=new MessageChannel();",
      `const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(${JSON.stringify(candidateProgram)})), {stdout:true,stderr:true,workerData:{completionPort:completionChannel.port2},transferList:[completionChannel.port2]});`,
      "worker.stdout.resume(); worker.stderr.resume();",
      "let messages=0, results;",
      "await new Promise((resolve,reject)=>{",
      " let exited=false,closed=false,exitCode;const finish=()=>{if(!exited||!closed)return;if(exitCode!==0||messages!==1||!isJsonValue(results))reject(new Error('candidate worker did not return one valid result'));else resolve();};",
      " completionChannel.port1.on('message',value=>{messages++;results=value;});",
      " completionChannel.port1.on('close',()=>{closed=true;finish();});",
      " worker.on('error',reject);",
      " worker.on('exit',code=>{exited=true;exitCode=code;finish();});",
      "});",
      "completionChannel.port1.close();",
      "process.stdout.write('JARVIS_PACKAGE_RESULT:' + JSON.stringify(results) + '\\n');"
    ].join('\n');
    const executionTimeoutMs = remaining(100);
    persistentBudget?.beforeDispatch(persistentTicket, suiteSha256);
    const container = await executeContainer({
      code: harness,
      inputs: {
        'candidate.mjs': input.artifactSource,
        'cases.json': JSON.stringify(runtimeCases)
      },
      ...(dockerPath ? { dockerPath } : {}),
      timeoutMs: executionTimeoutMs
    });
    // Synchronous container/cleanup calls cannot be preempted by a JS timer.
    // A late response must still never be accepted as a passing evaluation.
    remaining(1);
    const rows = parseResultRows(container.stdout, cases);
    const actualById = new Map(rows.map(row => [row.id, row.actual]));
    const caseResults = cases.map(item => ({
      id: item.id,
      passed: actualById.has(item.id) && canonical(actualById.get(item.id)) === canonical(item.expected),
      expectedSha256: sha256(canonical(item.expected)),
      actualSha256: actualById.has(item.id) ? sha256(canonical(actualById.get(item.id))) : null
    }));
    remaining(1);
    const isolated = container?.status === 'completed'
      && container.actualContainerExecution === true
      && container.enforcementVerified === true;
    const passed = isolated && rows.length === cases.length && caseResults.every(item => item.passed);
    const monetaryPolicy = persistentBudget?.status().monetaryPolicy;
    const costObservation = monetaryPolicy ? structuredClone(await beforeDeadline(signal => observeEvaluationCost(Object.freeze({
      stageId: input.stageId, packageDigest: input.packageDigest, artifactSha256: input.artifactSha256,
      preparationId:persistentTicket?.preparationId??null,costScope:persistentTicket?.preparationId?'preparation-and-evaluation':'evaluation-only',
      costPolicyId: monetaryPolicy.costPolicyId, maxCostMinor: monetaryPolicy.maxCostMinor,
      executionDurationMs: container.durationMs, elapsedMs: performance.now() - startedAt
    }), {signal}), remaining(1))) : null;
    const receipt = {
      schemaVersion: 'a-capability-package-isolated-evaluation-v1',
      resultChannelVersion:RESULT_CHANNEL_VERSION,
      resultContract,
      preparationId:persistentTicket?.preparationId??null,
      costScope:persistentTicket?.preparationId?'preparation-and-evaluation':'evaluation-only',
      suiteId,
      suiteSha256,
      requirementContractSha256: requirements?.sha256 ?? null,
      requirementIds: requirements?.value.requirements.map(r => r.id) ?? [],
      evaluationTiming: { configuredTimeoutMs: timeoutMs, executionTimeoutMs, elapsedMs: performance.now() - startedAt },
      packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256,
      containerImageId: container.restrictions?.imageId ?? null,
      isolationEnforced: isolated,
      status: passed ? 'passed' : 'failed',
      caseCount: cases.length,
      passedCount: caseResults.filter(item => item.passed).length,
      failedCaseIds: caseResults.filter(item => !item.passed).map(item => item.id),
      caseResults,
      durationMs: container.durationMs,
      costObservation,
      costPolicyId: monetaryPolicy?.costPolicyId ?? null,
      stdoutSha256: container.stdoutSha256,
      restrictions: container.restrictions,
      limitations: container.limitations
    };
    const evidenceRef = `sha256:${sha256(canonical(receipt))}`;
    remaining(1);
    const result = {
      status: passed ? 'passed' : 'failed',
      actualIsolatedExecution: isolated,
      packageDigest: input.packageDigest,
      artifactSha256: input.artifactSha256,
      evidenceRef,
      receipt
    };
    persistentBudget?.finish(persistentTicket, result, () => remaining(1), costObservation);
    return assertCurrentResultChannel(result);
    } catch (error) {
      try { persistentBudget?.failed(persistentTicket); } catch (accountingError) { error.accountingFailure = accountingError.code ?? accountingError.message; }
      throw error;
    }
  };
  Object.defineProperty(evaluate, 'budgetStatus', { value: () => Object.freeze({ configured: maxEvaluations !== null,
    maxEvaluations, attempts, remaining: maxEvaluations === null ? null : Math.max(0, maxEvaluations - attempts),
    scope: 'evaluator-instance', actualCost: null }) });
  Object.defineProperty(evaluate, 'persistentBudgetStatus', { value: () => persistentBudget?.status() ?? null });
  Object.defineProperty(evaluate,'improvementPolicy',{value:()=>{
    if(!persistentBudget||!requirements)return null;
    const status=persistentBudget.status();
    if(status.requirementContractSha256!==requirements.sha256)return null;
    return{schemaVersion:'a-improvement-evaluation-policy-v1',mandateId:status.mandateId,suiteSha256:status.suiteSha256,
      requirementContractSha256:requirements.sha256,maxTimeoutMs:timeoutMs,maxCalls:status.maxCalls,totalMinor:status.totalMinor,
      monetaryPolicy:status.monetaryPolicy,resultContract,comparison:null,preparationReservation:'before-research-and-generation'};
  }});
  if(persistentBudget&&requirements){
    Object.defineProperty(evaluate,'prepareImprovement',{value:id=>persistentBudget.prepare(id)});
    Object.defineProperty(evaluate,'attachImprovementPreparation',{value:(stageId,ticket)=>{persistentBudget.assertPreparation(ticket);if(preparations.has(stageId))throw Object.assign(new Error('Preparation already attached'),{code:'A_EVALUATION_PREPARATION_USED'});preparations.set(stageId,ticket);}});
    Object.defineProperty(evaluate,'abandonImprovementPreparation',{value:ticket=>persistentBudget.abandonPreparation(ticket)});
  }
  if(persistentBudget) Object.defineProperty(evaluate,'restoreCompleted',{value:input=>{
    if(typeof input?.artifactSource!=='string'||sha256(input.artifactSource)!==input.artifactSha256)
      throw Object.assign(new Error('Recovery artifact digest mismatch'),{code:'A_CAPABILITY_PACKAGE_ARTIFACT_DIGEST_MISMATCH'});
    const result=persistentBudget.readCompleted({stageId:input.stageId,requirementContractSha256:requirements?.sha256??null,
      artifactSha256:input.artifactSha256,packageDigest:input.packageDigest,toolName:input.toolName,
      manifest:{packageId:input.manifest?.packageId,version:input.manifest?.version}},timeoutMs);
    if((result.receipt?.resultContract??null)!==resultContract)throw Object.assign(new Error('Recovery result contract changed'),{code:'A_EVALUATION_RECEIPT_CONFLICT'});
    return assertCurrentResultChannel(result);
  }});
  if(persistentBudget)for(const method of ['recordComparison','readComparison'])Object.defineProperty(evaluate,method,{value:(input,configuration,result)=>
    persistentBudget[method]({...input,requirementContractSha256:requirements?.sha256??null},timeoutMs,configuration,result)});
  return evaluate;
}

function evaluationDeadline() {
  return Object.assign(new Error('Host evaluation deadline exhausted'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_DEADLINE' });
}
async function beforeDeadline(operation, timeoutMs) {
  let timer; const controller = new AbortController();
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((resolve, reject) => {
      timer = setTimeout(() => { const error = evaluationDeadline(); controller.abort(error); reject(error); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function validateSuite(suite) {
  if (!suite || typeof suite.suiteId !== 'string' || !suite.suiteId.trim()
    || !Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > 100) {
    throw Object.assign(new Error('Evaluation suite must include 1..100 cases and a suiteId.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_SUITE_INVALID' });
  }
  const seen = new Set();
  for (const item of suite.cases) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)
      || !['shadow', 'execute'].includes(item.method)
      || !item.args || typeof item.args !== 'object' || Array.isArray(item.args)
      || !item.packet || typeof item.packet !== 'object' || Array.isArray(item.packet)
      || !Object.hasOwn(item, 'expected')) {
      throw Object.assign(new Error('Evaluation cases must be unique, typed adapter inputs with expected oracle values.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_SUITE_INVALID' });
    }
    seen.add(item.id);
  }
  if (!isJsonValue(suite.cases)) {
    throw Object.assign(new Error('Evaluation cases must contain finite plain JSON values.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_SUITE_INVALID' });
  }
  const encoded = JSON.stringify(suite.cases);
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) {
    throw Object.assign(new Error('Evaluation suite exceeds the 1 MiB cap.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_SUITE_TOO_LARGE' });
  }
  // Neither provider-owned references nor dispatch can revise the host oracle.
  return JSON.parse(encoded);
}

function isJsonValue(value, depth = 0, ancestors = new Set()) {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const valid = Reflect.ownKeys(descriptors).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = descriptors[key];
    return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value') && isJsonValue(descriptor.value, depth + 1, ancestors);
  }) && (!Array.isArray(value) || Object.keys(value).length === value.length);
  ancestors.delete(value);
  return valid;
}

function parseResultRows(stdout, cases) {
  const lines = String(stdout ?? '').split(/\r?\n/u).filter(line => line.startsWith('JARVIS_PACKAGE_RESULT:'));
  if (lines.length !== 1) throw Object.assign(new Error('Isolated package did not produce exactly one result envelope.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID' });
  const encoded = lines[0].slice('JARVIS_PACKAGE_RESULT:'.length);
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) throw Object.assign(new Error('Isolated package result exceeds the size limit.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID' });
  let value;
  try { value = JSON.parse(encoded); }
  catch { throw Object.assign(new Error('Isolated package result is not valid JSON.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID' }); }
  const expectedIds = new Set(cases.map(item => item.id));
  const seen = new Set();
  if (!Array.isArray(value) || value.length !== cases.length || !isJsonValue(value) || value.some(item => {
    if (!item || typeof item.id !== 'string' || !expectedIds.has(item.id) || seen.has(item.id)
      || !Object.hasOwn(item, 'actual') || Object.keys(item).length !== 2) return true;
    seen.add(item.id);
    return false;
  })) {
    throw Object.assign(new Error('Isolated package result envelope is malformed.'), { code: 'A_CAPABILITY_PACKAGE_EVALUATION_RESULT_INVALID' });
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
