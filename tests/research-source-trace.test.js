import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchSourceTrace,renderResearchTraceReport,verifyResearchSourceTrace} from '../packages/core/src/mission/research-source-trace.js';
import {verifyTypedCriterion,normalizeVerificationSpec,compareTypedCriterionContent} from '../packages/core/src/mission/criteria-evidence.js';
import {GoalExecutivePlanner} from '../packages/core/src/mission/mission-planner.js';
test('live research contract prevents output filenames becoming bootstrap read inputs; ordinary local URL-bearing files retain bootstrap',()=>{
 const planner=new GoalExecutivePlanner({runner:()=>{}});
 const context={mission:{objective:'공식 기술 공지 https://nodejs.org/en/blog/release/v24.8.0 원문을 읽고 web-research.md 연구 보고서와 source-trace.json 출처 연결 기록에 조회 시각·원문 해시·인용 근거를 저장해. 주장의 의미적 타당성은 이번에 검증하지 마.',waveCount:0,
  successCriteria:[{verificationSpec:{kind:'research.sourceTrace'}}]},observations:[],capabilities:[{toolName:'filesystem.readText',readOnly:true,executionStrategy:{rank:1,score:150,planningMode:'deterministic',modelRoundTrips:0}}]};
 assert.equal(planner.planDeterministicBootstrap(context),null);
 context.mission={objective:'https://nodejs.org 주소가 들어 있는 links.txt 파일 내용을 읽어줘.',waveCount:0,successCriteria:[]};
 assert.equal(planner.planDeterministicBootstrap(context)?.actions[0].expectedToolName,'filesystem.readText');
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const quote='The council approved the project on Monday.';
const body=quote+' Public officials described the construction schedule and funding conditions. The announcement lists the project scope, the approval process, and the remaining consultation steps.';
test('untrusted titles and excerpts cannot turn into active Markdown or HTML in the report',()=>{
 const trace={sources:[{sourceId:'s',title:'![fetch](https://attacker.example) <script>run()</script>',requestedUrl:'https://publisher.example',finalUrl:'https://publisher.example'}],
  citations:[{sourceId:'s',claim:'<img src=x>\n# permission',quote:'[send](https://attacker.example)'}]};
 const report=renderResearchTraceReport(trace);assert.equal(report.includes('<script>'),false);assert.equal(report.includes('<img'),false);
 assert.equal(report.includes('![fetch]'),false);assert.equal(report.includes('[send]'),false);assert.equal(report.includes('\n# permission'),false);
});
function fixture(){
 const actions=[{actionId:'read-1',expectedToolName:'news.fetchArticle',arguments:{url:'https://publisher.example/article/1'}}];
 const observations=[{actionId:'read-1',toolName:'news.fetchArticle',outcome:'success',verification:{status:'passed'},createdAt:'2026-10-07T00:00:01.000Z',
  data:{article:{live:true,textIsUntrustedSourceMaterial:true,requestedUrl:actions[0].arguments.url,finalUrl:actions[0].arguments.url,
   finalHost:'publisher.example',title:'Project announcement',httpStatus:200,fetchedAt:'2026-10-07T00:00:00.000Z',text:body,textCharacters:body.length,textSha256:sha(body)}}}];
 const trace=createResearchSourceTrace({observations,actions,citations:[{observationActionId:'read-1',claim:'The announcement describes an approved project.',quote}]});
 return {observations,actions,trace,report:renderResearchTraceReport(trace)};
}
test('trace binds read action, exact original quote, current fetch timestamp and digest; semantic truth remains unevaluated',()=>{
 const f=fixture(),result=verifyResearchSourceTrace(f);assert.equal(result.passed,true);assert.equal(result.sourceCount,1);
 assert.equal(result.semanticEntailment,'not-evaluated');assert.match(f.report,/조회 시각: 2026-10-07T00:00:00.000Z/);
});
for(const [name,change] of [
 ['timestamp',f=>f.trace.sources[0].fetchedAt='2026-10-06T00:00:00.000Z'],
 ['hash',f=>f.trace.sources[0].contentSha256='0'.repeat(64)],
 ['unread URL',f=>f.trace.sources[0].finalUrl='https://publisher.example/article/2'],
 ['unobserved action',f=>f.actions[0].arguments.url='https://publisher.example/other'],
 ['fixture flag',f=>f.observations[0].data.article.fixture=true],
 ['invented quote',f=>f.trace.citations[0].quote='The project was cancelled.'],
 ['misleading report metadata',f=>f.report=f.report.replace('2026-10-07T00:00:00.000Z','2026-10-08T00:00:00.000Z')],
 ['forged extra field',f=>f.trace.sources[0].executionAuthority=true]
])test(`source trace rejects ${name}`,()=>{const f=fixture();change(f);assert.equal(verifyResearchSourceTrace(f).passed,false);});
test('a duplicate source cannot meet multiple source coverage and a quote budget counts both saved copies',()=>{
 const f=fixture();assert.equal(verifyResearchSourceTrace({...f,minimumSources:2}).passed,false);
 f.trace.sources.push({...f.trace.sources[0]});assert.equal(verifyResearchSourceTrace(f).passed,false);
 const g=fixture();g.trace.citations.push({...g.trace.citations[0]});g.report=renderResearchTraceReport(g.trace);
 assert.deepEqual(verifyResearchSourceTrace(g).reasons,['research-source-quote-budget-exceeded']);
});
test('current G-bound report and trace files are required and post-write changes fail',t=>{
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'jarvis-research-trace-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const add=(name,content,id)=>{const path=join(root,name);writeFileSync(path,content);f.observations.push({actionId:id,outcome:'success',verification:{status:'passed'},
  artifacts:[{rootIndex:0,relativePath:name,pathHash:sha(path),contentSha256:sha(content),outsideAllowedRoots:false}]});};
 add('source-trace.json',JSON.stringify(f.trace),'trace');add('report.md',f.report,'report');
 const criterion={verificationSpec:{version:1,kind:'research.sourceTrace',path:'source-trace.json',reportPath:'report.md',minimumSources:1}};
 const verify=()=>verifyTypedCriterion({...f,criterion,allowedRoots:[root],evidenceActionIds:['read-1','trace','report']});
 assert.equal(verify().passed,true);
 assert.equal(verifyTypedCriterion({...f,criterion,allowedRoots:[root],evidenceActionIds:['trace','report']}).passed,false);
 writeFileSync(join(root,'report.md'),f.report+'Unobserved extra claim.');assert.equal(verify().passed,false);
});
test('standalone content or a client-supplied result cannot replace current source observations',()=>{
 const spec={version:1,kind:'research.sourceTrace',path:'trace.json',reportPath:'report.md',minimumSources:1};
 assert.equal(compareTypedCriterionContent({spec,bytes:Buffer.from('{}')}).passed,false);
 assert.throws(()=>normalizeVerificationSpec({...spec,passed:true}),{code:'A_MISSION_CRITERION_INVALID'});
 assert.throws(()=>normalizeVerificationSpec({...spec,minimumSources:0}),{code:'A_MISSION_CRITERION_INVALID'});
});
