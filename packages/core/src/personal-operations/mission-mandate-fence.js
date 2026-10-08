/** Private in-process guard. This adds no execution permission or provider scope. */
export function withMissionMandateFence({ mission, gate, executor, hooks, workspaceRoot }) {
  if (!mission.executionMandateId) return hooks;
  const assertCurrent = packet => {
    if (!gate) throw new Error('A_MANDATE_SERVICE_UNAVAILABLE');
    return gate.beforeAction(mission,{packet,workspaceRoot});
  };
  return {
    ...(hooks ?? {}),
    beforeVerification(packet) {
      assertCurrent(packet);
      hooks?.beforeVerification?.(packet);
      assertCurrent(packet);
    },
    async beforeExecute(packet) {
      if(gate?.requiresScopedPacket?.(mission)&&executor.supportsTrustedLocalMissionEffects?.()!==true) {
        throw Object.assign(new Error('A_MANDATE_REMOTE_SCOPE_OBSERVATION_UNSUPPORTED'),{notDispatched:true});
      }
      // A remote file effect already has its durable cancellation protocol.
      // A one-time HTTP check cannot substitute for a final executor fence.
      if (executor.supportsTrustedLocalMissionEffects?.() !== true
          && typeof hooks?.beforeExecute !== 'function') {
        throw Object.assign(new Error('A_MANDATE_EXECUTOR_FENCE_UNSUPPORTED'), { notDispatched: true });
      }
      const initialRefs=assertCurrent(packet);
      const original = hooks?.beforeExecute ? await hooks.beforeExecute(packet) : null;
      if (hooks?.beforeExecute && typeof original !== 'function') throw new Error('B_LOCAL_EFFECT_FENCE_INVALID');
      const observedAccesses=new Map();
      const checkAccess=access=>{
        const ref=gate.beforeWorkflowDataAccess(mission,{packet,workspaceRoot,...access});
        if(ref!==access.ref)throw new Error('A_MANDATE_FILE_IDENTITY_CHANGED');
      };
      const assertBase = () => {
        const refs=assertCurrent(packet);
        if(JSON.stringify(refs)!==JSON.stringify(initialRefs))throw new Error('A_MANDATE_FILE_IDENTITY_CHANGED');
        original?.();
      };
      const fence = () => {
        assertBase();
        for(const access of observedAccesses.values())checkAccess(access);
      };
      if(gate?.requiresScopedPacket?.(mission)&&packet?.action?.toolName==='workflow.execute'){
        fence.assertWorkflowAccess=(path,{kind}={})=>{
          fence();
          const ref=gate.beforeWorkflowDataAccess(mission,{packet,workspaceRoot,path,kind}),key=JSON.stringify([kind,path]);
          const prior=observedAccesses.get(key);
          if(prior&&prior.ref!==ref)throw new Error('A_MANDATE_FILE_IDENTITY_CHANGED');
          const access=prior??{path,kind,ref};observedAccesses.set(key,access);
          return ()=>{fence();checkAccess(access);};
        };
        // A metadata walk checks the current path at every IO boundary. Past
        // metadata identities are reconciled by the full fence at walk end,
        // the next node and publication; byte/write identities remain checked.
        // This private hook cannot be supplied through an execution packet.
        fence.assertWorkflowInventoryAccess=path=>{
          assertBase();
          for(const access of observedAccesses.values())if(access.kind!=='inventory')checkAccess(access);
          const kind='inventory',ref=gate.beforeWorkflowDataAccess(mission,{packet,workspaceRoot,path,kind}),key=JSON.stringify([kind,path]);
          const prior=observedAccesses.get(key);
          if(prior&&prior.ref!==ref)throw new Error('A_MANDATE_FILE_IDENTITY_CHANGED');
          observedAccesses.set(key,prior??{path,kind,ref});
        };
      }
      if (typeof original?.onRemoteCancellation === 'function') {
        fence.onRemoteCancellation = value => original.onRemoteCancellation(value);
      }
      fence();
      return fence;
    }
  };
}
