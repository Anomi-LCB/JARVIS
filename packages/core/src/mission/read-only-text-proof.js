import {createHash} from 'node:crypto';
import {realpathSync,openSync,readSync,fstatSync,statSync,closeSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const deny=reason=>({applicable:true,passed:false,status:'unverified',reasons:[reason],checks:[]});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const localConstraints=new Set(['허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.','외부 전송과 되돌릴 수 없는 작업은 기존 정책과 유효한 위임을 확인하고 필요한 행동만 확인받는다.']);
const readStatementBound=(mission,statement)=>statement===mission.objective
 ||statement===`${mission.objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`;

export function planReadOnlyTextStart({mission,allowedRoots=[]}){
 const contract=mission?.goalContract,requirements=contract?.requirements;
 if(requirements?.length!==1||contract.objective!==mission.objective||contract.objectiveSha256!==sha(mission.objective)
   ||contract.contradictions?.length||contract.times?.length||contract.amounts?.length||contract.referenceSubstitutionApplied
   ||(mission.constraints??[]).some(c=>!localConstraints.has(c.statement??c))
   ||mission.successCriteria?.length!==1||mission.successCriteria[0].verificationSpec
   ||!readStatementBound(mission,mission.successCriteria[0].statement)
   ||mission.waves?.some(w=>w.actions?.some(a=>a.goalRevision===contract.revision)))return null;
 const r=requirements[0],i=r.interpretation;
 if(i.status!=='recognized'||i.action!=='read'||i.polarity!=='required'||i.compound||i.hasProhibition||i.hasExclusion||i.correction
   ||i.unresolvedReferences?.length||i.unresolvedConditions?.length||typeof i.target!=='string'||!/\.(?:txt|md|csv|json)$/iu.test(i.target)||!allowedRoots.length)return null;
 const path=resolve(allowedRoots[0],i.target);
 if(!allowedRoots.some(root=>{const p=relative(resolve(root),path);return !isAbsolute(p)&&p!=='..'&&!p.startsWith('..\\')&&!p.startsWith('../');}))return null;
 return {decision:'continue',summary:'원문에 확정된 텍스트 파일을 읽고 현재 원문과 대조합니다.',criteriaAssessment:[],
   planning:{mode:'independent-text-read-start',modelRoundTrips:0},
   actions:[{id:'text-read-start',command:mission.objective,expectedToolName:'filesystem.readText',arguments:{path,offset:0,maxChars:50000},
     dependencies:[],requirementIds:[r.requirementId],successSignal:'원문 대상과 전체 읽기 G 검증'}]};
}

function trace(mission,roots,selectedRequirement=null){
 const contract=mission?.goalContract,requirements=contract?.requirements;
 if(selectedRequirement?!requirements?.includes(selectedRequirement):requirements?.length!==1)return {applicable:false};
 const requirement=selectedRequirement??requirements[0];
 if(requirement.interpretation?.action!=='read')return {applicable:false};
 const interpretation=requirement.interpretation;
 if(interpretation.status!=='recognized'||interpretation.compound||interpretation.polarity!=='required'
   ||interpretation.hasProhibition||interpretation.hasExclusion||interpretation.correction
   ||interpretation.unresolvedReferences?.length||contract.objective!==mission.objective
   ||contract.contradictions?.length||contract.referenceSubstitutionApplied||contract.times?.length||contract.amounts?.length)return deny('text-read-source-contract-unbound');
 if(!roots.length||typeof interpretation.target!=='string')return deny('text-read-source-missing');
 const target=resolve(roots[0],interpretation.target),root=roots.find(r=>{const p=relative(resolve(r),target);return !isAbsolute(p)&&p!=='..'&&!p.startsWith('..\\')&&!p.startsWith('../');});
 if(!root)return deny('text-read-target-outside-roots');
 const allActions=mission.waves?.flatMap(w=>w.actions??[])??[],receipts=[];
 // Goal correction retains history. Prior revisions must neither discharge the
 // current goal nor invalidate fresh current-revision G receipts. Unknown or
 // future revisions remain untrusted instead of being silently discarded.
 if(allActions.some(a=>!Number.isSafeInteger(a.goalRevision)||a.goalRevision<1||a.goalRevision>contract.revision))return deny('text-read-revision-unbound');
 const actions=allActions.filter(a=>a.goalRevision===contract.revision&&(!selectedRequirement||a.requirementIds?.includes(requirement.requirementId)));
 if(!actions.length||actions.length>100)return deny('text-read-trace-missing');
 for(const action of actions){
  const dispatch=action.operation?.dispatch,args=dispatch?.arguments;
  const o=mission.observations?.find(o=>o.observationId===action.observationId);
  const chunk=o?.data?.textRead,ref=o?.data?.fileEvidence;
  if(action.goalRevision!==contract.revision||action.requirementIds?.length!==1||action.requirementIds[0]!==requirement.requirementId
    ||action.status!=='succeeded'||action.actualToolName!=='filesystem.readText'||dispatch?.toolName!==action.actualToolName||o?.toolName!==action.actualToolName
    ||dispatch.taskId!==action.taskId||o?.taskId!==action.taskId||o.actionId!==action.actionId||o.outcome!=='success'
    ||o.verification?.status!=='passed'||o.verification.failedCheckIds?.length||!o.evidenceId||!o.verification.verificationId)return deny('text-read-receipt-unbound');
  if(typeof args?.path!=='string'||!same(resolve(roots[0],args.path),target)
    ||Object.keys(args).some(k=>!['path','offset','maxChars','rawText'].includes(k))
    ||args.rawText!==undefined&&args.rawText!==action.command)return deny('text-read-dispatch-mismatch');
  if(!integer(ref?.rootIndex)||ref.rootIndex>=roots.length||typeof ref.relativePath!=='string'
    ||!same(resolve(roots[ref.rootIndex],ref.relativePath),target)||ref.contentSha256!==chunk?.sourceSha256)return deny('text-read-file-reference-mismatch');
  if(chunk?.version!=='a-text-read-capture-v1'||typeof chunk.content!=='string'||!chunk.content.isWellFormed()
    ||![chunk.offset,chunk.returnedChars,chunk.sourceChars,chunk.sourceBytes].every(integer)
    ||chunk.returnedChars!==chunk.content.length||chunk.offset!==(args.offset??0)
    ||chunk.nextOffset!==chunk.offset+chunk.returnedChars||chunk.contentSha256!==sha(chunk.content)
    ||chunk.fileTruncated!==(chunk.nextOffset<chunk.sourceChars))return deny('text-read-chunk-invalid');
  receipts.push({action,chunk});
 }
 return {applicable:true,contract,target,root,receipts};
}

/** A single requirement's current read trace, never whole-goal completion. */
export function inspectTextReadRequirement({mission,requirement,allowedRoots=[],beforeRead=null}){
 if((mission.constraints??[]).some(c=>!localConstraints.has(c.statement??c)))return deny('text-read-extra-constraints-unverified');
 const t=trace(mission,allowedRoots,requirement);if(!t.applicable||t.reasons)return t;
 const source=current(t,beforeRead);if(source.reasons)return source;
 return {applicable:true,passed:source.end===source.text.length,status:source.end===source.text.length?'passed':'incomplete',
   nextOffset:source.end,sourceChars:source.text.length,evidenceActionIds:t.receipts.map(r=>r.action.actionId)};
}

function current(trace,beforeRead){
 let fd;
 try{
  beforeRead?.(trace.receipts.at(-1).action.operation.dispatch);
  const path=realpathSync(trace.target),root=realpathSync(trace.root),rel=relative(root,path);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))return deny('text-read-physical-target-outside-root');
  fd=openSync(path,'r');const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size>1048576n)return deny('text-read-independent-size-invalid');
  const bytes=Buffer.alloc(Number(before.size)+1);let count=0;
  while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
  const after=fstatSync(fd,{bigint:true}),now=statSync(path,{bigint:true});
  if(count!==Number(before.size)||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k]||after[k]!==now[k])
    ||!same(realpathSync(trace.target),path))return deny('text-read-independent-source-changed');
  const buffer=bytes.subarray(0,count),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer),hash=sha(buffer);
  beforeRead?.(trace.receipts.at(-1).action.operation.dispatch);
  let end=0;
  for(const {chunk} of trace.receipts){
   if(chunk.pathHash!==sha(path)||chunk.offset!==end||chunk.sourceSha256!==hash||chunk.sourceBytes!==count||chunk.sourceChars!==text.length
     ||chunk.content!==text.slice(chunk.offset,chunk.nextOffset))return deny('text-read-gap-or-source-mismatch');
   end=chunk.nextOffset;
  }
  return {text,end,hash};
 }catch{return deny('text-read-independent-read-failed');}finally{if(fd!==undefined)closeSync(fd);}
}

