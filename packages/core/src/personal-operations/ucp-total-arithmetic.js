const additive=new Set(['subtotal','fulfillment','tax','fee','total']);
const subtractive=new Set(['discount','items_discount']);
const max=BigInt(Number.MAX_SAFE_INTEGER);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const label=value=>typeof value==='string'&&value.trim().length>0&&value.length<=2000&&!/[\u0000-\u001f\u007f]/u.test(value);
const invalid=()=>{throw Object.assign(new Error('A_UCP_CHECKOUT_CONTENT_INVALID'),{code:'A_UCP_CHECKOUT_CONTENT_INVALID'});};

/** Arithmetic over the merchant's declared ordered breakdown only. Never edits
 * display rows or establishes tax correctness, hidden costs or a payment. */
export function calculateUcpTotalArithmetic(totals){
 if(!Array.isArray(totals)||totals.length>100)invalid();
 const reasons=[];let computed=0n,subtotalCount=0,totalCount=0,declared=null,subLineCount=0;
 for(const entry of totals){
  if(!object(entry)||typeof entry.type!=='string'||!entry.type.trim()||entry.type.length>100||/[\u0000-\u001f\u007f]/u.test(entry.type)
   ||!Number.isSafeInteger(entry.amount)||additive.has(entry.type)&&entry.amount<0||subtractive.has(entry.type)&&entry.amount>=0
   ||!additive.has(entry.type)&&!subtractive.has(entry.type)&&!label(entry.display_text)
   ||entry.display_text!==undefined&&!label(entry.display_text))invalid();
  if(entry.type==='subtotal')subtotalCount++;
  if(entry.type==='total'){totalCount++;declared=entry.amount;}else computed+=BigInt(entry.amount);
  if(entry.lines!==undefined){
   if(!Array.isArray(entry.lines)||entry.lines.length>100)invalid();
   let subSum=0n;
   for(const line of entry.lines){
    if(!object(line)||!label(line.display_text)||!Number.isSafeInteger(line.amount)||line.lines!==undefined)invalid();
    subSum+=BigInt(line.amount);subLineCount++;
   }
   if(subSum!==BigInt(entry.amount))reasons.push('sub-lines-mismatch');
  }
 }
 if(totalCount!==1)reasons.push('total-not-unique');
 if(subtotalCount===0)reasons.push('subtotal-required');else if(subtotalCount!==1)reasons.push('subtotal-not-unique');
 const inRange=computed>=0n&&computed<=max;
 if(!inRange)reasons.push('total-out-of-range');
 if(declared!==null&&computed!==BigInt(declared))reasons.push('total-mismatch');
 return {version:'ucp-declared-total-arithmetic-v1',verified:reasons.length===0,reasons:[...new Set(reasons)],
  declaredTotalMinor:declared,computedTotalMinor:inRange?Number(computed):null,topLevelEntryCount:totals.length,subLineCount,
  scope:'merchant-declared-top-level-and-sub-lines',undeclaredChargesVerified:false,taxLegalityVerified:false,paymentVerified:false,executionAuthority:false};
}
