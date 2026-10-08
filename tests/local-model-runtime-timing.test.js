import test from 'node:test';import assert from 'node:assert/strict';
import {localModelRuntimeTiming} from '../packages/core/src/mission/local-model-observation.js';
test('runtime timing converts ns without inventing unknown values or retaining arbitrary metadata',()=>{
 assert.deepEqual(localModelRuntimeTiming({total_duration:5000000000,load_duration:1000000000,prompt_eval_duration:2000000000,eval_duration:2000000000,eval_count:10,prompt:'secret'}),{version:'ollama-runtime-timing-v1',basis:'provider-reported',totalMs:5000,loadMs:1000,promptEvalMs:2000,generationMs:2000,outputTokensPerSecond:5});
 for(const value of [{},{total_duration:-1},{total_duration:'1000'},{eval_duration:0,eval_count:1},{eval_duration:Infinity}]){const result=localModelRuntimeTiming(value);assert.equal(result.totalMs,null);assert.equal(result.outputTokensPerSecond,null);assert.equal('prompt' in result,false);}
});