export function verifyReadOnlyText({mission,allowedRoots=[],evidenceActionIds=null,statement=null,beforeRead=null}){
 if(statement!==null&&!readStatementBound(mission,statement))return {applicable:false};
 // The new original-objective criterion path is exclusive to recognized plain
 // reads. Existence checks and other legacy criteria keep their own verifier.
 if(statement===mission.objective){
  const requirements=mission.goalContract?.requirements,i=requirements?.[0]?.interpretation;
  if(requirements?.length!==1||i?.status!=='recognized'||i.action!=='read'||i.polarity!=='required'
   ||i.compound||i.hasProhibition||i.hasExclusion||i.correction||i.unresolvedReferences?.length||i.unresolvedConditions?.length)return {applicable:false};
 }
 const t=trace(mission,allowedRoots);if(!t.applicable||t.reasons)return t;
 if((mission.constraints??[]).some(c=>!localConstraints.has(c.statement??c)))return deny('text-read-extra-constraints-unverified');
 const source=current(t,beforeRead);if(source.reasons)return source;
 if(source.end!==source.text.length)return deny('text-read-incomplete');
 if(evidenceActionIds&&t.receipts.some(r=>!evidenceActionIds.includes(r.action.actionId)))return deny('text-read-final-evidence-missing');
 return {applicable:true,passed:true,status:'passed',reasons:[],checks:[{checkId:'text-read-full-current-snapshot',passed:true},{checkId:'text-read-exclusive-bound-g-receipts',passed:true}],
  coveredRequirementIds:t.contract.requirements.map(r=>r.requirementId),evidenceActionIds:t.receipts.map(r=>r.action.actionId),sourceChars:source.text.length};
}

