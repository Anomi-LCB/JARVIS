import {microsoftCollectionGoalBound} from './microsoft-collection-result.js';
import {normalizeMicrosoftCollection} from '../personal-operations/microsoft-collection-request.js';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {MacroStore} from '../macro-store.js';
import { readFileSync, realpathSync } from 'node:fs';
import { compileNaturalWorkflowObjective } from './natural-workflow-compiler.js';
import { extractLocalWorkflowSpecPath } from './workflow-natural-compiler.js';
import { verifyLocalWorkflowConstraints } from './mission-local-workflow-constraints.js';
import { assessTextSummarySequence } from './mission-text-summary-coverage.js';
import {parseLiteralTextFileBatch,isLiteralTextFileAttempt} from '../planning/literal-text-file-request.js';
import { classifyMissionEffectScope } from './mission-effect-scope.js';
import { validateWorkflowSpec } from './workflow-ir.js';
import { isLocalOnlyWorkflowSpec } from './mission-local-workflow-constraints.js';
import {verifyReadOnlyListing} from './read-only-listing-proof.js';
import {verifyReadOnlyText} from './read-only-text-proof.js';
import {researchSourceCoverage} from './research-source-workflow.js';
import {createGoalContract} from './goal-contract.js';
import {externalSourceClauseBound} from './external-source-clause.js';
import {selectedSourceGoalBound} from './selected-source-result.js';
import {normalizeSelectedSourceRequest} from '../personal-operations/selected-source-stream.js';
import {documentParagraphRevisionCoverage} from './document-paragraph-revision-coverage.js';

const invalid = () => { throw Object.assign(new Error('Invalid goal requirement links.'), { code: 'A_MISSION_REQUIREMENT_LINK_INVALID' }); };

export function normalizeActionRequirementLinks(action, contract) {
  const known = new Set((contract?.requirements ?? []).map(item => item.requirementId));
  const constraints = new Set((contract?.constraints ?? []).map(item => item.requirementId));
  const result = {};
  for (const key of ['requirementIds', 'constraintRequirementIds']) {
    const values = action[key] ?? [];
    if (!Array.isArray(values) || values.length > 64 || new Set(values).size !== values.length
      || values.some(value => typeof value !== 'string' || !known.has(value))) invalid();
    if (key === 'constraintRequirementIds' && values.some(value => !constraints.has(value))) invalid();
    result[key] = [...values];
  }
  if (result.requirementIds.some(id => result.constraintRequirementIds.includes(id))) invalid();
  if (result.requirementIds.some(id => contract.requirements.some(item => item.requirementId === id
    && item.interpretation?.status === 'recognized' && item.interpretation.polarity === 'prohibited'))) invalid();
  return result;
}

