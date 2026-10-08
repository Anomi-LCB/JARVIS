import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=value=>typeof value==='string'&&value.trim()&&value.length<=12000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const url=value=>{try{const parsed=new URL(value);return parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&(!parsed.port||parsed.port==='443')?parsed.href:null;}catch{return null;}};
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const markdownText=value=>String(value).replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/[\\`*_{}\[\]()#!|]/gu,'\\$&').replace(/[\r\n]+/gu,' ');

/** Only source observations from the current Mission's dispatched reads qualify.
 * The extracted body remains external data, never executable instructions. */
export function verifiedResearchSources({observations=[],actions=[]}={}){
 const sources=[];
 for(const observation of observations){
  const article=observation.data?.article,action=actions.find(a=>a.actionId===observation.actionId);
  if(observation.toolName!=='news.fetchArticle'||observation.outcome!=='success'||observation.verification?.status!=='passed'
    ||observation.verification.failedCheckIds?.length||action?.expectedToolName!=='news.fetchArticle'
    ||article?.live!==true||article.replay===true||article.fixture===true||article.textIsUntrustedSourceMaterial!==true
    ||!text(article.text)||article.text.length<160||article.text.length>12000||article.textCharacters!==article.text.length
    ||hash(article.text)!==article.textSha256||!text(article.title)||!timestamp(article.fetchedAt)||!timestamp(observation.createdAt)
    ||Date.parse(article.fetchedAt)>Date.parse(observation.createdAt)+5000||!Number.isSafeInteger(article.httpStatus)||article.httpStatus<200||article.httpStatus>=300)continue;
  const requestedUrl=url(article.requestedUrl),finalUrl=url(article.finalUrl);
  if(!requestedUrl||!finalUrl||requestedUrl!==url(action.arguments?.url)||new URL(finalUrl).hostname!==article.finalHost)continue;
  const identity={observationActionId:observation.actionId,requestedUrl,finalUrl,title:article.title,fetchedAt:article.fetchedAt,
    contentSha256:article.textSha256,textCharacters:article.textCharacters,verificationScope:'bounded-extracted-body',untrustedSource:true};
  sources.push({...identity,sourceId:hash(JSON.stringify(identity)),body:article.text});
 }
 return sources;
}

export function createResearchSourceTrace({observations,actions,citations}){
 const sources=verifiedResearchSources({observations,actions});
 const selected=(citations??[]).map(item=>{
  const source=sources.find(source=>source.observationActionId===item.observationActionId);
  if(!source)fail('A_RESEARCH_SOURCE_NOT_VERIFIED');
  return {sourceId:source.sourceId,claim:item.claim,quote:item.quote};
 });
 const ids=new Set(selected.map(item=>item.sourceId));
 return {schemaVersion:'jarvis-research-source-trace-v1',semanticEntailment:'not-evaluated',executionAuthority:false,
  sources:sources.filter(source=>ids.has(source.sourceId)).map(({body,...identity})=>identity),citations:selected};
}

export function renderResearchTraceReport(trace){
 const sources=new Map(trace.sources.map(source=>[source.sourceId,source]));
 return ['# 출처 연결 연구 보고서','',
  '검증 범위: 조회한 원문과 인용의 연결. 요약 주장의 의미적 타당성은 별도 검토가 필요합니다.',
  ...trace.citations.flatMap((citation,index)=>{
   const source=sources.get(citation.sourceId);if(!source)fail('A_RESEARCH_SOURCE_NOT_VERIFIED');
   return ['',`## ${index+1}. ${markdownText(source.title)}`,`요약 주장: ${markdownText(citation.claim)}`,`근거 원문: ${markdownText(citation.quote)}`,
    `요청 URL: ${source.requestedUrl}`,`출처 URL: ${source.finalUrl}`,`조회 시각: ${source.fetchedAt}`,
    `원문 SHA-256: ${source.contentSha256}`,`관측 ID: ${source.observationActionId}`,`출처 연결 ID: ${source.sourceId}`];
  })].join('\n')+'\n';
}

/** Independent source linkage, not a claim entailment or truth oracle. */
export function verifyResearchSourceTrace({trace,report,observations,actions,minimumSources=1}){
 const failed=reasons=>({passed:false,status:'failed',reasons,semanticEntailment:'not-evaluated'});
 if(trace?.schemaVersion!=='jarvis-research-source-trace-v1'||trace.executionAuthority!==false||trace.semanticEntailment!=='not-evaluated'
  ||!Array.isArray(trace.sources)||!trace.sources.length||trace.sources.length>20||!Array.isArray(trace.citations)
  ||!trace.citations.length||trace.citations.length>40)return failed(['research-trace-invalid']);
 const actual=verifiedResearchSources({observations,actions}),ids=new Set(),urls=new Set(),words=new Map();
 for(const source of trace.sources){
  const observed=actual.find(item=>item.sourceId===source.sourceId);
  if(!observed||ids.has(source.sourceId))return failed(['research-source-observation-mismatch']);
  const {body,...identity}=observed;
  if(Object.keys(source).length!==Object.keys(identity).length||Object.keys(identity).some(key=>source[key]!==identity[key]))return failed(['research-source-metadata-mismatch']);
  ids.add(source.sourceId);urls.add(source.finalUrl);
 }
 const used=new Set();
 for(const citation of trace.citations){
  const source=actual.find(item=>item.sourceId===citation.sourceId);
  if(!source||!ids.has(citation.sourceId)||!text(citation.claim)||!text(citation.quote)||Object.keys(citation).length!==3
    ||!source.body.includes(citation.quote))return failed(['research-quote-source-mismatch']);
  // Manifest and human report both reproduce the quote: budget both copies.
  const count=citation.quote.trim().split(/\s+/u).length*2,total=(words.get(source.finalUrl)??0)+count;
  if(total>25)return failed(['research-source-quote-budget-exceeded']);
  words.set(source.finalUrl,total);used.add(source.sourceId);
 }
 if(used.size!==ids.size||urls.size<minimumSources)return failed(['research-source-coverage-incomplete']);
 if(report!==renderResearchTraceReport(trace))return failed(['research-report-trace-mismatch']);
 return {passed:true,status:'passed',reasons:[],sourceCount:urls.size,citationCount:trace.citations.length,
  semanticEntailment:'not-evaluated',verificationScope:'observed-source-time-hash-quote-to-artifact'};
}
