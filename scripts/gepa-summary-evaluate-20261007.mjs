import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';
import {runLocalSummaryMission} from './local-summary-mission-pilot.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {item,prefix,mission=false,outputRoot}=JSON.parse(input);
if(typeof prefix!=='string'||prefix.length>3000)throw new Error('Bounded candidate prompt required');
const local=createOllamaLocalModelProvider({model:'gemma3:latest',numThreads:3,timeoutMs:150000,
  fetchImpl:(url,options)=>{
    const parsed=new URL(url);
    if(parsed.origin!=='http://127.0.0.1:11434'||!['/api/tags','/api/generate'].includes(parsed.pathname))throw new Error('Unexpected local request');
    let request=options;
    if(parsed.pathname==='/api/generate'){
      const body=JSON.parse(options.body);
      body.options={...body.options,num_gpu:0};
      request={...options,body:JSON.stringify(body)};
    }
    return fetch(`http://127.0.0.1:11436${parsed.pathname}`,request);
  }});
const provider={...local,generateStructured:options=>local.generateStructured({...options,prompt:prefix+'\n\n'+options.prompt})};
const start=performance.now();let output;
try{
  if(mission){
    const report=await runLocalSummaryMission({item,provider,outputRoot});
    output={id:item.id,completed:report.status==='COMPLETED'&&report.outputMatchesIndependentOracle,report};
  }else{
    const result=await generateLocalSourceSummary({source:item.source,questions:item.questions,valueFormats:item.valueFormats},{provider});
    const facts=result.output.facts;
    output={id:item.id,completed:Object.keys(item.expected).every(k=>facts[k]===item.expected[k]),facts,result};
  }
}catch(error){output={id:item.id,completed:false,errorCode:error.code??'EVALUATION_FAILED',attempts:error.attempts??[],usage:error.usage??null};}
output.elapsedMs=performance.now()-start;output.actualCost=null;output.effectiveOptions={num_gpu:0,num_thread:3};
console.log(JSON.stringify(output));
