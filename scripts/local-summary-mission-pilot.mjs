import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {FileMissionStore} from '../packages/core/src/mission/mission-store.js';
import {MissionGrant} from '../packages/core/src/mission/mission-runtime.js';
import {generateLocalSourceSummary} from '../packages/core/src/mission/local-source-summary.js';
import {createOllamaLocalModelProvider} from '../packages/core/src/mission/ollama-local-model-provider.js';

export async function runLocalSummaryMission({item,provider,outputRoot,preferSourceDeclarations=false,executionGrants}={}){
  const root=await mkdtemp(join(tmpdir(),'jarvis-local-summary-'));let runtime,generated,modelFailure;
  try{
    await writeFile(join(root,'source.txt'),item.source);
    const env={JARVIS_TEST_MODE:'1',JARVIS_MISSION_EXECUTIVE:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0'};
    runtime=createAgRuntime({allowedRoots:[root],auditRoot:join(root,'audit'),env,taskEnv:env,workerDaemonEnabled:false,
      missionStore:new FileMissionStore({filePath:join(root,'missions.json')}),missionPlanner:{async planNextWave(context){
        const latest=context.observations.at(-1);
        const searches=context.observations.filter(o=>o.toolName==='filesystem.searchFiles'&&o.outcome==='success').length;
        const reads=context.observations.filter(o=>o.toolName==='filesystem.readText'&&o.outcome==='success').length;
        const search=name=>({decision:'continue',actions:[{id:`find-${name}`,command:`${name} 파일을 찾아줘`,expectedToolName:'filesystem.searchFiles',arguments:{directory:root,scope:'workspace',query:name},dependencies:[]}]});
        if(latest?.toolName==='filesystem.readText'&&reads===2)return {decision:'complete',actions:[],criteriaAssessment:[{criterionId:'facts',status:'satisfied',evidenceActionIds:context.observations.filter(o=>o.actionId&&o.outcome==='success').map(o=>o.actionId)}]};
        if(latest?.toolName==='filesystem.createTextFile')return search('result.txt');
        if(latest?.toolName==='filesystem.searchFiles'&&searches===2)return {decision:'continue',actions:[{id:'reread',command:'result.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'result.txt'),offset:0,maxChars:4000},dependencies:[]}]};
        if(!context.observations.length)return search('source.txt');
        if(latest?.toolName==='filesystem.readText'){
          const capture=latest.data?.textRead;
          if(latest.outcome!=='success'||latest.verification?.status!=='passed'||!latest.verification?.verificationId||!capture||capture.offset!==0||capture.fileTruncated===true||capture.content.length!==item.source.length)
            return {decision:'blocked',actions:[],blockedReason:'verified-source-unavailable'};
          try{generated=await generateLocalSourceSummary({source:capture.content,questions:item.questions,valueFormats:item.valueFormats,...(item.sourceFields?{sourceFields:item.sourceFields}:{})},{provider,preferSourceDeclarations});}
          catch(error){modelFailure={code:error.code??'LOCAL_MODEL_FAILED',attempts:error.attempts??[],providerCalls:error.providerCalls??null,usage:error.usage??null,latencyMs:error.latencyMs??null,costUsd:null,costMeasurement:'unmeasured'};return {decision:'blocked',actions:[],blockedReason:modelFailure.code};}
          return {decision:'continue',actions:[{id:'save',command:'result.txt 텍스트 파일을 만들어줘',expectedToolName:'filesystem.createTextFile',arguments:{path:join(root,'result.txt'),content:JSON.stringify(generated.output.facts)},dependencies:[]}]};
        }
        return {decision:'continue',actions:[{id:'read',command:'source.txt 내용을 읽어줘',expectedToolName:'filesystem.readText',arguments:{path:join(root,'source.txt'),offset:0,maxChars:4000},dependencies:[]}]};
      }}});
    const owner=runtime.personalOwnerSession.activate({requestedBy:'isolated-local-summary-pilot',durationMinutes:20});
    const mission=runtime.missionRuntime.createMission({objective:"'source.txt' 파일을 찾아 내용을 읽고 핵심을 요약해 'result.txt'로 저장하고, 결과 파일을 다시 찾아 내용을 읽어 확인해줘",
      successCriteria:[{criterionId:'facts',statement:'미리 고정한 독립 사실 오라클과 일치',verificationSpec:{version:1,kind:'text.equals',path:'result.txt',equals:JSON.stringify(item.expected)}}],
      authorization:{mode:'trusted_session',ownerSessionId:owner.session.sessionId,grants:executionGrants??[MissionGrant.READ_ONLY,MissionGrant.LOCAL_REVERSIBLE,MissionGrant.HIGH_IMPACT]}});
    const started=performance.now();const result=await runtime.missionRuntime.runMission(mission.missionId,{maxWaves:6});
    let content=null;try{content=await readFile(join(root,'result.txt'),'utf8');}catch{}
    const report={version:'local-summary-mission-pilot-v1',observedAt:new Date().toISOString(),caseId:item.id,status:result.status,stopReason:result.stopReason,
      completionDiagnostics:result.observations.filter(o=>o.error).map(o=>o.error),output:content,outputMatchesIndependentOracle:content===JSON.stringify(item.expected),
      actions:result.waves.flatMap(w=>w.actions).map(a=>({toolName:a.actualToolName,status:a.status,observationId:a.observationId})),
      observations:result.observations.map(o=>({toolName:o.toolName,outcome:o.outcome,verificationStatus:o.verification?.status,error:o.error?.code})),
      model:generated?{provider:generated.provider,model:generated.model,localModel:generated.localModel,runtimeTiming:generated.runtimeTiming??null,generationOptions:generated.generationOptions??null,usage:generated.usage,latencyMs:generated.latencyMs,providerCalls:generated.providerCalls,output:generated.output,attempts:generated.attempts}:null,
      modelFailure:modelFailure??null,totalMs:performance.now()-started,costUsd:null,costMeasurement:'unmeasured',externalPaidCalls:0,
      arbitraryProseQualityVerified:false,originalAcceptancePromoted:false};
    if(outputRoot){await mkdir(outputRoot,{recursive:true});await writeFile(join(outputRoot,'mission.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
    return report;
  }finally{runtime?.coreFacade.cognition.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe fixture cleanup');await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const corpus=JSON.parse(await readFile(new URL('../tests/fixtures/local-summary-quality-v2.json',import.meta.url)));
  const item=corpus.cases.find(c=>c.id===(process.argv[3]??'uncertainty'));
  if(!item)throw new Error('Unknown fixed case');
  const report=await runLocalSummaryMission({item,provider:createOllamaLocalModelProvider({model:'gemma3:latest',timeoutMs:120000,numThreads:process.argv[4]===undefined?null:Number(process.argv[4])}),outputRoot:process.argv[2]});
  console.log(JSON.stringify({status:report.status,outputMatchesIndependentOracle:report.outputMatchesIndependentOracle,totalMs:report.totalMs}));
  if(report.status!=='COMPLETED'||!report.outputMatchesIndependentOracle)process.exitCode=1;
}