function toolFamily(tool) {
  if (tool === 'email.send') return 'send';
  if (['filesystem.listFiles', 'filesystem.searchFiles'].includes(tool)) return 'list';
  if (tool === 'document.edit') return 'change';
  if (['filesystem.readText','document.readPdf','excel.readWorkbook'].includes(tool)) return 'read';
  if (['filesystem.createTextFile', 'word.create', 'hwp.create', 'excel.createWorkbook','excel.exportPdf', 'powerpoint.create', 'archive.createZip'].includes(tool)) return 'save';
  if (['filesystem.deleteFile', 'filesystem.deleteFiles'].includes(tool)) return 'delete';
  return null;
}
function compatible(requirement, action) {
  const family = toolFamily(action.actualToolName ?? action.expectedToolName);
  const understood = requirement.interpretation?.status === 'recognized';
  return understood && family === requirement.interpretation.action;
}
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function filePath(value, roots) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || !roots.length) return null;
  const path = isAbsolute(value) ? resolve(value) : resolve(roots[0], value);
  return roots.some(root => inside(root, path)) ? path : null;
}
function sourcePath(requirement, roots) {
  const target = requirement.interpretation?.target;
  // An alias such as "초안" needs a separate trusted resolver. A model-provided
  // requirement ID or filename in the email body is not that proof.
  if (typeof target !== 'string' || !/\.[\p{L}\p{N}]{1,16}$/u.test(target) || /[<>*?|]/.test(target)) return null;
  return filePath(target, roots);
}
function refPath(ref, roots) {
  if (!Number.isInteger(ref?.rootIndex) || ref.rootIndex < 0 || ref.rootIndex >= roots.length
    || typeof ref.relativePath !== 'string' || isAbsolute(ref.relativePath)) return null;
  const path = resolve(roots[ref.rootIndex], ref.relativePath);
  return inside(roots[ref.rootIndex], path) ? path : null;
}
function argumentPath(action, args, roots) {
  const tool = action.actualToolName ?? action.expectedToolName;
  return filePath(['excel.createWorkbook','excel.exportPdf'].includes(tool) ? args?.outputPath : args?.path, roots);
}
function argumentPaths(action,args,roots) {
  const first=argumentPath(action,args,roots);
  const tool=action.actualToolName??action.expectedToolName;
  const pdf=tool==='excel.createWorkbook'&&args?.renderPdf===true?filePath(args.pdfOutputPath,roots):null;
  return [first,pdf].filter(Boolean);
}
const pathKey=path=>process.platform==='win32'?path.toLowerCase():path;
// A lexical alternative name is not proof that a protected file is untouched.
// Resolve existing aliases (or the nearest existing parent for a new output).
// Metadata lookup errors and paths outside physical allowed roots remain unknown.
function scopedPhysicalPath(file,roots){
  if(!file)return null;
  try{
    let parent=file,physical;
    while(true){
      try{physical=resolve(realpathSync.native(parent),relative(parent,file));break;}
      catch(error){if(error.code!=='ENOENT'||dirname(parent)===parent)return null;parent=dirname(parent);}
    }
    if(!roots.some(root=>inside(realpathSync.native(root),physical)))return null;
    return pathKey(physical);
  }catch{return null;}
}
function explicitLocalTextTargetBound(mission,requirement,action,args,roots){
  const tool=action.actualToolName??action.expectedToolName;
  if(tool!=='filesystem.createTextFile'||requirement.interpretation?.action!=='save'
    ||requirement.interpretation?.polarity!=='required'||!externalSourceClauseBound(mission,requirement))return false;
  const requested=sourcePath(requirement,roots),actual=argumentPath(action,args,roots);
  return requested!==null&&actual!==null&&pathKey(requested)===pathKey(actual);
}
function localTextSaveAvoidsProhibition(mission,requirement,action,args,roots){
  if((action.actualToolName??action.expectedToolName)!=='filesystem.createTextFile'
    ||requirement.interpretation?.action!=='save'||requirement.interpretation?.polarity!=='prohibited'
    ||!externalSourceClauseBound(mission,requirement))return false;
  const protectedPath=scopedPhysicalPath(sourcePath(requirement,roots),roots),actual=scopedPhysicalPath(argumentPath(action,args,roots),roots);
  return protectedPath!==null&&actual!==null&&protectedPath!==actual;
}
function observationFor(mission, action) {
  return mission.observations.find(item => item.observationId === action.observationId);
}
function observedFiles(mission, action, roots) {
  const observation = observationFor(mission, action);
  if(action.actualToolName==='document.readPdf'&&(observation?.data?.pdfRead?.firstPage!==1||observation?.data?.pdfRead?.truncated!==false))return [];
  if(action.actualToolName==='excel.readWorkbook'&&(observation?.data?.xlsxRead?.hasCellsOutsideRange!==false||observation?.data?.xlsxRead?.otherSheetCount!==0))return [];
  const items = ['filesystem.readText','document.readPdf','excel.readWorkbook'].includes(action.actualToolName)
    ? [observation?.data?.fileEvidence] : observation?.artifacts ?? [];
  return items.filter(item => item?.outsideAllowedRoots === false && sha(item.contentSha256))
    .map(item => ({ path: refPath(item, roots), sha256: sha(item.contentSha256) })).filter(item => item.path);
}
function boundPredecessor(mission, requirement, candidate, roots, provisional) {
  if (!compatible(requirement, candidate)) return false;
  const expected = sourcePath(requirement, roots);
  if (!expected) return false;
  if (provisional && !verifiedAction(mission, candidate)) return argumentPaths(candidate, candidate.arguments, roots).includes(expected);
  const dispatch = candidate.operation?.dispatch;
  return verifiedAction(mission, candidate) && dispatch?.taskId === candidate.taskId
    && dispatch.toolName === candidate.actualToolName && argumentPaths(candidate, dispatch.arguments, roots).includes(expected)
    && observedFiles(mission, candidate, roots).some(item => item.path === expected);
}
function emailTargets(args, roots) {
  // Reject alternate attachment selectors here: they can resolve additional files
  // later, outside the source binding checked at this boundary.
  if (!Array.isArray(args?.attachments) || !args.attachments.length
    || ['attachmentPath', 'attachmentQuery', 'attachmentRef', 'attachmentSha256'].some(key => args[key] != null)) return null;
  const result = args.attachments.map(item => ({ path: refPath(item?.attachmentRef, roots), sha256: sha(item?.attachmentSha256) }));
  return result.every(item => item.path && item.sha256) && new Set(result.map(item => item.path)).size === result.length ? result : null;
}
function emailRecipientBound(mission, requirement, args) {
  // Re-derive from the exact source clause: older persisted interpretations
  // have no recipient field, and planner metadata cannot supply this proof.
  const source=mission.goalContract?.objective,span=requirement.sourceSpan;
  if(typeof source!=='string'||source!==mission.objective||!span||source.slice(span.start,span.end)!==requirement.text)return false;
  let interpretation;
  try{const contract=createGoalContract({objective:requirement.text});
    if(contract.requirements.length!==1)return false;interpretation=contract.requirements[0].interpretation;
  }catch{return false;}
  if(interpretation.status!=='recognized'||interpretation.action!=='send')return false;
  const requested=interpretation.emailRecipient,to=typeof args?.to==='string'?args.to.trim():args?.to==null?'':null;
  if(to===null)return false;
  const mode=args?.recipientMode;
  if(requested?.mode==='address'){
    if(mode!==undefined&&mode!=='explicit')return false;
    const mailbox=value=>{const match=/^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(value);return match?`${match[1]}@${match[2].toLowerCase()}`:null;};
    return mailbox(to)!==null&&mailbox(to)===mailbox(requested.address);
  }
  // A self request must go through the adapter's configured identity resolver.
  // A nonempty explicit address overrides that resolver in the email adapter.
  if(requested?.mode!=='self')return false;
  if(mode!==undefined&&mode!=='self')return false;
  return to===''||/^self$/i.test(to);
}
function verifiedAction(mission, action) {
  if (action.status !== 'succeeded' || !action.observationId) return false;
  const observation = mission.observations.find(item => item.observationId === action.observationId);
  return observation?.actionId === action.actionId && observation.taskId === action.taskId
    && observation.toolName === action.actualToolName && observation.outcome === 'success'
    && observation.verification?.status === 'passed' && typeof observation.verification?.verificationId === 'string'
    && !(observation.verification.failedCheckIds?.length)
    && observation.verification.verificationId.length > 0 && typeof observation.evidenceId === 'string' && observation.evidenceId.length > 0;
}
export {verifiedAction as verifiedMissionAction};
function weatherSourceBinding(mission,action,args,tool,roots){
  if(tool!=='weather.createHwpReport')return null;
  const region=/^지역\s*[:：]\s*([가-힣 ]{1,40}?)\s+향후\s*7일\s+날씨\s+통계를\s+한글\s+보고서로\s+만들어줘[.!]?$/u.exec(mission.objective.trim())?.[1]?.trim();
  const actions=mission.waves.flatMap(w=>w.actions);
  const bound=Boolean(region&&args?.location===region&&filePath(args.path,roots)
    &&/\.hwpx?$/i.test(args.path)&&actions.length===1&&actions[0].actionId===action.actionId
    &&!mission.constraints?.length&&!mission.goalContract?.constraints?.length&&!mission.goalContract?.contradictions?.length
    &&!mission.goalContract?.revisionChange?.effectConflicts?.length&&!mission.goalContract?.revisionChange?.invalidatedCriterionIds?.length);
  return {required:true,allowed:bound,sourceBindingVerified:bound,semanticAccuracyVerified:false,
    coveredRequirementIds:bound?mission.goalContract.requirements.map(r=>r.requirementId):[],
    reasons:bound?[]:[{code:'weather-whole-request-binding-unresolved'}],resultCriteriaVerificationRequired:true};
}
function macroSourceBinding(mission,action,args,tool){
  if(tool!=='macro.save')return null;
  const actions=mission.waves.flatMap(w=>w.actions),raw=mission.objective.trim();
  const parsed=MacroStore.prototype.parseSave.call(MacroStore.prototype,raw);
  const bound=Boolean(parsed&&args?.rawText===raw&&actions.length===1&&actions[0].actionId===action.actionId
    &&!mission.constraints?.length&&!mission.goalContract?.constraints?.length&&!mission.goalContract?.contradictions?.length
    &&!mission.goalContract?.revisionChange?.effectConflicts?.length&&!mission.goalContract?.revisionChange?.invalidatedCriterionIds?.length);
  return {required:true,allowed:bound,sourceBindingVerified:bound,semanticAccuracyVerified:false,
    coveredRequirementIds:bound?mission.goalContract.requirements.map(r=>r.requirementId):[],
    reasons:bound?[]:[{code:'macro-whole-request-binding-unresolved'}],resultCriteriaVerificationRequired:true};
}
// This source binding proves only a whole, explicit filename-creation batch.
// Content and layout still require the existing independent result criteria.
function creationBatchCoverage({mission, roots, phase, currentAction, dispatchArguments, dispatchToolName}) {
  const contract=mission.goalContract, requirements=contract?.requirements??[];
  if(!requirements.some(item=>item.interpretation?.creation===true||item.interpretation?.creationAttempt===true))return null;
  const rejected=()=>({allowed:false,required:true,sourceBindingVerified:false,
    reasons:[{code:'creation-whole-request-binding-unresolved'}],coveredRequirementIds:[],
    nextAction:'모든 파일명·형식과 추가 지시를 함께 확인해야 합니다. 일부 파일만 먼저 만들지 않습니다.'});
  if(contract.objective!==mission.objective||!roots.length||mission.constraints?.length||contract.constraints?.length
    ||contract.contradictions?.length||contract.amounts?.length||contract.times?.length
    ||contract.revisionChange?.effectConflicts?.length||contract.revisionChange?.invalidatedCriterionIds?.length
    ||contract.unresolvedCriterionIds?.length
    ||requirements.some(item=>item.interpretation?.creation!==true||item.interpretation.status!=='recognized'
      ||item.interpretation.polarity!=='required'||item.interpretation.compound||item.interpretation.hasExclusion
      ||item.interpretation.hasProhibition||item.interpretation.correction||item.interpretation.unresolvedReferences?.length))return rejected();
  const targets=requirements.map(item=>sourcePath(item,roots));
  const pathKey=path=>process.platform==='win32'?path.toLowerCase():path;
  if(targets.some(path=>!path)||new Set(targets.map(pathKey)).size!==targets.length)return rejected();
  const actions=(mission.waves??[]).flatMap(wave=>wave.actions??[]);
  const toolExtensions={'filesystem.createTextFile':['txt','md','csv','json'],'word.create':['docx','pdf'],
    'hwp.create':['hwpx'],'excel.createWorkbook':['xlsx'],'excel.exportPdf':['pdf'],'powerpoint.create':['pptx']};
  const produced=[];
  for(const action of actions){
    const completion=phase==='completion',dispatch=action.operation?.dispatch;
    const isCurrent=action===currentAction;
    const tool=isCurrent&&dispatchToolName?dispatchToolName:completion?action.actualToolName:action.actualToolName??action.expectedToolName;
    const args=isCurrent&&dispatchArguments?dispatchArguments:completion?dispatch?.arguments:action.arguments;
    if(tool==='excel.createWorkbook'&&((args?.renderPdf===true&&typeof args.pdfOutputPath!=='string')
      ||(args?.pdfOutputPath!==undefined&&args.renderPdf!==true)))return rejected();
    const paths=argumentPaths({...action,actualToolName:tool},args,roots);
    if(!toolExtensions[tool]||!paths.length||!toolExtensions[tool].includes(paths[0].split('.').at(-1).toLowerCase())
      ||paths.some(path=>!targets.includes(path)))return rejected();
    if(completion&&(!verifiedAction(mission,action)||dispatch?.taskId!==action.taskId||dispatch.toolName!==tool
      ||paths.some(path=>!observedFiles(mission,action,roots).some(file=>file.path===path))))return rejected();
    produced.push(...paths);
  }
  if(produced.length!==targets.length||new Set(produced.map(pathKey)).size!==produced.length
    ||targets.some(path=>!produced.includes(path)))return rejected();
  return {allowed:true,required:true,sourceBindingVerified:true,status:'explicit-creation-batch-source-binding',
    reasons:[],coveredRequirementIds:requirements.map(item=>item.requirementId),
    evidenceActionIds:actions.map(action=>action.actionId),resultCriteriaVerificationRequired:true,
    semanticAccuracyVerified:false,executionAuthority:false};
}
function ancestors(wave, action) {
  const found = new Set(), pending = [...action.dependencies];
  while (pending.length) {
    const id = pending.pop();
    if (found.has(id)) continue;
    found.add(id);
    const parent = wave.actions.find(item => item.actionId === id);
    if (parent) pending.push(...parent.dependencies);
  }
  return found;
}

