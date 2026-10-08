// Reads are prefiltered by the caller using trusted task/evidence/file identity.
// Select a contiguous, chronological chain; repeated reads do not add coverage
// and a later complete reread can replace an earlier abandoned partial chain.
export function completeTextReadChain({reads, mission, sourceFile, before = Infinity}) {
  const chains=new Map([[0,{actions:[],lastObserved:-Infinity}]]);
  for (const action of reads) {
    const dispatch=action.operation?.dispatch;
    const observation=(mission.observations??[]).find(o=>o.observationId===action.observationId);
    const extent=observation?.data?.readExtent;
    const at=Date.parse(dispatch?.dispatchedAt), observed=Date.parse(observation?.createdAt);
    const requestedOffset=dispatch?.arguments?.offset === undefined ? 0 : dispatch.arguments.offset;
    const requestedMax=dispatch?.arguments?.maxChars === undefined ? 12000 : dispatch.arguments.maxChars;
    if (!extent || !Number.isSafeInteger(extent.offset) || !Number.isSafeInteger(extent.returnedChars)
      || extent.offset<0 || extent.offset!==requestedOffset || extent.returnedChars<0
      || !Number.isSafeInteger(requestedMax) || requestedMax<1 || requestedMax>50000 || extent.returnedChars>requestedMax
      || !Number.isFinite(at) || !Number.isFinite(observed) || at>observed || observed>before
      || extent.bytes!==sourceFile.bytes || extent.encoding!=='utf8') continue;
    const end=extent.offset+extent.returnedChars;
    const low=n=>n>=0xdc00&&n<=0xdfff;
    if (end>sourceFile.text.length || low(sourceFile.text.charCodeAt(extent.offset)) || low(sourceFile.text.charCodeAt(end))
      || extent.truncated!==(end<sourceFile.text.length) || (extent.returnedChars===0 && sourceFile.text.length>0)) continue;
    // A prompt may withhold the tail of an observed chunk. Reading that tail
    // again overlaps the earlier adapter range but must not leave a gap or
    // count those characters twice. Prefer a standalone reread from zero.
    const prior=extent.offset===0?chains.get(0):[...chains.entries()]
      .filter(([covered,chain])=>covered>=extent.offset&&covered<end&&chain.lastObserved<=at)
      .sort((a,b)=>a[1].lastObserved-b[1].lastObserved)[0]?.[1];
    if(!prior||at<prior.lastObserved)continue;
    const selected=[...prior.actions,action];
    if(end===sourceFile.text.length)return selected;
    const previous=chains.get(end);
    if(!previous||observed<previous.lastObserved)chains.set(end,{actions:selected,lastObserved:observed});
  }
  return null;
}
