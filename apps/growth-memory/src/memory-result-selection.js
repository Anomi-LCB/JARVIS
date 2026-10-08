// Selection only. Every pool must already satisfy relevance and source/scope checks.
// Round-robin keeps a large pool from excluding every item in another pool.
function identity(item) {
 for (const field of ['preferenceId','hypothesisId','patternId','failureId','observationId','memoryId']) {
  if (typeof item?.[field] === 'string' && item[field]) return `${field}:${item[field]}`;
 }
 return null;
}

export function selectMemoryResults(pools, {limit=10}={}) {
 if (!Number.isSafeInteger(limit) || limit<0 || limit>100) throw new RangeError('Invalid memory result limit');
 const positions=pools.map(()=>0), seenIds=new Set(), seenObjects=new Set(), results=[];
 while(results.length<limit) {
  let advanced=false;
  for(let i=0;i<pools.length && results.length<limit;i++) {
   while(positions[i]<pools[i].length) {
    const item=pools[i][positions[i]++]; advanced=true;
    const key=identity(item);
    if (key ? seenIds.has(key) : seenObjects.has(item)) continue;
    if(key)seenIds.add(key);else seenObjects.add(item);
    results.push(item);break;
   }
  }
  if(!advanced)break;
 }
 return results;
}