function verifyTrustedLocalWorkflowBinding({ mission, action, contract, currentLinks, roots, phase, dispatchArguments }) {
  const reject = () => null;
  const history = mission.planHistory ?? [];
  const latestPlanning = history.at(-1)?.planning;
  const trustedCompilation = latestPlanning?.provider === 'local-workflow-compiler'
    && (latestPlanning.reason === 'local-workflow-execute'
      || (phase === 'completion' && latestPlanning.reason === 'local-workflow-complete'
        && history.at(-2)?.planning?.provider === 'local-workflow-compiler'
        && history.at(-2)?.planning?.reason === 'local-workflow-execute'));
  if (!trustedCompilation
    || (action.actualToolName ?? action.expectedToolName) !== 'workflow.execute'
    || contract?.contradictions?.length || contract?.unresolvedCriterionIds?.length || !roots.length) return reject('trust-or-contract');
  const expectedRequirements = (contract.requirements ?? [])
    .filter(item => !(contract.constraints ?? []).some(constraint => constraint.requirementId === item.requirementId))
    .map(item => item.requirementId).sort();
  const expectedConstraints = (contract.constraints ?? []).map(item => item.requirementId).sort();
  if (!sameIds(currentLinks.requirementIds, expectedRequirements)
    || !sameIds(currentLinks.constraintRequirementIds, expectedConstraints)
    || (contract.requirements ?? []).some(item => item.interpretation?.correction || item.interpretation?.unresolvedReferences?.length)) return reject('links-or-references');

  const args = dispatchArguments ?? action.arguments ?? {};
  const selectedPath = extractLocalWorkflowSpecPath(mission.objective, roots[0]);
  if (!selectedPath || typeof args.specPath !== 'string' || typeof args.expectedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/iu.test(args.expectedSha256)) return reject('spec-args');
  let spec;
  try {
    const selectedRealPath = realpathSync.native(selectedPath);
    const actionRealPath = realpathSync.native(args.specPath);
    if (selectedRealPath !== actionRealPath || !roots.some(root => inside(root, actionRealPath))) return reject('spec-path');
    const bytes = readFileSync(actionRealPath);
    if (createHash('sha256').update(bytes).digest('hex') !== args.expectedSha256.toLowerCase()) return reject('spec-hash');
    spec = validateWorkflowSpec(JSON.parse(bytes.toString('utf8')));
    if (!isLocalOnlyWorkflowSpec(spec)) return reject('spec-not-local');
  } catch { return reject('spec-invalid'); }

  const exactSourceConstraints = (contract.constraints ?? []).every(constraint => {
    const source = String(constraint.text ?? '').trim();
    return /shell\.execute/u.test(source) && /강등/u.test(source)
      && /추측/u.test(source) && /만들지\s*마/u.test(source)
      && currentLinks.constraintRequirementIds.includes(constraint.requirementId);
  });
  if (!exactSourceConstraints) return reject('source-constraints');
  const constraintProof = verifyLocalWorkflowConstraints({ mission, action, spec, roots, phase });
  if (!constraintProof.passed) return reject();
  return {
    allowed: true,
    coveredRequirementIds: [...currentLinks.requirementIds, ...currentLinks.constraintRequirementIds],
    evidence: currentLinks.requirementIds.map(requirementId => ({ requirementId, actionId: action.actionId,
      basis: 'deterministic-typed-local-workflow-spec' })),
    constraintChecks: constraintProof.checks
  };
}

