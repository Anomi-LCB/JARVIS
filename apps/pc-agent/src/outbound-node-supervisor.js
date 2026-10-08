/** Bounded, independent read/command polling. No readiness or completion claim
 * follows merely from starting; transient errors never trigger an effect replay.
 */
export function createPcOutboundNodeSupervisor({observer,dispatcher=null,close,intervalMs=250,maxIdleMs=5000}={}){
  if(typeof observer?.tick!=='function'||dispatcher!==null&&typeof dispatcher?.tick!=='function'||typeof close!=='function'
    ||!Number.isInteger(intervalMs)||intervalMs<100||intervalMs>5000||!Number.isInteger(maxIdleMs)||maxIdleMs<intervalMs||maxIdleMs>30000)throw new Error('B_PC_OUTBOUND_NODE_CONFIG_INVALID');
  let running=false,stopping=false,closed=false,timer=null,inFlight=null,idleRounds=0,ticks=0,failures=0,last=null,closing=null;
  const status=()=>({running,stopping:stopping&&!closed,stopped:closed,commandConfigured:dispatcher!==null,ticks,failures,last,connectedVerified:false});
  const run=()=>{
    if(!running||stopping||inFlight)return;
    inFlight=(async()=>{
      const values=await Promise.allSettled([Promise.resolve().then(()=>observer.tick()),...(dispatcher?[Promise.resolve().then(()=>dispatcher.tick())]:[])]);
      ticks++;let active=false;const outcomes=[];
      for(const value of values){
        if(value.status==='rejected'){failures++;outcomes.push('unavailable');}
        else{const state=value.value?.status;outcomes.push(['idle','busy','observed'].includes(state)?state:'unknown');if(state==='observed')active=true;}
      }
      last={at:new Date().toISOString(),read:outcomes[0],command:dispatcher?outcomes[1]:null};
      idleRounds=active?0:Math.min(idleRounds+1,8);
    })().finally(()=>{
      inFlight=null;
      if(running&&!stopping)timer=setTimeout(run,Math.min(maxIdleMs,intervalMs*2**idleRounds));
    });
  };
  return {
    status,
    start(){if(stopping)throw new Error('B_PC_OUTBOUND_NODE_STOPPED');if(!running){running=true;run();}return status();},
    stop(){
      if(closing)return closing;stopping=true;running=false;clearTimeout(timer);
      closing=(async()=>{try{await close();}finally{await inFlight;closed=true;}return status();})();return closing;
    }
  };
}
