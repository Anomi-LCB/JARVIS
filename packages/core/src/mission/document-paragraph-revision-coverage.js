import {resolve,relative,isAbsolute,sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {layoutRequirementsSha256} from '../../../shared/src/artifact-layout-requirements.js';

// A user-supplied replacement criterion supplies the exact revised body.
// Neither model arguments nor a generic "apply" clause supply that authority.
export function documentParagraphRevisionCoverage({mission,roots,isVerified}){
 const c=mission.goalContract,rs=c?.requirements;
 if(c?.objective!==mission.objective||c?.revision<2||rs?.length!==2||mission.constraints?.length||c.constraints?.length
  ||c.contradictions?.length||c.unresolvedCriterionIds?.length||c.revisionChange?.invalidatedCriterionIds?.length||c.revisionChange?.effectConflicts?.length)return null;
 const first=/^(?:['“]([^'”\r\n]+\.docx)['”]|([^\s'“”]+\.docx))\s+(?:워드|Word)\s+(?:문서|파일)(?:를|을)?\s+(?:만들어줘|만들어주세요|생성해줘|생성해주세요)[.!。]?$/iu.exec(rs[0].text);
 if(!first||!/^(?:수정된|새|새로운)\s+제목과\s+본문(?:\s+문단)?\s+순서를\s+(?:적용해|적용해줘|적용해주세요)[.!。]?$/u.test(rs[1].text))return null;
 const revision=mission.goalRevisionRequests?.find(r=>r.state==='applied'&&r.targetRevision===c.revision);
 const criteria=mission.successCriteria;
 if(!revision||revision.input.objective!==mission.objective||!isDeepStrictEqual(revision.input.successCriteria,criteria)
  ||criteria?.length!==1||criteria[0].verificationSpec?.kind!=='document.paragraphs')return null;
 const spec=criteria[0].verificationSpec,target=resolve(roots[0]??'.',first[1]??first[2]);
 if(!roots.some(root=>{const r=relative(root,target);return !isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);})||resolve(roots[0]??'.',spec.path)!==target)return null;
 const actions=mission.waves.flatMap(w=>w.actions);
 if(actions.length!==1)return null;
 const a=actions[0],d=a.operation?.dispatch,args=d?.arguments;
 if(!isVerified(a)||a.actualToolName!=='word.create'||d?.toolName!==a.actualToolName||d.taskId!==a.taskId||resolve(args?.path??'.')!==target
  ||!Array.isArray(args.blocks)||!args.blocks.length||args.blocks.some(b=>!['paragraph','heading'].includes(b.type)||typeof b.text!=='string'))return null;
 const paragraphs=[...(args.title?[args.title]:[]),...args.blocks.map(b=>b.text)].flatMap(v=>typeof v==='string'?v.replace(/\r\n?/g,'\n').split('\n'):[]);
 if(!isDeepStrictEqual(paragraphs,spec.equals))return null;
 const o=mission.observations.find(o=>o.observationId===a.observationId);
 if(!o?.data?.artifactLayoutProofs?.some(p=>p.kind==='document.paragraphs'&&p.requirementsSha256===layoutRequirementsSha256('document.paragraphs',spec.equals)))return null;
 return {required:true,allowed:true,status:'typed-document-paragraph-revision-source-coverage',sourceBindingVerified:true,
  semanticAccuracyVerified:false,coveredRequirementIds:rs.map(r=>r.requirementId),evidenceActionIds:[a.actionId],reasons:[],resultCriteriaVerificationRequired:true};
}