export function planReadOnlyTextContinuation({mission,allowedRoots=[],beforeRead=null}){
 if((mission.constraints??[]).some(c=>!localConstraints.has(c.statement??c)))return null;
 const t=trace(mission,allowedRoots);if(!t.applicable||t.reasons)return null;
 const source=current(t,beforeRead);
 if(source.reasons)return {decision:'pause',pauseReason:'mission-text-read-evidence-invalidated',actions:[],criteriaAssessment:[],
  summary:'읽던 자료나 접근 권한이 변경되어 이어읽기를 중지했습니다. 현재 자료와 권한을 확인한 뒤 새 요청으로 다시 읽어 주세요.',
  planning:{mode:'independent-text-read-continuation',modelRoundTrips:0,retryable:false,resumeSupported:false,
   errorCode:'A_TEXT_READ_EVIDENCE_INVALIDATED',sourceEvidenceReason:source.reasons[0]}};
 if(source.end>=source.text.length)return null;
 return {decision:'continue',summary:'현재 원문과 같은 버전의 남은 내용을 읽습니다.',
  planning:{mode:'independent-text-read-continuation',modelRoundTrips:0},criteriaAssessment:[],
  actions:[{id:`text-read-${source.end}`,command:mission.objective,expectedToolName:'filesystem.readText',
    arguments:{path:t.target,offset:source.end,maxChars:50000},dependencies:[],
    requirementIds:t.contract.requirements.map(r=>r.requirementId),successSignal:'같은 원문 버전의 나머지 구간 G 검증'}]};
}
