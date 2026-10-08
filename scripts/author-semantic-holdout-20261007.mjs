import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {validateAuthorCommand,validateAuthorAnnotation} from './semantic-author-validation.mjs';
const output=resolve(process.argv[2]??'artifacts/semantic-holdout-20261007-author-v2');
if(!output.startsWith(resolve('artifacts')+'\\'))throw new Error('Artifact output required');
mkdirSync(output,{recursive:false});
const write=(name,data)=>writeFileSync(resolve(output,name),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const startedAt=new Date().toISOString(),base='http://127.0.0.1:11438';
const chatMode=process.argv.includes('--chat');
const domains=['PC·파일·Office','웹·뉴스·신학 연구','이메일·메신저','일정·협업','여행·교통·숙박','쇼핑·반품·행정','예산·금융·세금','Android·모바일','웨어러블·건강기록','스마트홈·물리기기','가족·접근성·긴급상황','장기목표·기억·재시작','개발운영·기회탐색'];
const schema={type:'object',additionalProperties:false,required:['cases'],properties:{cases:{type:'array',minItems:2,maxItems:2,items:{type:'object',additionalProperties:false,
 required:['command','requirements'],properties:{command:{type:'string'},requirements:{type:'array',minItems:3,maxItems:6,items:{type:'object',additionalProperties:false,
 required:['text','action','target','polarity'],properties:{text:{type:'string'},action:{type:'string',enum:['read','list','save','send','delete','change','summarize','unsupported']},target:{type:'string'},polarity:{type:'string',enum:['required','prohibited']}}}}}}}}};
const system=`당신은 한국어 자연어 시스템의 독립 시험문제 작성자입니다. 구현 코드, 기존 시험문제, 정답은 제공받지 않았습니다. 합성 이름·자료만 사용하고 개인 정보나 실제 계정은 만들지 마세요.
각 command는 자연스럽고 서로 다른 3~6개 요구를 포함합니다. requirements.text는 command에 정확히 그대로 존재하는 서로 겹치지 않는 연속 부분문장입니다. 모든 요청·금지 조건을 빠짐없이 분해하며 원문 순서로 작성하세요. 여러 요구를 하나로 합치지 마세요.
action은 의미상 읽기 read, 목록 list, 저장 save, 보내기 send, 삭제 delete, 변경 change, 요약 summarize입니다. 예약·구매·진단·권한상승·물리동작처럼 이7분류와 다른 요구는 unsupported입니다. target은 정확한 명시 대상 또는 명시된 파일명/서비스명이며 모호하면 빈 문자열입니다. polarity는 하라는 요청 required, 하지말라는 금지 prohibited입니다. 금지의 다양한 한국어 표현을 사용하세요.
첫 사례는 명시 대상과 금지가 있는 복합 요청, 둘째는 정정/대명사/모호함 중 하나와 독립 읽기가 혼합된 요청입니다. semicolon 나열만 반복하지 말고 일반 한국어 문장으로 작성하세요. '처리해' 같은 모호한 표현만 쓰지 마세요. 출력은 아래 스키마를 따르는 JSON뿐입니다.\n${JSON.stringify(schema)}`;
const commandSchema={type:'object',additionalProperties:false,required:['commands'],properties:{commands:{type:'array',minItems:2,maxItems:2,items:{type:'string',description:'실제로 사용자가 요청하는 긴 한국어 복합 명령문 전체'}}}};
const annotationSchema={type:'object',additionalProperties:false,required:['requirements'],properties:{requirements:schema.properties.cases.items.properties.requirements}};
const commandInstruction='한국어 복합 명령문을 만드는 독립 시험 작성자입니다. 구현 코드와 기존 시험은 제공받지 않았습니다. 해당 영역의 서로 다른 명령문 두 개를 자연스러운 한국어로 작성하세요. 각 문장은 독립 요구3~6개와 명시 대상, 하지 말라는 금지를 포함해야 합니다. 첫 문장은 명시 대상, 둘째는 정정 또는 대명사 또는 모호한 대상과 독립 읽기가 섞이게 하세요. 실제 계정 대신 합성 자료를 쓰세요. commands 배열에는 분류명이 아니라 요청 문장 전체를 넣으세요. 설명·분류·정답은 쓰지 마세요.';
const annotationInstruction='다음 한국어 명령을 원문을 변경하지 않고 독립적인 요구3~6개로 분해하세요. requirements의 text는 원문에 정확히 그대로 있는 서로 겹치지 않는 연속 부분문장이고 원문 순서여야 합니다. action은 read=읽기,list=목록,save=저장,send=보내기,delete=삭제,change=변경,summarize=요약,unsupported=예약/구매/진단/권한상승/물리동작 등 이7분류 밖 동작입니다. target은 명시된 대상 문자열이며 모호하면 빈 문자열, polarity는 required=하라는 요청,prohibited=하지말라는 금지입니다. 새 명령이나 추론된 대상을 만들지 말고 원문의 모든 요청과 금지를 보존하세요. JSON만 출력하세요.';
write('author-contract.json',{startedAt,model:'gemma3:latest',transport:chatMode?'chat':'generate',domains,schema,commandSchema,annotationSchema,commandInstruction,annotationInstruction,productionCodeProvided:false,previousCasesProvided:false,
 plannedCases:26,expandedEvaluationCases:260,expandedGenerationStarted:false,humanExpertReview:false});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(?:TOKEN|SECRET|API_KEY|PASS|PROXY)$/i.test(k)&&!/^JARVIS_/i.test(k)));
