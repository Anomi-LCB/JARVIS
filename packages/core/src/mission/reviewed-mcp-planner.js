import {randomUUID} from 'node:crypto';

/** Plans only installed, reviewed whole-request bindings. E/B/G remain authoritative. */
export function planReviewedMcpMission({mission,packageRegistry,adapterRegistry}){
 if(!mission||mission.constraints?.length)return null;
 const matches=[];
 for(const activation of packageRegistry?.status?.().activations??[]){
  if(!activation.toolName?.startsWith('mcp.')||!Object.values(activation.projections??{}).every(Boolean))continue;
  const contract=adapterRegistry?.contractFor?.(activation.toolName);
  if(contract?.readOnly!==true||contract.effectScope!=='external'||!contract.intentBinding?.resolve)continue;
  try{const resolved=contract.intentBinding.resolve(mission.objective);if(resolved?.toolName===activation.toolName)matches.push(resolved);}catch{continue;}
 }
 if(!matches.length)return null;
 if(matches.length!==1)return {decision:'blocked',blockedReason:'reviewed-mcp-command-ambiguous',actions:[],criteriaAssessment:[]};
 const match=matches[0],prior=(mission.waves??[]).flatMap(w=>w.actions??[]).filter(a=>a.expectedToolName===match.toolName||a.command===mission.objective);
 if(prior.length){
  const confirmed=prior.some(action=>action.status==='succeeded'&&(mission.observations??[]).some(o=>o.actionId===action.actionId&&o.outcome==='success'&&o.verification?.status==='passed'));
  return confirmed?{decision:'complete',summary:'등록된 원문과 독립 검증 결과를 최종 기준에서 대조합니다.',actions:[],criteriaAssessment:[]}
   :{decision:'blocked',blockedReason:'reviewed-mcp-prior-result-needs-review',actions:[],criteriaAssessment:[]};
 }
 return {decision:'continue',summary:'검토된 전체 명령으로 등록 도구를 선택했습니다. 실행 권한과 결과 검증은 별도로 확인합니다.',criteriaAssessment:[],
  planning:{provider:'reviewed-local-mcp',modelRoundTrips:0},actions:[{id:'reviewed_mcp_read',title:'등록된 자료 확인',command:mission.objective,
   expectedToolName:match.toolName,arguments:{objective:mission.objective,arguments:match.arguments,requestId:randomUUID(),expectedText:match.expectedText},
   dependencies:[],successSignal:'원문 연결 및 독립 검증 영수증'}]};
}
