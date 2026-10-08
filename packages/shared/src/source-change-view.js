const numeric=value=>typeof value==='string'&&value.length<=120&&/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value);
const text=(value,limit)=>typeof value==='string'&&!!value.trim()&&value.length<=limit&&!/[\u0000-\u001f\u007f]/u.test(value);
const modes=new Set(['increase-percent','decrease-percent','inverse-increase-percent']);
/** Bounded historical arithmetic receipt. This grants no source truth or authority. */
export function sourceChangeView(value){
 if(value?.schemaVersion!=='source-change-comparison-v1'||value.verificationScope!=='supplied-source-values-arithmetic-only'
  ||!modes.has(value.metric)||typeof value.claimConsistentWithInputs!=='boolean')return null;
 const before=value.inputs?.before,after=value.inputs?.after,claim=value.inputs?.claim;
 if(!numeric(before?.value)||!numeric(after?.value)||!numeric(claim?.value)||!numeric(value.calculatedPercent?.approximate)
  ||!numeric(value.claimDifferencePercentPoints?.approximate)||!numeric(value.tolerancePercentPoints)
  ||!text(value.unit,12)||before.unit!==value.unit||after.unit!==value.unit||claim.unit!=='%'
  ||!text(claim.claimedBy,80)||!text(claim.sourceLabel,80)
  ||![before,after,claim].every(input=>/^[a-f0-9]{64}$/u.test(input?.sourceSha256??'')))return null;
 return checkedSourceChangeView({viewVersion:'source-change-view-v1',metric:value.metric,unit:value.unit,before:before.value,after:after.value,claimedBy:claim.claimedBy,sourceLabel:claim.sourceLabel,
  claimPercent:claim.value,calculatedPercent:value.calculatedPercent.approximate,claimDifferencePercentPoints:value.claimDifferencePercentPoints.approximate,
  tolerancePercentPoints:value.tolerancePercentPoints,claimConsistentWithInputs:value.claimConsistentWithInputs,
  sourceSha256s:[...new Set([before.sourceSha256,after.sourceSha256,claim.sourceSha256])],
  inputsIndependentlyVerified:false,currentSourceVerified:false,executionAuthority:false});
}
export function checkedSourceChangeView(value){
 if(value?.viewVersion!=='source-change-view-v1'||!modes.has(value.metric)||!text(value.unit,12)||!text(value.claimedBy,80)||!text(value.sourceLabel,80)
  ||!['before','after','claimPercent','calculatedPercent','claimDifferencePercentPoints','tolerancePercentPoints'].every(key=>numeric(value[key]))
  ||typeof value.claimConsistentWithInputs!=='boolean'||!Array.isArray(value.sourceSha256s)||!value.sourceSha256s.length||value.sourceSha256s.length>3
  ||!value.sourceSha256s.every(sha=>/^[a-f0-9]{64}$/u.test(sha)))return null;
 return Object.fromEntries([...['viewVersion','metric','unit','before','after','claimedBy','sourceLabel','claimPercent','calculatedPercent','claimDifferencePercentPoints','tolerancePercentPoints','claimConsistentWithInputs'].map(key=>[key,value[key]]),
  ['sourceSha256s',[...value.sourceSha256s]],
  ...(value.metric==='inverse-increase-percent'?[['assumptions',['equal-workload']],['equalWorkloadVerified',false]]:[]),
  ['inputsIndependentlyVerified',false],['currentSourceVerified',false],['executionAuthority',false]]);
}
