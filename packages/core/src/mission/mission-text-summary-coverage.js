import { createHash } from 'node:crypto';
import { openSync, readSync, fstatSync, closeSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tokenizeGoalSource } from './goal-contract.js';
import { completeTextReadChain } from './mission-text-read-coverage.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const inside = (root, path) => {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
function targetPath(value, roots) {
  if (typeof value !== 'string' || !value || !roots.length || /[\0\r\n]/u.test(value)) return null;
  const path = resolve(roots[0], value);
  return roots.some(root => inside(root, path)) ? path : null;
}
function currentFile(path, roots) {
  let fd;
  try {
    const real = realpathSync(path);
    if (!roots.some(root => inside(realpathSync(root), real))) return null;
    fd=openSync(real,'r');
    const stat = fstatSync(fd,{bigint:true});
    if (!stat.isFile() || stat.size > 16n * 1024n * 1024n) return null;
    const buffer=Buffer.alloc(Number(stat.size)+1); let size=0;
    while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,size);if(!count)break;size+=count;}
    const same = a=>a.dev===stat.dev&&a.ino===stat.ino&&a.size===stat.size&&a.mtimeNs===stat.mtimeNs&&a.ctimeNs===stat.ctimeNs;
    if(size!==Number(stat.size)||!same(fstatSync(fd,{bigint:true}))||!same(statSync(real,{bigint:true})))return null;
    if(!roots.some(root=>inside(realpathSync(root),realpathSync(path))))return null;
    const bytes=buffer.subarray(0,size);
    return { sha256: digest(bytes), text: new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes), bytes: bytes.length };
  } catch { return null; } finally {if(fd!==undefined)closeSync(fd);}
}
export {currentFile as currentTextFileSnapshot};

/** A bounded sequence verifier for an explicit text source and destination.
 * It never judges an open-ended summary. A caller-supplied exact content oracle
 * is required; the normal criterion verifier remains mandatory afterwards.
 * Evidence readers are trusted internal Mission helpers, never planner input. */
