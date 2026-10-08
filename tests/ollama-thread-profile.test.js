import test from 'node:test';import assert from 'node:assert/strict';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';
test('thread comparison changes only validated compute setting and records immutable effective options',async()=>{
 for(const threads of [null,3,6]){
  let calls=0,body;
  const provider=createOllamaLocalModelProvider({model:'gemma3:latest',numThreads:threads,fetchImpl:async(url,init)=>{calls++;if(calls===1)return Response.json({models:[{name:'gemma3:latest',size:1000}]});body=JSON.parse(init.body);return Response.json({model:'gemma3:latest',done:true,response:'{"ok":true}'});}});
  const r=await provider.generateStructured({prompt:'fixed',schema:{type:'object'}});
  assert.deepEqual(body.options,{temperature:0,num_predict:384,num_ctx:8192,...(threads===null?{}:{num_thread:threads})});
  assert.deepEqual(r.generationOptions,body.options);assert.equal(Object.isFrozen(r.generationOptions),true);assert.equal(r.executionAuthorized,false);
 }
 for(const threads of [0,-1,1.5,'6',65,Infinity,NaN])assert.throws(()=>createOllamaLocalModelProvider({model:'gemma3:latest',numThreads:threads}),{code:'A_LOCAL_MODEL_CONFIG_INVALID'});
});
