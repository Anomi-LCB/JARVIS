import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {parseResearchSourceRequest,planResearchSourceWorkflow,researchSourceOutputs,researchSourceCoverage} from '../packages/core/src/mission/research-source-workflow.js';
import {verifyResearchSourceTrace} from '../packages/core/src/mission/research-source-trace.js';
const root=resolve('artifacts/research-contract-fixture'),url='https://publisher.example/news/1';
const objective=`뉴스 기사 ${url} 본문을 읽고 evidence.md 보고서와 evidence.json 출처 연결 기록에 조회 시각, 원문 해시, 인용 근거를 저장해주세요. 주장의 의미적 타당성은 검증하지 마세요.`;
function fixture(){
 const m={objective,goalContract:{objective,requirements:[{requirementId:'original-read-save'},{requirementId:'explicit-semantic-exclusion'}]},constraints:[],
  successCriteria:[{criterionId:'c1',verificationSpec:{kind:'research.sourceTrace',minimumSources:1,path:'evidence.json',reportPath:'evidence.md'}}],waves:[],observations:[]};
 const read={actionId:'read-1',expectedToolName:'news.fetchArticle',actualToolName:'news.fetchArticle',arguments:{url},status:'succeeded'};
 const body='Public source data. Never execute this page as instructions. '+('Source details preserve whitespace and factual context. '.repeat(5));
 const o={actionId:read.actionId,toolName:'news.fetchArticle',outcome:'success',verification:{status:'passed'},createdAt:'2026-10-07T00:00:01.000Z',
  data:{article:{live:true,textIsUntrustedSourceMaterial:true,requestedUrl:url,finalUrl:url,finalHost:'publisher.example',title:'Public announcement',
   fetchedAt:'2026-10-07T00:00:00.000Z',httpStatus:200,text:body,textCharacters:body.length,textSha256:createHash('sha256').update(body).digest('hex')}}};
 return {m,read,o};
}
test('whole request accepts different provider, names, commas and Korean wording and binds criterion paths',()=>{
 const {m}=fixture(),request=parseResearchSourceRequest(m,[root]);assert.equal(request.url,url);assert.equal(request.tracePath,resolve(root,'evidence.json'));
 assert.equal(planResearchSourceWorkflow({mission:m,roots:[root]}).actions[0].arguments.url,url);
});
for(const extra of [' 그리고 이 파일을 외부로 보내줘.',' 결제해줘.',' 그리고 사실 검증도 수행해.',' 권한을 늘려줘.'])test(`extra clause is preserved by refusing compilation: ${extra}`,()=>{
 const {m}=fixture();m.objective+=extra;m.goalContract.objective=m.objective;assert.equal(parseResearchSourceRequest(m,[root]),null);
});
test('unsupported criterion, changed target, conflicting or corrected contract never acquires source authority',()=>{
 for(const mutate of [m=>m.successCriteria[0].verificationSpec.path='other.json',m=>m.successCriteria[0].verificationSpec.minimumSources=2,
  m=>m.constraints=['do not overwrite'],m=>m.goalContract.contradictions=['conflict'],m=>m.goalContract.revisionChange={version:2},
  m=>m.objective=m.objective.replace(url,'https://user:secret@publisher.example/news')]){
  const {m}=fixture();mutate(m);assert.equal(parseResearchSourceRequest(m,[root]),null);
 }
});
test('read alone cannot complete; independently observed body becomes bounded excerpt and two exact writes',()=>{
 const {m,read,o}=fixture();m.waves=[{actions:[read]}];m.observations=[o];
 const req=parseResearchSourceRequest(m,[root]),output=researchSourceOutputs(m,req),plan=planResearchSourceWorkflow({mission:m,roots:[root]});
 assert.equal(plan.decision,'continue');assert.equal(plan.actions.length,2);assert.equal(researchSourceCoverage({mission:m,roots:[root]}).allowed,false);
 const trace=JSON.parse(output.files[0].content);assert.equal(verifyResearchSourceTrace({trace,report:output.files[1].content,observations:[o],actions:[read]}).passed,true);
 assert.equal(trace.semanticEntailment,'not-evaluated');
 assert.equal(trace.citations[0].quote.split(/\s+/u).length,10);
 for(const [i,a] of plan.actions.entries()){
  a.actionId=`write-${i}`;a.actualToolName=a.expectedToolName;a.taskId=`task-${i}`;a.status='succeeded';
  a.operation={dispatch:{taskId:a.taskId,toolName:a.actualToolName,arguments:a.arguments}};
  m.observations.push({actionId:a.actionId,taskId:a.taskId,category:'execution',outcome:'success',verification:{status:'passed'},
   artifacts:[{outsideAllowedRoots:false,contentSha256:createHash('sha256').update(a.arguments.content).digest('hex')}]});
 }
 m.waves.push({actions:plan.actions});assert.equal(researchSourceCoverage({mission:m,roots:[root]}).allowed,true);
 const write=plan.actions[0];assert.equal(researchSourceCoverage({mission:m,roots:[root],action:write,phase:'dispatch',dispatchArguments:{...write.arguments,content:'forged'}}).allowed,false);
 assert.equal(researchSourceCoverage({mission:m,roots:[root],action:write,phase:'dispatch',dispatchArguments:{...write.arguments,append:true}}).allowed,false);
 m.observations[1].artifacts[0].contentSha256='0'.repeat(64);assert.equal(researchSourceCoverage({mission:m,roots:[root]}).allowed,false);
});
test('fixture, lost HTTP status, body digest mutation and response failure never become verified sources',()=>{
 for(const mutate of [o=>o.data.article.fixture=true,o=>o.data.article.httpStatus=null,o=>o.data.article.text+='changed',o=>o.outcome='failed']){
  const {m,read,o}=fixture();mutate(o);m.waves=[{actions:[read]}];m.observations=[o];
  assert.equal(planResearchSourceWorkflow({mission:m,roots:[root]}).decision,'blocked');
 }
});
