// Explicit user assertions only; model prose is never promoted to a fact.
export function parsePersonalKnowledgeStatement(value) {
  if(typeof value!=='string' || value.length>8000)return null;
  let match=value.trim().match(/^'([^'\r\n]+)'의 '([^'\r\n]+)'(?:은|는) '([^'\r\n]+)'(?:이라고|라고) 기억해줘[.!]?$/u);
  if(match)return {kind:'fact',subject:match[1],predicate:match[2],value:match[3]};
  match=value.trim().match(/^'([^'\r\n]+)'의 '([^'\r\n]+)'(?:을|를) '([^'\r\n]+)'(?:으로|로) 결정했어\. 이유는 '([^'\r\n]+)'(?:이야|야)\. 기억해줘[.!]?$/u);
  return match ? {kind:'decision',subject:match[1],predicate:match[2],value:match[3],reason:match[4]} : null;
}

export function isPersonalKnowledgeSource(event){
 return event?.trustBoundary?.userProvided===true && event.trustBoundary.externalContent!==true
   && event.trustBoundary.systemGenerated!==true
   && (event.payload?.knowledge!==undefined || parsePersonalKnowledgeStatement(event.payload?.rawText)!==null);
}

export function projectPersonalKnowledge(events, { now = new Date(), diagnostics = null, retiredSourceIds = [] } = {}) {
  if(!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw Object.assign(new Error('Knowledge observation clock is unavailable.'),{code:'F_KNOWLEDGE_CLOCK_INVALID'});
  const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
  const excluded = { invalidObservationTime:0, futureObservationTime:0, invalidKnowledge:0 };
  const items = events.flatMap(event => {
    const k = event.payload?.knowledge ?? parsePersonalKnowledgeStatement(event.payload?.rawText);
    if (event.trustBoundary?.userProvided !== true || event.trustBoundary?.externalContent === true
      || event.trustBoundary?.systemGenerated === true || !k) return [];
    if(!timestamp(event.createdAt)){excluded.invalidObservationTime++;return [];}
    if(Date.parse(event.createdAt)>now.getTime()){excluded.futureObservationTime++;return [];}
    if(!['fact','decision'].includes(k.kind) || !text(k.subject) || !text(k.predicate) || !text(k.value)
      || (k.kind === 'decision' && !text(k.reason))
      || (k.validUntil !== undefined && !timestamp(k.validUntil))
      || (k.supersedesEventId !== undefined && !text(k.supersedesEventId))){excluded.invalidKnowledge++;return [];}
    return [{ kind:k.kind, subject:k.subject, predicate:k.predicate, value:k.value,
      ...(k.kind === 'decision' ? {reason:k.reason} : {}),
      basis:'user-statement', sourceEventId:event.eventId, taskId:event.taskId,
      observedAt:event.createdAt, validUntil:k.validUntil ?? null,
      supersedesEventId:k.supersedesEventId ?? null,
      status:k.validUntil && Date.parse(k.validUntil) <= now.getTime() ? 'expired' : 'active',
      executionAuthority:false }];
  });
  const byId = new Map(items.map(item => [item.sourceEventId,item]));
  const sameKey = (a,b) => a.kind === b.kind && a.subject === b.subject && a.predicate === b.predicate;
  const validity=new Map(),observedTimes=new Map(items.map(item=>[item,Date.parse(item.observedAt)]));
  const uniqueIds=byId.size===items.length;
  for(const item of items){
    if(uniqueIds && validity.has(item))continue;
    const path=[],visited=new Set();let current=item,valid=true;
    while(true){
      if(uniqueIds && validity.has(current)){valid=validity.get(current);break;}
      if(visited.has(current.sourceEventId)){valid=false;break;}
      visited.add(current.sourceEventId);path.push(current);
      if(!current.supersedesEventId)break;
      const ancestor=byId.get(current.supersedesEventId);
      if(!ancestor || visited.has(ancestor.sourceEventId) || !sameKey(current,ancestor)
        || observedTimes.get(current)<=observedTimes.get(ancestor)){valid=false;break;}
      current=ancestor;
    }
    if(uniqueIds)for(const member of path)validity.set(member,valid);
    else validity.set(item,valid);
  }
  for(const item of items){
    if(!item.supersedesEventId)continue;
    if(!validity.get(item)){
      if(item.status==='active')item.status='correction-unresolved';continue;
    }
    // Apply only after all lineage validation; never overwrite an unresolved
    // predecessor merely because its immediate child has a newer timestamp.
    byId.get(item.supersedesEventId).status='superseded';
  }
  const retired=new Set(retiredSourceIds);
  for(const item of items)if(retired.has(item.sourceEventId))item.status='superseded';
  const groups=new Map();
  for(const item of items){
    if(item.status!=='active')continue;
    const key=JSON.stringify([item.kind,item.subject,item.predicate]);
    const group=groups.get(key)??{items:[],values:new Set()};
    group.items.push(item);group.values.add(item.value);groups.set(key,group);
  }
  for(const group of groups.values())if(group.values.size>1)for(const item of group.items)item.status='conflict';
  if(diagnostics && typeof diagnostics==='object')Object.assign(diagnostics,{excluded,
    scope:'eligible-sources-only', checkedAt:now.toISOString(),
    nextAction:Object.values(excluded).some(count=>count>0)?'check-record-time-and-required-fields':null});
  return items;
}
