// Device-selected metadata is a temporary observation, never an execution grant.
export function createPcTaskCatalog({request,changed,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let scope=null,items=new Map(),pending=null,timer=null,expiryTimer=null,revision=0,state='idle',nextOffset=0,hasMore=false;
  const stopTimer=()=>{if(timer!==null)clearTimer(timer);timer=null;};
  function reset(next=null){stopTimer();if(expiryTimer!==null)clearTimer(expiryTimer);expiryTimer=null;revision++;scope=next;items=new Map();pending=null;state='idle';nextOffset=0;hasMore=false;}
  function valid(result,page){
    const value=result?.observation?.value,expected=scope.taskIds.slice(page.offset,page.offset+100);
    return result?.deviceId===scope.deviceId&&result.deviceGeneration===scope.generation&&result.authorityToken===scope.authorityToken
      &&result.state==='observed'&&result.observationCurrent===true&&clock()<Date.parse(result.observationCurrentUntil)
      &&result.observation?.status==='observed'&&value?.executionAuthority===false&&value.verifiedCompletion===false
      &&value.offset===page.offset&&value.totalEntries===scope.taskIds.length&&value.hasMore===(page.offset+expected.length<scope.taskIds.length)
      &&Array.isArray(value.items)&&value.items.length===expected.length&&value.items.every((item,i)=>item&&item.taskId===expected[i]
        &&typeof item.title==='string'&&item.title.length<=80&&typeof item.status==='string'&&typeof item.available==='boolean'
        &&(item.dryRun===null||typeof item.dryRun==='boolean'));
  }
  function scheduleExpiry(){
    if(expiryTimer!==null)clearTimer(expiryTimer);expiryTimer=null;
    const ends=[...items.values()].map(i=>i.currentUntil).filter(t=>t>clock());
    if(ends.length)expiryTimer=setTimer(()=>{expiryTimer=null;changed();scheduleExpiry();},Math.max(1,Math.min(...ends)-clock()+1));
  }
  async function queue(page){
    await request(`/pc-nodes/${encodeURIComponent(scope.deviceId)}/observations`,{method:'POST',body:{requestId:page.requestId,operation:'task-catalog',taskId:null,offset:page.offset,limit:100}});
    if(pending===page&&revision===page.revision){page.queued=true;void poll(page);}
  }
  async function poll(page,left=20){
    if(pending!==page||page.revision!==revision||!scope)return;
    stopTimer();
    try{
      const result=await request(`/pc-nodes/observations/${encodeURIComponent(page.requestId)}`);
      if(pending!==page||page.revision!==revision||!scope)return;
      if(['queued','leased'].includes(result?.state)){
        state=left?'waiting':'waiting-retry';
        if(left)timer=setTimer(()=>void poll(page,left-1),500);
      }else{
        pending=null;
        if(!valid(result,page)){state='unavailable';changed();return;}
        for(const item of result.observation.value.items)items.set(item.taskId,{...item,currentUntil:Date.parse(result.observationCurrentUntil)});
        nextOffset=page.offset+result.observation.value.items.length;hasMore=result.observation.value.hasMore;state='observed';
        scheduleExpiry();
      }
      changed();
    }catch{if(pending===page&&page.revision===revision){state='waiting-retry';changed();}}
  }
  async function load(next=false){
    if(!scope||!Number.isSafeInteger(scope.authorityToken)||scope.authorityToken<1)return;
    if(pending){if(state==='waiting-retry'){const page=pending;try{if(page.queued)void poll(page);else await queue(page);}catch{if(pending===page){state='waiting-retry';changed();}}}return;}
    if(next&&!hasMore)return;
    if(!next){stopTimer();items=new Map();scheduleExpiry();nextOffset=0;hasMore=false;}
    const page={offset:next?nextOffset:0,revision,requestId:`catalog-${crypto.randomUUID()}`};
    pending=page;state='waiting';changed();
    try{
      await queue(page);
    }catch{if(pending===page&&revision===page.revision){state='waiting-retry';changed();}}
  }
  return {reset,load,dispose:()=>reset(),invalidateAuthority(active,token){if(scope&&(!active||scope.authorityToken!==token))reset();},
    view(){const current=new Map([...items].filter(([,item])=>clock()<item.currentUntil));return {items:current,state:!pending&&items.size&&!current.size?'stale':state,
      waiting:Boolean(pending)&&state==='waiting',hasMore,nextOffset};}};
}
