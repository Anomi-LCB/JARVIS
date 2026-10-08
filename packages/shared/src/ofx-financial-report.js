import {importOfxBankStatement} from './ofx-bank-statement-import.js';
import {buildFinancialRecordReport} from './financial-record-reconciliation.js';
const fail=code=>{throw Object.assign(new Error('OFX reconciliation requires complete explicit classification.'),{code});};
/** Exact source-bound classifications, never inferred from credits or merchant prose. */
export function buildOfxFinancialReport({xml,currencyExponents,classifications,receipts,budgets}={}){
 const imported=importOfxBankStatement(xml,{currencyExponents});
 if(!Array.isArray(classifications)||classifications.length!==imported.records.length)fail('FINANCIAL_CLASSIFICATION_INCOMPLETE');
 const choices=new Map();
 for(const c of classifications){
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['transactionId','sourceSha256','kind','category','paymentRef','reason'].includes(k))||choices.has(c.transactionId)||c.sourceSha256!==imported.sourceSha256||!['charge','refund','other'].includes(c.kind)||!(c.kind==='other'?typeof c.reason==='string'&&c.reason.trim()&&c.reason.length<=200:['category','paymentRef'].every(k=>typeof c[k]==='string'&&c[k].trim()&&c[k].length<=200)))fail('FINANCIAL_CLASSIFICATION_INVALID');
  choices.set(c.transactionId,c);
 }
 const otherRecords=[];
 const transactions=imported.records.flatMap(row=>{
  const c=choices.get(row.id);if(!c)fail('FINANCIAL_CLASSIFICATION_INCOMPLETE');
  if(c.kind==='other'){otherRecords.push({...row,reason:c.reason});return [];}
  if(c.kind==='charge'&&row.signedAmountMinor>=0||c.kind==='refund'&&row.signedAmountMinor<=0)fail('FINANCIAL_CLASSIFICATION_DIRECTION_CONFLICT');
  return [{id:row.id,accountRef:row.accountRef,paymentRef:c.paymentRef,kind:c.kind,amountMinor:Math.abs(row.signedAmountMinor),currency:row.currency,category:c.category,source:'ofx-sha256:'+imported.sourceSha256}];
 });
 const result=buildFinancialRecordReport({transactions,receipts,budgets});
 const cell=text=>String(text).replace(/[\r\n\t]/gu,' ').replace(/\|/gu,'\\|').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
 const lines=['','## 지출·환불 대사 대상 외 거래',`총 가져온 거래 ${imported.records.length}건 · 대사 대상 ${transactions.length}건 · 기타 ${otherRecords.length}건`,'기타 거래는 영수증·예산 일치로 계산하지 않았습니다. 분류 이유는 사용자가 제공한 값입니다.','| 거래 ID | 통화 | 부호 있는 금액 | 분류 이유 |','| --- | --- | --- | --- |'];
 for(const row of otherRecords)lines.push(`| ${row.id} | ${row.currency} | ${row.signedAmountMinor} | ${cell(row.reason)} |`);
 return {...result,reportMarkdown:result.reportMarkdown+lines.join('\n')+'\n',otherRecords,coverage:{imported:imported.records.length,reconciliation:transactions.length,other:otherRecords.length,unclassified:0},imported,classificationBasis:'explicit-source-bound',sourceAuthenticated:false,executionAuthority:false};
}