const server=spawn('C:/Users/user/AppData/Local/Programs/Ollama/ollama.exe',['serve'],{windowsHide:true,env:{...env,OLLAMA_HOST:'127.0.0.1:11438',OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1'},stdio:['ignore','pipe','pipe']});
server.stdout.on('data',b=>appendFileSync(resolve(output,'server.log'),b));server.stderr.on('data',b=>appendFileSync(resolve(output,'server.log'),b));
let exited=false;server.on('exit',()=>exited=true);server.on('error',error=>{appendFileSync(resolve(output,'server.log'),String(error));exited=true;});
const all=[];
try{
 for(let i=0;i<40;i++){
  if(exited)throw new Error('Author model server terminated');
  try{const tags=await (await fetch(base+'/api/tags',{signal:AbortSignal.timeout(1500)})).json();
   const model=tags.models.find(m=>m.name==='gemma3:latest');if(!model)throw new Error('Installed local model missing');write('model.json',{observedAt:new Date().toISOString(),model});break;
  }catch(error){if(i===39)throw error;await new Promise(r=>setTimeout(r,500));}
 }
 const generate=async(name,prompt,format,seed,numPredict)=>{
  const groundedPrompt=prompt+'\nJSON 출력 스키마: '+JSON.stringify(format);
  const request={model:'gemma3:latest',...(chatMode?{messages:[{role:'user',content:groundedPrompt}]}:{prompt}),format,stream:false,keep_alive:'5m',options:{num_gpu:0,num_thread:3,temperature:0.2,seed,num_predict:numPredict,num_ctx:8192}};
  write(`request-${name}.json`,request);const began=performance.now();
  const response=await fetch(base+(chatMode?'/api/chat':'/api/generate'),{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(900000),body:JSON.stringify(request)});
  if(!response.ok)throw new Error('Author model HTTP '+response.status);
  const result=await response.json();write(`response-${name}.json`,{observedAt:new Date().toISOString(),elapsedMs:performance.now()-began,result});
  if(!result.done||result.done_reason==='length')throw new Error('Author response incomplete');return JSON.parse(chatMode?result.message?.content:result.response);
 };
 for(let domainIndex=0;domainIndex<domains.length;domainIndex++){
  const begin=performance.now();let generated,commandError;
  for(let attempt=0;attempt<3;attempt++){
   generated=await generate(`${domainIndex}-commands-${attempt}`,commandInstruction+'\n영역: '+domains[domainIndex]+(commandError?'\n이전 작성은 '+commandError+'로 거부됐습니다. 사건 설명이 아닌 사용자가 실행을 요청하는 문장 두 개를 새로 작성하세요. 각 문장에 명시적인 하지 말라는 요구를 반드시 포함하세요.':''),commandSchema,7100+domainIndex*3+attempt,1000);
   try{if(generated.commands?.length!==2)throw Error('AUTHOR_COMMAND_COUNT_INVALID');generated.commands.forEach(validateAuthorCommand);commandError=null;break;}
   catch(error){commandError=error.message;write(`rejected-${domainIndex}-commands-${attempt}.json`,{error:commandError});}
  }
  if(commandError)throw Error(commandError);
  const parsed={cases:[]};
  for(const [i,command] of generated.commands.entries()){
   let annotation,annotationError;
   for(let attempt=0;attempt<3;attempt++){
    annotation=await generate(`${domainIndex}-annotation-${i}-${attempt}`,annotationInstruction+'\n원문: '+JSON.stringify(command)+(annotationError?'\n이전 주석은 '+annotationError+'로 거부됐습니다. 원문을 그대로 복사하고 대상도 해당 부분문장에 실제 존재하는 문자열만 쓰세요. 빈 요구나 새 대상을 만들지 마세요.':''),annotationSchema,8100+domainIndex*6+i*3+attempt,1600);
    try{validateAuthorAnnotation(command,annotation.requirements);annotationError=null;break;}
    catch(error){annotationError=error.message;write(`rejected-${domainIndex}-annotation-${i}-${attempt}.json`,{error:annotationError});}
   }
   if(annotationError)throw Error(annotationError);
   parsed.cases.push({command,requirements:annotation.requirements});
  }
  const accepted=[];
  for(const [index,item] of parsed.cases.entries()){
   if(typeof item.command!=='string'||item.command.length>6000||!Array.isArray(item.requirements)||item.requirements.length<3||item.requirements.length>6)throw new Error('Author structure invalid');
   const requirements=validateAuthorAnnotation(item.command,item.requirements);
   accepted.push({id:`H${String(domainIndex+1).padStart(2,'0')}-${index+1}`,domain:domains[domainIndex],command:item.command,requirements});
  }
  all.push(...accepted);write(`validated-${domainIndex}.json`,accepted);
  console.log(JSON.stringify({domain:domainIndex+1,accepted:all.length,elapsedMs:performance.now()-begin}));
 }
 const corpus={version:'separate-model-semantic-holdout-26-v1',startedAt,observedAt:new Date().toISOString(),cases:all,sourceContextProvided:false,humanExpertReview:false,
  limitations:['別 author-model context; not a blind human expert evaluation','Annotations require independent adjudication; valid JSON/spans do not prove semantic truth','No product execution or 260-case extension performed by this author script']};
 write('corpus.json',corpus);write('freeze.json',{observedAt:new Date().toISOString(),cases:all.length,sha256:createHash('sha256').update(readFileSync(resolve(output,'corpus.json'))).digest('hex'),beforeProductEvaluation:true});
 console.log(JSON.stringify({complete:true,cases:all.length,output}));
}catch(error){write('failure.json',{observedAt:new Date().toISOString(),accepted:all.length,error:error.message,productEvaluations:0});process.exitCode=1;console.error(error.message);}
finally{
 try{await fetch(base+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gemma3:latest',keep_alive:0}),signal:AbortSignal.timeout(5000)});}catch{}
 if(!exited){server.kill();await new Promise(r=>{server.once('exit',r);setTimeout(r,5000);});}
}
