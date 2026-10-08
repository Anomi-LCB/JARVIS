// Read-only browser QA using evidence from actual disposable Mission executions.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const repo=resolve('.'),log=await readFile(process.argv[2]??'artifacts/mission-pc-guidance-20261003-mission-final.txt','utf8');
const executionMode=process.argv.includes('--recovery-only')?'recovery-only':'standard';
const bindingEvidenceArg=process.argv.find(arg=>arg.startsWith('--binding-evidence='));
const bindingEvidence=bindingEvidenceArg?JSON.parse((await readFile(bindingEvidenceArg.slice('--binding-evidence='.length),'utf8')).split(/\r?\n/u).find(line=>line.startsWith('{"pcBindingUiEvidence":'))).pcBindingUiEvidence:null;
const workflowFailures=process.argv.includes('--workflow-failures');
const sourceClaims=process.argv.includes('--source-claims');
const recorded=log.split(/\r?\n/u).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(item=>sourceClaims?item.claimUiEvidence:workflowFailures?item.failureUiEvidence:item.uiRecoveryEvidence);
if(sourceClaims?recorded.length!==7:workflowFailures?recorded.length!==8:![3,4].includes(recorded.length))throw new Error('Actual Mission observations required');
const missions=sourceClaims?recorded.map(item=>item.claimUiEvidence):workflowFailures?recorded.map(item=>item.failureUiEvidence):recorded.map(item=>({missionId:item.missionId,status:item.status,stopReason:item.stopReason,uncertainEffectCount:item.uncertainEffectCount,
  objective:`격리 시험: ${item.reason==='missing'?'PC 업무 등록 누락':item.reason==='ungranted'?'PC 실행 허용 누락':item.reason==='core-permission'?'Core 실행 허용 철회':'PC 허용 기간 만료'}`,
  waves:[{actions:[{recovery:item.recovery}]}],updatedAt:new Date().toISOString(),gates:[],metrics:{}}));
let rejectedWrites=0;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(req.method!=='GET'){rejectedWrites++;res.statusCode=403;return json({success:false,error:{code:'QA_READ_ONLY'}});}
  if(url.pathname==='/api/local/capabilities')return json({credentialsExposed:false,coreAdminProxyConfigured:true});
  if(url.pathname==='/api/core/health')return json({status:'running',module:'A_CORE'});
  if(url.pathname==='/api/core/security/trust')return json({mode:'trusted'});
  if(url.pathname==='/api/core/missions')return json({items:missions,status:{executionMode}});
  if(url.pathname.startsWith('/api/core/missions/'))return json(missions.find(item=>item.missionId===decodeURIComponent(url.pathname.split('/').at(-1)))??{});
  if(url.pathname==='/api/core/routines')return json({items:[]});
  if(url.pathname==='/api/core/integrations')return json({items:[]});
  if(url.pathname==='/api/core/pc-nodes'&&bindingEvidence)return json(bindingEvidence);
  const file=resolve(repo,url.pathname==='/'?'index.html':`.${url.pathname}`);
  if(file!==resolve(repo,'index.html')&&!file.startsWith(resolve(repo,'src/ui')+sep)
    &&file!==resolve(repo,'packages/core/src/runtime/korean-weekly-routine-command.js')
    &&!['pc-local-denial.js','control-center-hosting.js','workflow-failure-guidance.js','source-change-view.js'].some(name=>file===resolve(repo,'packages/shared/src',name))){res.statusCode=404;return res.end();}
  try{res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}
  catch{res.statusCode=404;res.end();}
});
await listenOnFetchSafePort(server,{host:'127.0.0.1',port:0});
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/#tasks`,fixture:'read-only playback of actual isolated Mission recovery observations'}));
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit'){server.closeAllConnections();server.close(()=>{console.log(JSON.stringify({rejectedWrites}));process.exit(0);});}});