export function assessTextSummarySequence({ mission, roots, verifiedAction, observedFiles }) {
  const contract = mission.goalContract;
  if (contract?.requirements?.length !== 1 || !roots.length) return null;
  let source;
  try { source = tokenizeGoalSource(contract.objective); } catch { return null; }
  if (source.clauses.length !== 1 || ![2,3].includes(source.strings.length)) return null;
  const simpleSequence = /^§0§(?:을|를)\s*읽고\s*(?:(?:핵심|내용)(?:을)?\s*)?요약(?:해|해서|하고)\s*§1§(?:으로|로)\s*저장(?:해|해줘|해\s*줘|해\s*주세요|해주세요)[.!。]?$/u.test(source.clauses[0]);
  const discoveredSequence = /^§0§\s*(?:파일을\s*)?찾아(?:서)?\s*(?:내용(?:을)?\s*)?읽고\s*(?:(?:핵심(?:\s*사실)?)(?:을)?\s*)?요약(?:해|해서)\s*§1§(?:으로|로)\s*저장한\s*다음[,，]?\s*(?:저장된\s*요약\s*파일을\s*)?(?:다시\s*)?찾아(?:서)?\s*(?:읽고(?:\s*확인해)?|읽어\s*확인해|내용까지\s*확인해)[.!。]?$/u.test(source.clauses[0])
    || /^§0§\s*(?:파일을\s*)?찾아(?:서)?\s*(?:내용(?:을)?\s*)?읽고\s*(?:(?:핵심(?:\s*사실)?)(?:을)?\s*)?요약(?:해|해서)\s*§1§(?:으로|로)\s*저장하고[,，]?\s*(?:결과\s*파일을\s*)?(?:다시\s*)?찾아(?:서)?\s*(?:내용(?:을)?\s*)?읽어\s*확인해(?:줘|주세요)?[.!。]?$/u.test(source.clauses[0]);
  // The named read result is a local alias, not another file or an extra instruction.
  // Only this entire grammar is accepted; unparsed suffixes still remain unverified.
  const typedSequence = source.strings.length === 3
    && /^§0§\s*텍스트(?:를|을)\s*§1§(?:으로|로)\s*읽고\s*(?:(?:핵심|내용)(?:을)?\s*)?요약(?:해|해서|하고)\s*§2§\s*텍스트(?:으로|로)\s*저장(?:해|해줘|해\s*줘|해\s*주세요|해주세요)[.!。]?$/u.test(source.clauses[0]);
  if (!simpleSequence && !discoveredSequence && !typedSequence) return null;
  if (typedSequence && (!source.strings[1].trim() || source.strings[1].length > 256)) return null;
  const requirementId = contract.requirements[0].requirementId;
  const base = { allowed: false, reasons: [], coveredRequirementIds: [], evidenceActionIds: [],
    resultCriteriaVerificationRequired: true, basis: 'typed-content-and-observed-read-write' };
  const reject = code => ({ ...base, reasons: [{ code, requirementId }] });
  const input = targetPath(source.strings[0], roots), output = targetPath(source.strings[typedSequence ? 2 : 1], roots);
  if (!input || !output || input === output) return reject('summary-source-target-unresolved');
  const expected = (mission.successCriteria ?? []).filter(item => item.verificationSpec?.version === 1
    && item.verificationSpec.kind === 'text.equals' && typeof item.verificationSpec.equals === 'string'
    && targetPath(item.verificationSpec.path, roots) === output);
  if (!expected.length) return reject('summary-independent-content-oracle-missing');
  const sourceFile = currentFile(input, roots), resultFile = currentFile(output, roots);
  if (!sourceFile || !resultFile || expected.some(item => item.verificationSpec.equals !== resultFile.text)) {
    return reject('summary-content-or-current-file-unverified');
  }
  const actions = (mission.waves ?? []).flatMap(wave => wave.actions ?? []);
  const matches = (action, tool, path, hash) => {
    const dispatch = action.operation?.dispatch;
    return action.actualToolName === tool && verifiedAction(mission, action)
      && dispatch?.taskId === action.taskId && dispatch.toolName === tool
      && targetPath(dispatch.arguments?.path, roots) === path
      && observedFiles(mission, action, roots).some(item => item.path === path && item.sha256 === hash);
  };
  const reads = actions.filter(action => matches(action, 'filesystem.readText', input, sourceFile.sha256));
  const writes = actions.filter(action => matches(action, 'filesystem.createTextFile', output, resultFile.sha256));
  if (!reads.length || writes.length !== 1) return reject('summary-read-write-evidence-missing');
  const write = writes[0];
  const writeAt = Date.parse(write.operation.dispatch.dispatchedAt);
  const readChain=Number.isFinite(writeAt) && completeTextReadChain({reads:reads.filter(action=>actions.indexOf(action)<actions.indexOf(write)),mission,sourceFile,before:writeAt});
  if (!readChain) return reject('summary-read-before-write-unverified');
  const read=readChain[0];
  const evidenceActions = [...readChain, write];
  if (discoveredSequence) {
    const observationFor = action => action && mission.observations.find(item => item.observationId === action.observationId);
    const completedBetweenDispatchAnd = action => {
      const dispatchedAt = Date.parse(action.operation?.dispatch?.dispatchedAt);
      const observedAt = Date.parse(observationFor(action)?.createdAt);
      return Number.isFinite(dispatchedAt) && Number.isFinite(observedAt) && dispatchedAt <= observedAt;
    };
    const searchMatches = (action, filePath) => {
      const dispatch = action.operation?.dispatch;
      if (action.actualToolName !== 'filesystem.searchFiles' || !verifiedAction(mission, action)
        || dispatch?.taskId !== action.taskId || dispatch.toolName !== 'filesystem.searchFiles'
        || dispatch.arguments?.query?.toLocaleLowerCase() !== filePath.split(/[\\/]/u).at(-1).toLocaleLowerCase()
        || dispatch.arguments?.scope !== 'workspace') return false;
      const directory = dispatch.arguments?.directory;
      if (directory && targetPath(directory, roots) !== resolve(filePath, '..')) return false;
      const observation = mission.observations.find(item => item.observationId === action.observationId);
      return (observation?.data?.matches ?? []).some(item => {
        const artifact = item.artifact;
        if (item.name?.toLocaleLowerCase() !== filePath.split(/[\\/]/u).at(-1).toLocaleLowerCase()
          || !Number.isInteger(artifact?.rootIndex) || artifact.rootIndex < 0 || artifact.rootIndex >= roots.length
          || artifact.outsideAllowedRoots !== false || typeof artifact.relativePath !== 'string'
          || isAbsolute(artifact.relativePath) || /[\0\r\n]/u.test(artifact.relativePath)) return false;
        const artifactRoot = resolve(roots[artifact.rootIndex]);
        const artifactPath = resolve(artifactRoot, artifact.relativePath);
        return inside(artifactRoot, artifactPath) && artifactPath === filePath;
      });
    };
    const sourceSearch = actions.find(action => searchMatches(action, input)
      && actions.indexOf(action) < actions.indexOf(read));
    const outputSearch = actions.find(action => searchMatches(action, output)
      && actions.indexOf(action) > actions.indexOf(write));
    const outputReads = outputSearch ? actions.filter(action => matches(action, 'filesystem.readText', output, resultFile.sha256)
      && actions.indexOf(action) > actions.indexOf(outputSearch)) : [];
    const outputReadChain=completeTextReadChain({reads:outputReads,mission,sourceFile:resultFile});
    const outputRead=outputReadChain?.[0];
    const sourceSearches = actions.filter(action => searchMatches(action, input));
    const outputSearches = actions.filter(action => searchMatches(action, output));
    const sourceSearchAt = Date.parse(observationFor(sourceSearch)?.createdAt);
    const sourceReadAt = Date.parse(read.operation?.dispatch?.dispatchedAt);
    const writeObservedAt = Date.parse(observationFor(write)?.createdAt);
    const outputSearchAt = Date.parse(observationFor(outputSearch)?.createdAt);
    const outputReadDispatchAt = Date.parse(outputRead?.operation?.dispatch?.dispatchedAt);
    if (!sourceSearch || !outputSearch || sourceSearches.length !== 1 || outputSearches.length !== 1
      || !completedBetweenDispatchAnd(sourceSearch) || !completedBetweenDispatchAnd(outputSearch)
      || !Number.isFinite(sourceSearchAt) || !Number.isFinite(sourceReadAt) || sourceSearchAt > sourceReadAt
      || !Number.isFinite(writeObservedAt) || !Number.isFinite(outputSearchAt) || writeObservedAt > Date.parse(outputSearch.operation.dispatch.dispatchedAt)
      || outputSearchAt > outputReadDispatchAt) return reject('summary-file-discovery-unverified');
    const readAt = Date.parse(outputRead?.operation?.dispatch?.dispatchedAt);
    if (!outputReadChain || !Number.isFinite(writeAt) || !Number.isFinite(readAt) || writeAt > readAt) {
      return reject('summary-output-reread-unverified');
    }
    evidenceActions.push(sourceSearch, outputSearch, ...outputReadChain);
  }
  if (actions.some(action => action !== write && ['succeeded', 'running'].includes(action.status)
    && !['filesystem.readText', 'filesystem.listFiles', 'filesystem.searchFiles'].includes(action.actualToolName))) {
    return reject('summary-unexpected-effect');
  }
  return { ...base, allowed: true, coveredRequirementIds: [requirementId], evidenceActionIds: [...new Set(evidenceActions.map(action => action.actionId))],
    independentCriterionIds: expected.map(item => item.criterionId) };
}