function sameIds(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === expected[index]);
}
function inlineNaturalSourceBinding({mission,action,args,roots,phase}){
  const contract=mission.goalContract;
  if((action.actualToolName??action.expectedToolName)!=='workflow.execute'||!roots.length
    ||contract?.objective!==mission.objective||contract.contradictions?.length||contract.unresolvedCriterionIds?.length
    ||contract.revisionChange?.effectConflicts?.length||contract.revisionChange?.invalidatedCriterionIds?.length
    ||(!(contract.constraints?.length)&&!contract.requirements?.some(r=>r.interpretation?.unresolvedReferences?.length||isSinglePersonSelection(r)))
    ||contract.constraints.some(item=>item.kind!=='exclusion')||args?.specPath!==undefined||args?.allowOverwrite===true
    ||typeof args?.workspaceRoot!=='string'||resolve(args.workspaceRoot)!==roots[0])return null;
  let compiled;
  try{compiled=compileNaturalWorkflowObjective(mission.objective,{workspaceRoot:roots[0]});}catch{return null;}
  if(compiled.status!=='compiled'||!compiled.spec||!isLocalOnlyWorkflowSpec(compiled.spec)
    ||!isDeepStrictEqual(args.spec,compiled.spec)||compiled.clauses.length!==contract.requirements.length)return null;
  if(!contract.requirements.every((r,i)=>!r.interpretation?.correction
    &&(!r.interpretation?.unresolvedReferences?.length
      ||(compiled.goalContract.requirements[i].interpretation.unresolvedReferences.length===0
        &&compiled.goalContract.requirements[i].interpretation.resolvedReferences?.length))))return null;
  if(!compiled.clauses.every((clause,index)=>clause.status==='compiled'
    &&clause.requirementId===contract.requirements[index].requirementId&&clause.sourceText===contract.requirements[index].text
    &&mission.objective.slice(contract.requirements[index].sourceSpan.start,contract.requirements[index].sourceSpan.end)===clause.sourceText))return null;
  // Exclusion clauses must compile to the single bounded exact-string filter.
  if(!(contract.constraints??[]).every(constraint=>{
    const clause=compiled.clauses.find(c=>c.requirementId===constraint.requirementId);
    const nodes=compiled.spec.nodes.filter(node=>clause?.nodeIds.includes(node.id));
    return nodes.length===1&&nodes[0].op==='data.filter'&&nodes[0].args.where?.operator==='ne'
      &&typeof nodes[0].args.where.value==='string';
  }))return null;
  const constraintProof=verifyLocalWorkflowConstraints({mission,action,spec:compiled.spec,roots,phase});
  if(!constraintProof.passed)return null;
  return {allowed:true,required:true,sourceBindingVerified:true,status:'inline-natural-source-binding',
    coveredRequirementIds:contract.requirements.map(r=>r.requirementId),missingRequirementIds:[],
    evidence:compiled.clauses.map(c=>({requirementId:c.requirementId,nodeIds:c.nodeIds,basis:'exact-whole-source-compiled-spec'})),
    constraintChecks:constraintProof.checks,
    semanticAccuracyVerified:false,executionAuthority:false,resultCriteriaVerificationRequired:true};
}
function isSinglePersonSelection(requirement){
  return typeof requirement?.text==='string'&&/사람 한 명(?:을|만)\s+['"]/u.test(requirement.text)&&/골라/u.test(requirement.text);
}

/** Provenance and ordering guard. G proves an earlier tool result, not arbitrary source semantics. */
function installedMcpSourceBinding({mission,action,toolName,args,binding}) {
  const contract=mission.goalContract, requirements=contract?.requirements??[];
  if(!binding||binding.toolName!==toolName||typeof binding.verify!=='function'
    ||!/^mcp\./u.test(toolName??'')||requirements.length!==1||contract.objective!==mission.objective
    ||requirements[0].sourceSpan?.start!==0||requirements[0].sourceSpan?.end!==mission.objective.length
    ||contract.contradictions?.length||contract.constraints?.length||mission.constraints?.length
    ||contract.amounts?.length||contract.times?.length||contract.revisionChange?.effectConflicts?.length
    ||contract.revisionChange?.invalidatedCriterionIds?.length
    ||requirements.some(item=>item.interpretation?.hasProhibition||item.interpretation?.hasExclusion||item.interpretation?.correction||item.interpretation?.unresolvedReferences?.length)
    ||(mission.successCriteria??[]).some(criterion=>criterion.statement!==mission.objective)
    ||args?.objective!==mission.objective)return null;
  try{
    if(!binding.verify({...args,toolName}))return null;
    return {allowed:true,sourceBindingVerified:true,coveredRequirementIds:requirements.map(item=>item.requirementId),
      evidence:[{requirementId:requirements[0].requirementId,basis:'installed-mcp-whole-request-binding',resolverFingerprint:binding.fingerprint}],
      resultCriteriaVerificationRequired:true,executionAuthority:false};
  }catch{return null;}
}

export function assessMissionRequirementCoverage({ mission, wave, action, profile, phase = 'dispatch', dispatchToolName, dispatchArguments, allowedRoots = [], installedIntentBinding = null, temporalBindingResolver = null, microsoftRequestBindingResolver = null }) {
  const effectScope = classifyMissionEffectScope({ action, profile, dispatchToolName,
    arguments: dispatchArguments ?? action.operation?.dispatch?.arguments ?? action.arguments,
    allowedRoots: allowedRoots.length ? allowedRoots : [mission.workspaceRoot].filter(Boolean) });
  const contract = mission.goalContract;
  const sourceRequirements = contract?.requirements ?? [];
  const actionFamily = toolFamily(action.actualToolName ?? dispatchToolName ?? action.expectedToolName);
  const localUnresolvedConstraint = effectScope.scope === 'structured-local' && profile.mutatesSystem === true
    && sourceRequirements.some(item => (item.interpretation?.hasProhibition && item.interpretation.status !== 'recognized')
      || item.interpretation?.hasExclusion || item.interpretation?.correction
      || item.interpretation?.unresolvedReferences?.length);
  // Local structured effects also need source-contract checks when the request
  // is contradictory, prohibition/exclusion/correction semantics remain unresolved,
  // or the selected adapter would perform a specifically prohibited action.
  const localGoalGuard = effectScope.scope === 'structured-local' && (
    Boolean(contract?.contradictions?.length)
    || sourceRequirements.some(item => item.interpretation?.status === 'recognized'
      && item.interpretation.polarity === 'prohibited' && item.interpretation.action === actionFamily)
    || localUnresolvedConstraint
    || (profile.mutatesSystem===true&&sourceRequirements.some(isSinglePersonSelection))
  );
  const required = ['opaque', 'external'].includes(effectScope.scope) || profile.externalTransfer === true || profile.executionClass === 'external_commit'
    || localGoalGuard
    || (profile.externalNetwork === true && profile.readOnly !== true);
  const base = { version: 'a-mission-requirement-coverage-v1', phase, required,
    effectScope, semanticAccuracyVerified: false, executionAuthority: false };
  // Reparse the authoritative request: a planner's "continue" or read-only
  // label cannot establish a user predicate. Independently requested local
  // reads may continue, but must bind to an unconditional clause and its IDs.
  let currentSource;
  try { currentSource=createGoalContract({objective:mission.objective}); } catch { currentSource=null; }
  const conditionalRequirements=currentSource?.requirements.filter(r=>r.interpretation.unresolvedConditions?.length)??[];
  const conditionalAction=conditionalRequirements.length&&(!Array.isArray(action.requirementIds)||!action.requirementIds.length
    ||action.requirementIds.some(id=>conditionalRequirements.some(r=>r.requirementId===id)));
  if(mission.microsoftCollection){
    let allowed=false;
    try{const request=normalizeMicrosoftCollection(dispatchArguments??action.operation?.dispatch?.arguments??action.arguments);
      allowed=microsoftCollectionGoalBound(mission)&&(dispatchToolName??action.actualToolName??action.expectedToolName)==='source.collectMicrosoftMetadata'
        &&profile.externalTransfer!==true&&(mission.microsoftCollection.version==='microsoft-collection-pages-goal-v1'
          ?typeof microsoftRequestBindingResolver==='function'&&microsoftRequestBindingResolver(request)===true:isDeepStrictEqual(request,mission.microsoftCollection.request));
    }catch{}
    return {...base,required:true,allowed,sourceBindingVerified:allowed,reasons:allowed?[]:[{code:'microsoft-collection-original-request-unbound'}],coveredRequirementIds:allowed?sourceRequirements.map(r=>r.requirementId):[]};
  }
  if(mission.selectedSource){
    let allowed=false;
    try{
      const {rawText,...args}=dispatchArguments??action.operation?.dispatch?.arguments??action.arguments;
      const request=normalizeSelectedSourceRequest(args);
      allowed=selectedSourceGoalBound(mission)&&(dispatchToolName??action.actualToolName??action.expectedToolName)==='source.readSelectedInbox'
        &&profile.contractReadOnly===true&&profile.mutatesSystem!==true&&profile.externalTransfer!==true
        &&request.provider===mission.selectedSource.provider&&request.streamRef===mission.selectedSource.streamRef;
    }catch{}
    return {...base,required:true,allowed,sourceBindingVerified:allowed,
      reasons:allowed?[]:[{code:'selected-source-original-request-unbound'}],coveredRequirementIds:allowed?sourceRequirements.map(r=>r.requirementId):[]};
  }
  // A source time is not proof that a scheduled or deadline-constrained effect
  // is timely. Local reversible writes must preserve this boundary too. Reads
  // can proceed; no effect-specific temporal oracle is wired at this boundary.
  if (profile.mutatesSystem === true || profile.executionClass === 'external_commit' || actionFamily === 'send') {
    let sourceTimes;
    try {
      sourceTimes = createGoalContract({objective:mission.objective ?? contract?.objective,
        referenceTime:contract?.referenceTime ?? mission.createdAt ?? null,
        timeZone:contract?.timeZone ?? 'Asia/Seoul'}).times;
    } catch { sourceTimes = null; }
    const temporalBinding=sourceTimes?.length>0&&typeof temporalBindingResolver==='function'
      ?temporalBindingResolver(mission,{toolName:dispatchToolName??action.actualToolName??action.expectedToolName,phase}):null;
    const boundSchedule=temporalBinding===true;
    if ((sourceTimes === null || sourceTimes.length) && !boundSchedule) {
      const code = temporalBinding?.allowed===false ? temporalBinding.reason : sourceTimes === null ? 'goal-time-source-unavailable'
        : sourceTimes.some(item=>item.status==='unresolved') ? 'goal-time-unresolved' : 'goal-time-effect-unverified';
      return {...base, required:true, allowed:false, reasons:[{code}], coveredRequirementIds:[],
        temporalConstraints:sourceTimes, temporalExecutionVerified:false,
        nextAction:temporalBinding?.nextAction??'원문 시간 조건과 실제 실행 시각을 대조할 수 있는 예약·기한 검증 경로가 필요합니다. 독립 읽기는 진행할 수 있지만 시간 조건이 확인되지 않은 쓰기는 보류합니다.'};
    }
  }
  if(conditionalRequirements.length){
    const roots=(allowedRoots.length?allowedRoots:[mission.workspaceRoot].filter(Boolean)).map(root=>resolve(root));
    const args=dispatchArguments??action.operation?.dispatch?.arguments??action.arguments;
    const path=actionFamily==='list'?filePath(args?.directory,roots):argumentPath(action,args,roots);
    const independentlyBound=!conditionalAction&&path&&action.requirementIds.every(id=>{
      const r=currentSource.requirements.find(r=>r.requirementId===id),i=r?.interpretation;
      return i?.status==='recognized'&&i.polarity==='required'&&i.action===actionFamily
        &&filePath(i.target,roots)===path;
    });
    if(!independentlyBound)return {...base,required:true,allowed:false,
      reasons:conditionalRequirements.map(r=>({code:'goal-condition-unresolved',requirementId:r.requirementId})),
      coveredRequirementIds:[],conditionalRequirements,
      nextAction:'원문에 승인·답변·상태 조건이 있습니다. 조건 충족을 검증하거나 사용자가 조건을 명시적으로 정정해야 합니다. 조건과 무관하게 요청한 독립 작업은 현재 원문과 대조한 뒤 계속할 수 있습니다.'};
  }
  if (effectScope.scope === 'opaque') return { ...base, allowed: false,
    reasons: [{ code: 'opaque-effect-scope-unverified', detail: effectScope.reason }], coveredRequirementIds: [],
    missingRequirementIds: (mission.goalContract?.requirements ?? []).map(item => item.requirementId),
    nextAction: '이 도구는 화면 조작이나 코드 내부의 외부 효과를 확인할 수 없습니다. 원문 요구와 대상이 검증되는 구조화 도구로 계획하거나, 별도 Task에서 구체적인 동작 범위를 검토하세요.' };
  if(profile.mutatesSystem===true){
    const creation=creationBatchCoverage({mission,roots:(allowedRoots.length?allowedRoots:[mission.workspaceRoot].filter(Boolean)).map(root=>resolve(root)),
      phase,currentAction:action,dispatchArguments,dispatchToolName});
    if(creation)return {...base,...creation};
  }
  if (profile.mutatesSystem === true && isLiteralTextFileAttempt(mission.objective)) {
    const requests = contract?.objective === mission.objective ? parseLiteralTextFileBatch(mission.objective) : null;
    const roots = (allowedRoots.length ? allowedRoots : [mission.workspaceRoot].filter(Boolean)).map(root=>resolve(root));
    const actions = mission.waves.flatMap(item=>item.actions);
    const matches = (candidate,args,tool) => requests?.filter(request => tool === 'filesystem.createTextFile'
      && argumentPath(candidate,args,roots) === filePath(request.fileName,roots) && args?.content === request.content).length === 1;
    const exact = requests && !mission.constraints?.length && !contract.constraints?.length
      && !contract.contradictions?.length && !contract.revisionChange?.effectConflicts?.length
      && !contract.revisionChange?.invalidatedCriterionIds?.length && actions.length === requests.length
      && actions.every(candidate=>matches(candidate,candidate.arguments,candidate.actualToolName??candidate.expectedToolName))
      && new Set(actions.map(candidate=>argumentPath(candidate,candidate.arguments,roots))).size === requests.length
      && matches(action,dispatchArguments??action.arguments,dispatchToolName??action.actualToolName??action.expectedToolName);
    if (!exact) return {...base, required:true, allowed:false, reasons:[{code:'literal-text-whole-request-binding-unresolved'}],
      coveredRequirementIds:[], nextAction:'파일명·내용과 모든 추가 지시를 확인해야 합니다. 일부 파일만 먼저 작성하지 않습니다.'};
    return {...base, required:true, allowed:true, sourceBindingVerified:true, reasons:[],
      coveredRequirementIds:sourceRequirements.map(item=>item.requirementId), resultCriteriaVerificationRequired:true};
  }
  const researchBinding=researchSourceCoverage({mission,roots:allowedRoots,action,dispatchArguments,phase});
  if(researchBinding)return {...base,...researchBinding,required:true};
  const weather=weatherSourceBinding(mission,action,dispatchArguments??action.arguments,dispatchToolName??action.actualToolName??action.expectedToolName,allowedRoots);
  if(weather)return {...base,...weather};
  const macro=macroSourceBinding(mission,action,dispatchArguments??action.arguments,dispatchToolName??action.actualToolName??action.expectedToolName);
  if(macro)return {...base,...macro};
  if (!required) return { ...base, allowed: true, reasons: [], coveredRequirementIds: [] };
  const reasons = [], covered = new Set(), evidence = [];
  const block = (code, requirementId = null) => reasons.push({ code, ...(requirementId ? { requirementId } : {}) });
  if (!contract?.requirements?.length) {
    block('goal-contract-unavailable');
    return { ...base, allowed: false, reasons, coveredRequirementIds: [] };
  }
  let currentLinks;
  try { currentLinks = normalizeActionRequirementLinks(action, contract); }
  catch { block('invalid-requirement-links'); currentLinks = { requirementIds: [], constraintRequirementIds: [] }; }
  const externallyCommitting = profile?.executionClass === 'external_commit' || profile?.externalTransfer === true;
  if (externallyCommitting && (contract.times ?? []).some(item => item.status === 'unresolved')) {
    block('goal-time-unresolved');
  }
  if (externallyCommitting && contract.amounts?.length) {
    // A parsed source amount is not evidence that this effect's fees, tax and
    // cumulative total satisfy it. No independent money-effect oracle is wired
    // here yet; model-supplied arguments or "verified" flags cannot replace it.
    block(contract.amounts.some(item => item.status !== 'parsed')
      ? 'goal-amount-unresolved' : 'goal-amount-effect-unverified');
  }
  if (externallyCommitting && contract.quantities?.length) {
    // Claimed counts or measurements in model arguments are not independent
    // observations of recipients, units, inventory or delivered quantities.
    block(contract.quantities.some(item=>item.status!=='parsed')
      ? 'goal-quantity-unresolved' : 'goal-quantity-effect-unverified');
  }
  const mcpBinding=installedMcpSourceBinding({mission,action,toolName:dispatchToolName??action.actualToolName??action.expectedToolName,
    args:dispatchArguments??action.operation?.dispatch?.arguments??action.arguments,binding:installedIntentBinding});
  if(mcpBinding&&reasons.length===0)return {...base,...mcpBinding,status:'installed-mcp-source-binding',reasons:[],missingRequirementIds:[],nextAction:null};
  const localWorkflowBinding = verifyTrustedLocalWorkflowBinding({ mission, action, contract, currentLinks, roots: (allowedRoots.length ? allowedRoots : [mission.workspaceRoot].filter(Boolean)).map(root => resolve(root)), phase,
    dispatchArguments: dispatchArguments ?? action.operation?.dispatch?.arguments ?? action.arguments });
  if (localWorkflowBinding?.allowed && reasons.length === 0) return { ...base, allowed: true, status: 'deterministic-local-workflow-source-binding',
    semanticAccuracyVerified: false, sourceBindingVerified: true, coveredRequirementIds: localWorkflowBinding.coveredRequirementIds,
    missingRequirementIds: [], evidence: localWorkflowBinding.evidence,
    constraintChecks: localWorkflowBinding.constraintChecks, nextAction: null };
  if (contract.contradictions?.length) block('conflicting-goal-requirements');
  if (mission.constraints?.length) block('supplemental-constraints-unverified');
  if (contract.revisionChange?.effectConflicts?.length) block('prior-revision-effect-unresolved');
  if (contract.unresolvedCriterionIds?.length || contract.revisionChange?.invalidatedCriterionIds?.length) block('criterion-source-binding-unresolved');
  const exclusionBinding=inlineNaturalSourceBinding({mission,action,args:dispatchArguments??action.operation?.dispatch?.arguments??action.arguments,
    roots:(allowedRoots.length?allowedRoots:[mission.workspaceRoot].filter(Boolean)).map(root=>resolve(root)),phase});
  if(exclusionBinding&&reasons.every(r=>r.code==='supplemental-constraints-unverified'))return {...base,...exclusionBinding,reasons:[],nextAction:null};
  const ancestorIds = ancestors(wave, action);
  const candidates = mission.waves.flatMap(item => item.actions).filter(item => item.actionId !== action.actionId);
  const family = toolFamily(action.actualToolName ?? action.expectedToolName);
  const roots = (allowedRoots.length ? allowedRoots : [mission.workspaceRoot].filter(Boolean)).map(root => resolve(root));
  const currentArguments = dispatchArguments ?? action.operation?.dispatch?.arguments ?? action.arguments;
  const attachments = family === 'send' ? emailTargets(currentArguments, roots) : null;
  const requestedTargets = currentLinks.requirementIds.map(id => contract.requirements.find(item => item.requirementId === id))
    .filter(Boolean).map(item => sourcePath(item, roots));
  if (family === 'send' && (!attachments || requestedTargets.some(item => !item)
    || attachments.some(item => !requestedTargets.includes(item.path)))) block('external-target-binding-unresolved');
  const constraintIds = new Set((contract.constraints ?? []).map(item => item.requirementId));
  for (const requirement of contract.requirements) {
    const id = requirement.requirementId, interpretation = requirement.interpretation ?? {};
    const sourceClauseBound=effectScope.scope!=='external'||externalSourceClauseBound(mission,requirement);
    if(!sourceClauseBound)block('external-source-clause-not-fully-bound',id);
    if (constraintIds.has(id)) {
      if (currentLinks.requirementIds.includes(id)) block('constraint-linked-as-executable-action', id);
      if (interpretation.status !== 'recognized' || interpretation.polarity !== 'prohibited') block('constraint-interpretation-unresolved', id);
      else if (interpretation.action === family
        && !(effectScope.scope==='structured-local'&&localTextSaveAvoidsProhibition(mission,requirement,action,currentArguments,roots))) block('external-action-conflicts-with-prohibition', id);
      else if (!currentLinks.constraintRequirementIds.includes(id)) block('constraint-link-missing', id);
      else { covered.add(id); evidence.push({ requirementId: id, basis:interpretation.action===family?'nonmatching-physical-prohibited-target':'nonmatching-prohibited-operation' }); }
      continue;
    }
    if (interpretation.correction || interpretation.unresolvedReferences?.length) { block('requirement-reference-unresolved', id); continue; }
    // A read receipt cannot stand in for several demands hidden inside an unparsed clause.
    // Reads may still run and gather evidence, but cannot silently discharge that clause.
    if (interpretation.status !== 'recognized' || interpretation.compound) { block('requirement-meaning-unresolved', id); continue; }
    if(!sourceClauseBound)continue;
    if (currentLinks.requirementIds.includes(id)) {
      if (interpretation.status !== 'recognized' || interpretation.compound || !family || interpretation.action !== family) {
        block('external-action-requirement-not-independently-bound', id);
      } else {
        if(effectScope.scope==='structured-local'&&explicitLocalTextTargetBound(mission,requirement,action,currentArguments,roots)){
          covered.add(id);evidence.push({requirementId:id,basis:'explicit-local-text-target-bound'});continue;
        }
        if(family==='send'&&!emailRecipientBound(mission,requirement,currentArguments)){
          block('external-recipient-source-binding-unresolved',id);continue;
        }
        const target = sourcePath(requirement, roots);
        const attachment = attachments?.find(item => item.path === target);
        const source = target && attachment && candidates.find(candidate => {
          const ids = candidate.requirementIds ?? [];
          const sourceRequirement = contract.requirements.find(item => ids.includes(item.requirementId)
            && ['read', 'save'].includes(item.interpretation?.action) && sourcePath(item, roots) === target);
          if (!sourceRequirement || !boundPredecessor(mission, sourceRequirement, candidate, roots, phase === 'planning' && ancestorIds.has(candidate.actionId))) return false;
          return phase === 'planning' && !verifiedAction(mission, candidate)
            ? true : observedFiles(mission, candidate, roots).some(item => item.path === target && item.sha256 === attachment.sha256);
        });
        if (!source) block('external-action-target-not-independently-bound', id);
        else { covered.add(id); evidence.push({ requirementId: id, actionId: source.actionId, basis: 'source-target-and-file-evidence-bound' }); }
      }
      continue;
    }
    const candidate = candidates.find(item => item.requirementIds?.includes(id)
      && boundPredecessor(mission, requirement, item, roots, phase === 'planning' && ancestorIds.has(item.actionId)));
    if (candidate) {
      covered.add(id);
      evidence.push({ requirementId: id, actionId: candidate.actionId,
        basis: verifiedAction(mission, candidate) ? 'observed-g-verified-predecessor' : 'planned-predecessor' });
    } else block('requirement-execution-evidence-missing', id);
  }
  if (!currentLinks.requirementIds.length) block('external-action-source-link-missing');
  return { ...base, allowed: reasons.length === 0, reasons, coveredRequirementIds: [...covered],
    missingRequirementIds: contract.requirements.map(item => item.requirementId).filter(id => !covered.has(id)), evidence,
    nextAction: reasons.some(item => item.code === 'external-recipient-source-binding-unresolved')
      ? '받을 사람의 이메일 주소 또는 본인 메일로 보낼지 한 번만 확인해야 합니다. 동명이인은 이름만으로 선택하지 않습니다. 독립 자료 읽기는 계속할 수 있습니다.'
      : reasons.some(item => item.code === 'requirement-reference-unresolved')
      ? '“그 파일”처럼 대상이 확정되지 않은 표현의 정확한 파일명·경로 또는 대상을 한 번에 알려주세요. 원문 작업과 완료 기준을 함께 정정한 뒤 이어서 실행합니다. 독립 자료 읽기는 계속할 수 있습니다.'
      : reasons.some(item => item.code === 'goal-quantity-unresolved')
      ? '수량과 단위를 정확히 확인해야 합니다. 독립 자료 읽기와 로컬 준비는 계속할 수 있습니다.'
      : reasons.some(item => item.code === 'goal-quantity-effect-unverified')
        ? '수량은 해석했지만 실제 대상·배분·측정값과 대조하지 못했습니다. 외부 실행 전 수량 검증을 연결해야 합니다.'
      : reasons.some(item => item.code === 'goal-amount-unresolved')
      ? '금액 조건을 정확한 원 단위로 확인하세요. 독립적인 자료 읽기와 로컬 준비는 진행할 수 있습니다.'
      : reasons.some(item => item.code === 'goal-amount-effect-unverified')
        ? '금액은 해석했지만 수수료·세금·누적 금액을 포함한 실제 실행 비용을 검증하지 못했습니다. 금액 검증이 연결될 때까지 외부 실행을 보류합니다.'
        : reasons.length ? '누락된 원문 요구를 계획에 연결하고 필요한 선행 결과를 검증한 뒤 외부 작업을 다시 계획하세요.' : null };
}

/** Completion must cover the source clauses as well as the caller's criteria.
 * A full deterministic compilation can prove coverage of its bounded grammar;
 * the caller must still verify each result criterion independently. */
export function assessMissionGoalCompletionCoverage({ mission, allowedRoots = [], installedIntentBindingResolver = null, beforeTextRead = null }) {
  const listing=verifyReadOnlyListing({mission,allowedRoots});
  const textRead=verifyReadOnlyText({mission,allowedRoots,beforeRead:beforeTextRead});
  if(textRead.applicable&&textRead.passed)return {version:'a-mission-goal-completion-coverage-v1',required:true,
    semanticAccuracyVerified:false,sourceBindingVerified:true,executionAuthority:false,
    allowed:true,status:'independent-read-only-text-coverage',reasons:[],
    coveredRequirementIds:textRead.coveredRequirementIds,evidenceActionIds:textRead.evidenceActionIds,
    missingRequirementIds:[],constraintChecks:textRead.checks,resultCriteriaVerificationRequired:true};
  if(listing.applicable && listing.passed)return {version:'a-mission-goal-completion-coverage-v1',required:true,
    allowed:true,status:'independent-read-only-listing-coverage',semanticAccuracyVerified:false,sourceBindingVerified:true,
    executionAuthority:false,coveredRequirementIds:listing.coveredRequirementIds,evidenceActionIds:listing.evidenceActionIds,
    reasons:[],constraintChecks:listing.checks,resultCriteriaVerificationRequired:true};
  const contract = mission.goalContract;
  const roots = (allowedRoots.length ? allowedRoots : [mission.workspaceRoot].filter(Boolean)).map(root => resolve(root));
  const requirements = contract?.requirements ?? [];
  const required = Boolean(contract?.interpretationIssue) || requirements.length > 1
    || requirements.some(item => item.interpretation?.compound)
    || requirements.some(item => item.interpretation?.status === 'recognized' && sourcePath(item, roots));
  const base = { version: 'a-mission-goal-completion-coverage-v1', required, semanticAccuracyVerified: false,
    executionAuthority: false, coveredRequirementIds: [], reasons: [] };
  const creation=creationBatchCoverage({mission,roots,phase:'completion'});
  if(creation)return {...base,...creation};
  const paragraphRevision=documentParagraphRevisionCoverage({mission,roots,isVerified:action=>verifiedAction(mission,action)});
  if(paragraphRevision)return {...base,...paragraphRevision};
  const weatherActions=mission.waves.flatMap(w=>w.actions).filter(a=>(a.actualToolName??a.expectedToolName)==='weather.createHwpReport');
  if(weatherActions.length){
    const action=weatherActions[0],proof=weatherSourceBinding(mission,action,action.operation?.dispatch?.arguments,action.actualToolName,roots);
    const bound=proof?.allowed===true&&verifiedAction(mission,action)&&action.operation?.dispatch?.taskId===action.taskId;
    return {...base,...proof,allowed:bound,status:bound?'weather-source-and-result-coverage':'weather-source-or-result-unverified',
      evidenceActionIds:bound?[action.actionId]:[],reasons:bound?[]:[{code:'weather-source-or-result-unverified'}]};
  }
  const researchBinding=researchSourceCoverage({mission,roots});
  const macroActions=mission.waves.flatMap(w=>w.actions).filter(a=>(a.actualToolName??a.expectedToolName)==='macro.save');
  if(macroActions.length){
    const action=macroActions[0],proof=macroSourceBinding(mission,action,action.operation?.dispatch?.arguments,action.actualToolName);
    const bound=proof?.allowed===true&&verifiedAction(mission,action)&&action.operation?.dispatch?.taskId===action.taskId;
    return {...base,...proof,allowed:bound,status:bound?'macro-source-and-result-coverage':'macro-source-or-result-unverified',
      evidenceActionIds:bound?[action.actionId]:[],reasons:bound?[]:[{code:'macro-source-or-result-unverified'}]};
  }
  if(researchBinding)return {...base,...researchBinding,required:true};
  const mcpActions=(mission.waves??[]).flatMap(wave=>wave.actions).filter(action=>/^mcp\./u.test(action.actualToolName??action.expectedToolName??''));
  if(mcpActions.length){
    const matched=mcpActions.find(action=>verifiedAction(mission,action)&&action.operation?.dispatch?.taskId===action.taskId
      &&action.operation.dispatch.toolName===action.actualToolName&&installedMcpSourceBinding({mission,action,toolName:action.actualToolName,
        args:action.operation.dispatch.arguments,binding:installedIntentBindingResolver?.(action.actualToolName)}));
    return {...base,required:true,allowed:Boolean(matched),sourceBindingVerified:Boolean(matched),
      status:matched?'installed-mcp-source-and-result-coverage':'mcp-source-or-result-unverified',
      coveredRequirementIds:matched?requirements.map(item=>item.requirementId):[],evidenceActionIds:matched?[matched.actionId]:[],
      reasons:matched?[]:[{code:'mcp-source-or-result-unverified'}],resultCriteriaVerificationRequired:true};
  }
  // Existing single-clause legacy criteria keep their own deterministic evidence
  // checks. This does not turn an unparsed clause into full semantic coverage.
  if (!required) return { ...base, allowed: true, status: 'legacy-criterion-verification-only' };
  const block = (code, requirementId) => base.reasons.push({ code, ...(requirementId ? { requirementId } : {}) });
  if (contract.contradictions?.length) block('conflicting-goal-requirements');
  if (contract.revisionChange?.invalidatedCriterionIds?.length) block('criterion-source-binding-unresolved');
  if (contract.revisionChange?.effectConflicts?.length) block('prior-revision-effect-unresolved');
  const actions = mission.waves.flatMap(wave => wave.actions);
  // A complete bounded literal request can prove both filename and content,
  // even when the general clause interpreter has no creation/content grammar.
  // Never promote arbitrary task arguments or the existence of a file alone.
  const literals=contract?.objective===mission.objective?parseLiteralTextFileBatch(mission.objective):null;
  if(literals&&base.reasons.length===0&&!mission.constraints?.length&&!contract.constraints?.length
    &&!contract.unresolvedCriterionIds?.length&&actions.length===literals.length){
    const matched = literals.every(literal=>actions.filter(action=>{
    const dispatch=action.operation?.dispatch;
    const target=filePath(literal.fileName,roots),contentSha256=createHash('sha256').update(literal.content).digest('hex');
    return target&&verifiedAction(mission,action)&&action.actualToolName==='filesystem.createTextFile'
      &&dispatch?.taskId===action.taskId&&dispatch.toolName===action.actualToolName
      &&argumentPath(action,dispatch.arguments,roots)===target&&dispatch.arguments.content===literal.content
      &&observedFiles(mission,action,roots).some(file=>file.path===target&&file.sha256===contentSha256);
    }).length===1);
    if(matched)
      return {...base,required:true,allowed:true,status:'bounded-literal-text-file-source-coverage',sourceBindingVerified:true,
        coveredRequirementIds:requirements.map(item=>item.requirementId),evidenceActionIds:actions.map(action=>action.actionId),
        resultCriteriaVerificationRequired:true,constraintChecks:[]};
  }
  for (const action of actions) {
    let links;
    try { links = normalizeActionRequirementLinks(action, contract); } catch { continue; }
    const trustedWorkflow = verifyTrustedLocalWorkflowBinding({ mission, action, contract, currentLinks: links, roots,
      phase: 'completion', dispatchArguments: action.operation?.dispatch?.arguments ?? action.arguments });
    if (trustedWorkflow?.allowed && verifiedAction(mission, action)) return { ...base, allowed: true,
      status: 'deterministic-local-workflow-source-coverage', semanticAccuracyVerified: false, sourceBindingVerified: true,
      coveredRequirementIds: trustedWorkflow.coveredRequirementIds, evidenceActionIds: [action.actionId],
      sourceClauseEvidence: trustedWorkflow.evidence, constraintChecks: trustedWorkflow.constraintChecks,
      resultCriteriaVerificationRequired: true };
  }
  let compiled;
  // A verified work-reference substitution changes the executable objective but
  // deliberately preserves the user's original goal contract. Compile the
  // resolved objective only when its provenance can be tied back to that exact
  // contract and artifact receipt below.
  try { compiled = roots.length ? (mission.ofxSave?compileOfxSaveMission(mission,mission.ofxSave,roots[0]):compileNaturalWorkflowObjective(mission.objective, { workspaceRoot: roots[0] })) : null; }
  catch { compiled = null; }
  if (compiled?.spec && compiled.status === 'compiled') {
    const match = actions.find(action => {
      if (action.actualToolName !== 'workflow.execute' || !verifiedAction(mission, action)) return false;
      const dispatch = action.operation?.dispatch;
      const observed = observationFor(mission, action)?.data?.workflow;
      let encodedSpec = JSON.stringify(dispatch?.arguments?.spec ?? null);
      if (dispatch?.workflowSpecSource !== undefined) {
        try {
          if (typeof dispatch.workflowSpecSource !== 'string' || !isDeepStrictEqual(JSON.parse(dispatch.workflowSpecSource), dispatch.arguments?.spec)) return false;
          encodedSpec = dispatch.workflowSpecSource;
        } catch { return false; }
      }
      return dispatch?.taskId === action.taskId && dispatch.toolName === 'workflow.execute'
        && isDeepStrictEqual(JSON.parse(encodedSpec),compiled.spec)
        && observed?.specSha256 === createHash('sha256').update(encodedSpec).digest('hex') && observed.workflowId === compiled.spec.workflowId
        && observed.nodeCount === compiled.spec.nodes.length;
    });
    if (match) {
      const constraintProof = verifyLocalWorkflowConstraints({ mission, action: match, spec: compiled.spec, roots });
      const compiledRequirements = compiled.goalContract?.requirements ?? [];
      const clauses = compiled.clauses ?? [];
      const workflowObservation = observationFor(mission, match)?.data?.workflow;
      const compiledNodeCoverage = compiledRequirements.length > 0 && compiledRequirements.length === clauses.length
        && clauses.every((clause, index) =>
          clause.status === 'compiled' && clause.requirementId === compiledRequirements[index]?.requirementId
          && Array.isArray(clause.nodeIds) && clause.nodeIds.length > 0
          && clause.nodeIds.every(nodeId => workflowObservation?.receipts?.some(receipt =>
            receipt.nodeId === nodeId && receipt.status === 'success')));
      const oneToOneClauseProof = requirements.length > 0 && requirements.length === compiledRequirements.length
        && compiledNodeCoverage && clauses.every((clause, index) => clause.requirementId === requirements[index]?.requirementId);
      const sourceClauseEvidence = oneToOneClauseProof ? clauses.map((clause, index) => ({
        requirementId: requirements[index].requirementId, sourceSpan: clause.sourceSpan,
        nodeIds: [...clause.nodeIds], resolvedReferences: structuredClone(compiledRequirements[index].referenceBindings ?? [])
      })) : [];
      if (constraintProof.passed && oneToOneClauseProof && base.reasons.length === 0) return { ...base, allowed: true, status: 'deterministic-source-coverage',
        coveredRequirementIds: requirements.map(item => item.requirementId), evidenceActionIds: [match.actionId],
        constraintChecks: constraintProof.checks, sourceClauseEvidence, resultCriteriaVerificationRequired: true };

      const reference = mission.metadata?.workReference;
      const originalTextMatches = mission.metadata?.workReferenceOriginalText === contract.objective;
      const resolvedHashMatches = contract.referenceSubstitutionApplied === true
        && contract.resolvedObjectiveSha256 === createHash('sha256').update(mission.objective).digest('hex');
      const firstRead = compiled.spec.nodes.find(node => ['data.readJson', 'data.readCsv', 'text.read'].includes(node.op));
      const firstReadReceipt = workflowObservation?.receipts?.find(receipt => receipt.nodeId === firstRead?.id);
      const referencePath = reference && roots.length ? filePath(reference.path, roots) : null;
      const referenceIsBound = Boolean(originalTextMatches && resolvedHashMatches && referencePath
        && typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(reference.sha256)
        && firstRead?.args?.path && resolve(firstRead.args.path) === referencePath
        && firstReadReceipt?.status === 'success' && resolve(firstReadReceipt.source?.path ?? '') === referencePath
        && sha(firstReadReceipt.source?.sha256) === sha(reference.sha256));
      if (referenceIsBound && compiledNodeCoverage && constraintProof.passed && base.reasons.length === 0) {
        return { ...base, allowed: true, status: 'deterministic-reference-substitution-coverage',
          coveredRequirementIds: requirements.map(item => item.requirementId), evidenceActionIds: [match.actionId],
          constraintChecks: constraintProof.checks, resultCriteriaVerificationRequired: true,
          referenceEvidence: { artifactId: reference.artifactId, path: referencePath, sha256: sha(reference.sha256), version: reference.version } };
      }
    }
  }
  if (mission.constraints?.length) block('supplemental-constraints-unverified');
  if (contract.unresolvedCriterionIds?.length) block('criterion-source-binding-unresolved');
  if (base.reasons.length === 0) {
    const summary = assessTextSummarySequence({ mission, roots, verifiedAction, observedFiles });
    if (summary) return { ...base, ...summary, status: summary.allowed ? 'bounded-source-coverage' : 'unverified',
      missingRequirementIds: requirements.map(item => item.requirementId).filter(id => !summary.coveredRequirementIds.includes(id)) };
  }
  const constraints = new Set((contract.constraints ?? []).map(item => item.requirementId));
  for (const requirement of requirements) {
    const id = requirement.requirementId, interpretation = requirement.interpretation ?? {};
    if (interpretation.status !== 'recognized' || interpretation.compound || interpretation.correction || interpretation.unresolvedReferences?.length) {
      block('source-requirement-meaning-unresolved', id); continue;
    }
    if (constraints.has(id)) {
      if (interpretation.polarity !== 'prohibited' || !interpretation.action
        || actions.some(action => ['succeeded', 'running'].includes(action.status)
          && (!toolFamily(action.actualToolName) || (toolFamily(action.actualToolName) === interpretation.action
            && !(action.operation?.dispatch?.toolName===action.actualToolName&&localTextSaveAvoidsProhibition(mission,requirement,action,action.operation.dispatch.arguments,roots)))))) {
        block('source-prohibition-unverified', id); continue;
      }
      base.coveredRequirementIds.push(id); continue;
    }
    let matched = false;
    for (const wave of mission.waves) {
      for (const action of wave.actions) {
        if (!action.requirementIds?.includes(id) || !verifiedAction(mission, action)) continue;
        if (interpretation.action === 'send') {
          if (!compatible(requirement, action)) continue;
          const delivery = observationFor(mission, action)?.data?.email;
          if (delivery?.passed !== true || delivery.providerAccepted !== true || delivery.recipientMatched !== true) continue;
          const coverage = assessMissionRequirementCoverage({ mission, wave, action,
            profile: { externalTransfer: true }, allowedRoots: roots, phase: 'dispatch' });
          matched ||= coverage.allowed;
        } else matched ||= boundPredecessor(mission, requirement, action, roots, false);
      }
    }
    if (matched) base.coveredRequirementIds.push(id);
    else block('source-requirement-execution-missing', id);
  }
  return { ...base, allowed: base.reasons.length === 0, status: base.reasons.length ? 'unverified' : 'bounded-source-coverage',
    missingRequirementIds: requirements.map(item => item.requirementId).filter(id => !base.coveredRequirementIds.includes(id)) };
}
import {compileOfxSaveMission} from './ofx-save-mission.js';


/** Read-only recovery diagnostics; never resolves meaning or grants execution. */
export function explainRequirementCoverageFailure({mission,action,coverage=action.requirementCoverage}) {
  const requirements=mission.goalContract?.requirements??[];
  const reasons=coverage?.reasons??[];
  const unresolved=new Set(reasons.filter(reason=>['requirement-meaning-unresolved','requirement-reference-unresolved','constraint-interpretation-unresolved'].includes(reason.code)).map(reason=>reason.requirementId));
  for(const id of mission.goalContract?.unresolvedRequirementIds??[])unresolved.add(id);
  const linked=new Set(action.requirementIds??[]);
  return {
    version:'a-requirement-resolution-diagnostic-v1',
    toolName:action.actualToolName??action.expectedToolName??null,
    goalRevision:mission.goalContract?.revision??null,
    unresolvedRequirementIds:requirements.filter(requirement=>unresolved.has(requirement.requirementId)).map(requirement=>requirement.requirementId),
    unlinkedRequirementIds:requirements.filter(requirement=>!linked.has(requirement.requirementId)
      &&!(action.constraintRequirementIds??[]).includes(requirement.requirementId)).map(requirement=>requirement.requirementId),
    reasonCodes:[...new Set(reasons.map(reason=>reason.code))],
    requiredBindings:['original-requirement-to-tool','original-target-to-arguments','result-to-independent-verifier'],
    resolutionStatus:'not-resolved',executionAuthorized:false,
    nextAction:coverage?.nextAction??'원문 요구를 보존한 해석 계약에 도구·대상·입력·완료 기준을 연결하고 독립 검증하세요. 도구 설치나 승인은 미해석 요구를 대신 해결하지 않습니다.'
  };
}
