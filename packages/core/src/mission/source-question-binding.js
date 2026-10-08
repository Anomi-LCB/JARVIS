import {extractLiteralSourceFields,sourceQuoteMask} from './literal-source-fields.js';
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const suffix='(?:를|을)?(?:숫자(?:만|로)|알려줘)?';
function contract(question,format){
 const text=question.replace(/\s+/gu,'');
 const money=/^실제(?:로)?(지출|납부|입금|지급|결제)/u.exec(text);
 if(money){
  if(format!=='digits'||!/^실제(?:로)?(?:지출|납부|입금|지급|결제)(?:액|한|금액|한금액)?(?:을)?(?:원단위)?(?:금액)?(?:을)?(?:숫자(?:만|로)|알려줘)?$/u.test(text))return {unsupported:true};
  const action=money[1];
  return {kind:'integer',unit:'원',aliases:[`실제 ${action}액`,`실제 ${action} 금액`,`실제 ${action}`],format:'digits'};
 }
 if(/^최종(?:확인|검증)(?:결과|상태)/u.test(text)){
  if(!['verification-status','source-phrase'].includes(format)||!/^최종(?:확인|검증)(?:결과|상태)(?:를|을)?(?:원문(?:표현|단어)(?:으로|로)?|본문표현그대로)?$/u.test(text))return {unsupported:true};
  const action=text.startsWith('최종확인')?'확인':'검증';
  return {kind:'enum',choices:['검증됨','미검증'],aliases:[`최종 ${action} 결과`,`최종 ${action} 상태`],format:'source-phrase'};
 }
 if(/^계약확정상태/u.test(text)){
  if(format!=='source-phrase'||!/^계약확정상태(?:를|을)?(?:원문(?:표현|단어)(?:으로|로)?|본문표현그대로)?$/u.test(text))return {unsupported:true};
  return {kind:'enum',choices:['보류','확정','미확정','취소','미정'],aliases:['계약 확정 상태','계약 확정'],format:'source-phrase'};
 }
 if(/^승인(?:여부|상태)/u.test(text)){
  if(format!=='source-phrase'||!/^승인(?:여부|상태)(?:를|을)?(?:원문(?:표현|단어)(?:으로|로)?|본문표현그대로)?$/u.test(text))return {unsupported:true};
  return {kind:'enum',choices:['승인','미승인','보류','미정','거부','철회'],aliases:['승인 여부','승인 상태','승인'],format:'source-phrase'};
 }
 if(/^설문응답자수/u.test(text)){
  if(format!=='digits'||!new RegExp('^설문응답자수(?:만)?'+suffix+'$','u').test(text))return {unsupported:true};
  return {kind:'integer',unit:'명',aliases:['이 중 설문 응답자','설문 응답자'],format:'digits'};
 }
 const final=/^최종(참석|참가)(?:자)?(?:수|인원)/u.exec(text);
 if(final){
  if(format!=='digits'||!new RegExp('^최종(?:참석|참가)(?:자)?(?:수|인원)'+suffix+'$','u').test(text))return {unsupported:true};
  const action=final[1];
  return {kind:'integer',unit:'명',aliases:[`최종 정정: ${action}자`,`최종 정정된 ${action}자`,`최종 ${action}자`,`최종 ${action} 인원`],format:'digits'};
 }
 return null;
}
/** Bounded question-to-declaration contract; never general semantic or real-world verification. */
function declaredValue(source,spec,quoted){
  const references=[],declarations=[];
  for(const label of spec.aliases){
   const pattern=new RegExp(escape(label)+'\\s*(?:은|는|:)','gu');
   for(const match of source.matchAll(pattern)){
    if(!quoted[match.index]&&(match.index===0||!/[가-힣A-Za-z0-9"'“‘]/u.test(source[match.index-1])))references.push(match.index);
   }
   try{
    const expected=extractLiteralSourceFields({source,questions:{field:'bound-declaration'},valueFormats:{field:spec.format},sourceFields:{field:{...spec,label}}});
    const evidence=expected.evidence.field;
    // The same text may occur first in a quoted example. Bind the declaration
    // to its actual unquoted occurrence, not the first substring match.
    const index=references.find(position=>source.startsWith(evidence,position));
    if(index===undefined)continue;
    declarations.push({value:expected.facts.field,evidence,index,end:index+evidence.length});
   }catch(error){
    if(!String(error.code??'').startsWith('A_SOURCE_FIELDS_'))throw error;
   }
  }
  const unique=[...new Map(declarations.map(d=>[`${d.index}:${d.end}`,d])).values()];
  // Every unquoted alias reference must be contained in the one understood field.
  // A later correction, conflicting alias, conditional or claim cannot be dropped.
  const expected=unique.length===1?unique[0]:null;
  return expected&&references.length&&!references.some(index=>index<expected.index||index>=expected.end)?expected:null;
}
/** Only complete, host-recognized explicit declarations can skip model inference. */
export function extractQuestionBoundSourceSummary({source,questions,valueFormats}){
 const facts={},evidence={},quoted=sourceQuoteMask(source);
 for(const [id,question] of Object.entries(questions)){
  const spec=contract(question,valueFormats[id]);
  if(!spec||spec.unsupported)return null;
  const expected=declaredValue(source,spec,quoted);
  if(!expected)return null;
  facts[id]=expected.value;evidence[id]=expected.evidence;
 }
 return {facts,evidence};
}
export function inspectSourceQuestionBindings({source,questions,valueFormats,sourceFields},output){
 if(sourceFields!==undefined){
  let expected;
  try{expected=extractLiteralSourceFields({source,questions,valueFormats,sourceFields});}
  catch(error){
   if(!String(error.code??'').startsWith('A_SOURCE_FIELDS_'))throw error;
   return {version:'explicit-source-field-binding-v1',errors:['source-fields-contract-unverified'],checks:[],independentGeneralSemanticVerification:false};
  }
  const errors=[],checks=[];
  for(const id of Object.keys(questions)){
   const valueMatched=output.facts[id]===expected.facts[id];
   const quoteMatched=typeof output.evidence[id]==='string'&&output.evidence[id].includes(expected.evidence[id]);
   if(!valueMatched)errors.push(id+':source-question-value-mismatch');
   if(!quoteMatched)errors.push(id+':source-question-evidence-mismatch');
   checks.push({id,required:true,passed:valueMatched&&quoteMatched,sourceDeclarationVerified:true,realWorldTruthVerified:false});
  }
  return {version:'explicit-source-field-binding-v1',errors,checks,independentGeneralSemanticVerification:false};
 }
 const errors=[],checks=[],quoted=sourceQuoteMask(source);
 for(const [id,question] of Object.entries(questions)){
  const spec=contract(question,valueFormats[id]);
  if(!spec)continue;
  if(spec.unsupported){errors.push(id+':source-question-contract-unverified');checks.push({id,required:true,passed:false,reason:'question-scope-unverified'});continue;}
  const expected=declaredValue(source,spec,quoted);
  if(!expected){
   errors.push(id+':source-question-declaration-unverified');checks.push({id,required:true,passed:false,reason:'declaration-ambiguous-or-unsupported'});continue;
  }
  const valueMatched=output.facts[id]===expected.value;
  const quoteMatched=typeof output.evidence[id]==='string'&&output.evidence[id].includes(expected.evidence);
  if(!valueMatched)errors.push(id+':source-question-value-mismatch');
  if(!quoteMatched)errors.push(id+':source-question-evidence-mismatch');
  checks.push({id,required:true,passed:valueMatched&&quoteMatched,sourceDeclarationVerified:true,realWorldTruthVerified:false});
 }
 return {version:'bounded-source-question-binding-v1',errors,checks,independentGeneralSemanticVerification:false};
}
