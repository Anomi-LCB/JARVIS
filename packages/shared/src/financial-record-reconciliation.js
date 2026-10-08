import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error('Financial record input cannot be reconciled.'),{code});};
const text=x=>typeof x==='string'&&x.trim().length>0&&x.length<=200;
const amount=x=>Number.isSafeInteger(x)&&x>=0;
const currency=x=>typeof x==='string'&&/^[A-Z]{3}$/u.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
const sum=values=>{const value=values.reduce((a,b)=>a+BigInt(b),0n);if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))fail('FINANCIAL_TOTAL_OVERFLOW');return Number(value);};
function distinct(rows,keys){
 const ids=new Map();let duplicates=0;
 for(const row of rows){
  if(!exact(row,keys))fail('FINANCIAL_RECORD_SHAPE_INVALID');
  const ordered=JSON.stringify(keys.map(k=>row[k]??null));
  if(ids.has(row.id)){if(ids.get(row.id).signature!==ordered)fail('FINANCIAL_DUPLICATE_CONFLICT');duplicates++;}
  else ids.set(row.id,{row,signature:ordered});
 }
 return {rows:[...ids.values()].map(x=>x.row),duplicates};
}
/** Local arithmetic only. Supplied source labels are not bank authentication. */
export function reconcileFinancialRecords(input){
 if(!exact(input,['transactions','receipts','budgets'])||!['transactions','receipts','budgets'].every(k=>Array.isArray(input[k])&&input[k].length<=10000))fail('FINANCIAL_INPUT_INVALID');
 const transactions=distinct(input.transactions,['id','accountRef','paymentRef','kind','amountMinor','currency','category','source']);
 const receipts=distinct(input.receipts,['id','accountRef','paymentRef','kind','amountMinor','currency','source']);
 const budgets=distinct(input.budgets,['id','category','currency','limitMinor']);
 for(const item of [...transactions.rows,...receipts.rows])if(!['id','accountRef','paymentRef','source'].every(k=>text(item[k]))||!amount(item.amountMinor)||!currency(item.currency)||!['charge','refund'].includes(item.kind))fail('FINANCIAL_RECORD_INVALID');
 for(const item of transactions.rows)if(!text(item.category))fail('FINANCIAL_CATEGORY_REQUIRED');
 for(const item of budgets.rows)if(!text(item.id)||!text(item.category)||!currency(item.currency)||!amount(item.limitMinor))fail('FINANCIAL_BUDGET_INVALID');
 const key=item=>JSON.stringify([item.accountRef,item.paymentRef,item.kind,item.currency]);
 const index=rows=>{const map=new Map();for(const item of rows){const k=key(item);const group=map.get(k)??[];group.push(item);map.set(k,group);}return map;};
 const tx=index(transactions.rows),docs=index(receipts.rows),matchedReceipts=new Set();
 const findings=transactions.rows.map(item=>{
  const group=docs.get(key(item))??[];let status;
  if(tx.get(key(item)).length!==1||group.length>1)status='ambiguous-reference';
  else if(!group.length)status='receipt-missing';
  else {matchedReceipts.add(group[0].id);status=group[0].amountMinor===item.amountMinor?'matched':'amount-mismatch';}
  return {transactionId:item.id,status,receiptIds:group.map(x=>x.id)};
 });
 const totals=new Map();for(const item of transactions.rows){const k=JSON.stringify([item.category,item.currency]);const group=totals.get(k)??{category:item.category,currency:item.currency,charges:[],refunds:[]};group[item.kind==='charge'?'charges':'refunds'].push(item.amountMinor);totals.set(k,group);}
 const limits=new Map();for(const item of budgets.rows){const k=JSON.stringify([item.category,item.currency]);if(limits.has(k))fail('FINANCIAL_BUDGET_CONFLICT');limits.set(k,item.limitMinor);}
 for(const item of budgets.rows){const k=JSON.stringify([item.category,item.currency]);if(!totals.has(k))totals.set(k,{category:item.category,currency:item.currency,charges:[],refunds:[]});}
 const summary=[...totals.entries()].map(([k,g])=>{const chargedMinor=sum(g.charges),refundedMinor=sum(g.refunds),netMinor=sum([chargedMinor,-refundedMinor]);const limitMinor=limits.get(k)??null;return {category:g.category,currency:g.currency,chargedMinor,refundedMinor,netMinor,limitMinor,overBudget:limitMinor===null?null:netMinor>limitMinor};});
 return {schemaVersion:'financial-reconciliation-v1',basis:'supplied-records',sourceAuthenticated:false,executionAuthority:false,
  inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  counts:{transactions:transactions.rows.length,receipts:receipts.rows.length,duplicateTransactions:transactions.duplicates,duplicateReceipts:receipts.duplicates,duplicateBudgets:budgets.duplicates,matched:findings.filter(x=>x.status==='matched').length},
  findings,unmatchedReceiptIds:receipts.rows.filter(x=>!matchedReceipts.has(x.id)).map(x=>x.id),summary,
  reviewRequired:findings.some(x=>x.status!=='matched')||receipts.rows.some(x=>!matchedReceipts.has(x.id))||summary.some(x=>x.limitMinor===null||x.overBudget)};
}

/** Render supplied records without currency conversion or authenticated-bank claims. */
export function buildFinancialRecordReport(input){
 const reconciliation=reconcileFinancialRecords(input);
 const cell=value=>String(value).replace(/[\r\n\t]/gu,' ').replace(/\|/gu,'\\|').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
 const lines=['# 제공된 금융자료 대사','','자료 기준: 사용자가 제공한 기록','은행·영수증 진위는 검증하지 않았습니다. 거래 실행 권한이 없으며 금융·세무 조언이 아닙니다.','금액은 입력의 최소 화폐 단위이며 통화 간 환산·합산은 하지 않습니다.','',`거래 ${reconciliation.counts.transactions}건 · 영수증 ${reconciliation.counts.receipts}건 · 일치 ${reconciliation.counts.matched}건`,`확인 필요: ${reconciliation.reviewRequired?'예':'아니오'}`,'','## 범주별 금액','| 범주 | 통화 | 지출 | 환불 | 순지출 | 예산 | 초과 |','| --- | --- | --- | --- | --- | --- | --- |'];
 for(const row of reconciliation.summary)lines.push(`| ${cell(row.category)} | ${row.currency} | ${row.chargedMinor} | ${row.refundedMinor} | ${row.netMinor} | ${row.limitMinor??'미설정'} | ${row.overBudget===null?'미확인':row.overBudget?'예':'아니오'} |`);
 lines.push('','## 대사 결과','| 거래 ID | 상태 | 영수증 ID |','| --- | --- | --- |');
 for(const row of reconciliation.findings)lines.push(`| ${cell(row.transactionId)} | ${row.status} | ${row.receiptIds.map(cell).join(', ')||'없음'} |`);
 lines.push('',`연결되지 않은 영수증: ${reconciliation.unmatchedReceiptIds.map(cell).join(', ')||'없음'}`,`제거한 동일 중복: 거래 ${reconciliation.counts.duplicateTransactions} · 영수증 ${reconciliation.counts.duplicateReceipts} · 예산 ${reconciliation.counts.duplicateBudgets}`,`입력 SHA-256: ${reconciliation.inputSha256}`,'');
 return {reconciliation,reportMarkdown:lines.join('\n')+'\n'};
}
