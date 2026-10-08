import {SaxesParser} from 'saxes';
import {createHash} from 'node:crypto';
import {parseFinancialDecimalMinor,financialScopedTransactionId} from './financial-import-primitives.js';
const fail=code=>{throw Object.assign(new Error('OFX statement cannot be imported.'),{code});};
const one=(node,name)=>{const found=node.children.filter(x=>x.name===name);if(found.length!==1)fail('FINANCIAL_OFX_SHAPE_INVALID');return found[0];};
const value=(node,name)=>{const n=one(node,name);if(n.children.length||!n.text.trim())fail('FINANCIAL_OFX_SHAPE_INVALID');return n.text.trim();};
/** Supported OFX datetime subset; unsupported leap seconds fail rather than normalize. */
export function parseOfxPostedDate(raw){
 const m=/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?(?:\[([+-]?\d{1,2}(?:\.\d{1,2})?)(?::[A-Za-z]{1,16})?\])?)?$/u.exec(raw);
 if(!m)fail('FINANCIAL_OFX_DATE_INVALID');
 const [year,month,day,hour,minute,second]=[m[1],m[2],m[3],m[4]??'0',m[5]??'0',m[6]??'0'].map(Number);
 if(second===60)fail('FINANCIAL_OFX_LEAP_SECOND_UNSUPPORTED');
 const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,Number((m[7]??'').padEnd(3,'0')));
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second)fail('FINANCIAL_OFX_DATE_INVALID');
 const offset=Number(m[8]??0);if(Math.abs(offset)>12)fail('FINANCIAL_OFX_DATE_INVALID');
 return {original:raw,utc:new Date(date.getTime()-Math.round(offset*3600000)).toISOString(),offsetHours:offset,precision:m[4]===undefined?'date':m[7]?'millisecond':'second'};
}
/** OFX §3.2.9: comma is a decimal separator, never a thousands separator. */
export function parseOfxAmountMinor(raw,exponent){
 if(typeof raw!=='string'||raw.trim().length>32)fail('FINANCIAL_OFX_AMOUNT_INVALID');
 const text=raw.trim();if(!/^[+-]?\d+(?:[.,]\d*)?$/u.test(text))fail('FINANCIAL_OFX_AMOUNT_INVALID');
 const normalized=text.replace(/^\+/u,'').replace(',', '.').replace(/\.$/u,'');
 return parseFinancialDecimalMinor(normalized,exponent);
}
/** XML bank statements only. Preserves direction; a credit is not inferred to be a refund. */
export function importOfxBankStatement(xml,{currencyExponents}={}){
 if(typeof xml!=='string'||Buffer.byteLength(xml)>1000000||!currencyExponents||typeof currencyExponents!=='object'||Array.isArray(currencyExponents))fail('FINANCIAL_OFX_INPUT_INVALID');
 const parser=new SaxesParser({xmlns:false}),stack=[],roots=[];let count=0;
 parser.on('error',()=>fail('FINANCIAL_OFX_XML_INVALID'));
 parser.on('doctype',()=>fail('FINANCIAL_OFX_DTD_FORBIDDEN'));
 parser.on('opentag',tag=>{if(++count>100000||stack.length>=32||Object.keys(tag.attributes).length)fail('FINANCIAL_OFX_SHAPE_INVALID');const node={name:tag.name,children:[],text:''};if(stack.length)stack.at(-1).children.push(node);else roots.push(node);stack.push(node);});
 parser.on('text',text=>{if(stack.length)stack.at(-1).text+=text;else if(text.trim())fail('FINANCIAL_OFX_XML_INVALID');});
 parser.on('closetag',()=>stack.pop());parser.write(xml).close();
 if(roots.length!==1||roots[0].name!=='OFX')fail('FINANCIAL_OFX_SHAPE_INVALID');
 if(roots[0].children.some(n=>!['BANKMSGSRSV1','SIGNONMSGSRSV1'].includes(n.name)))fail('FINANCIAL_OFX_UNSUPPORTED');
 const signon=roots[0].children.filter(n=>n.name==='SIGNONMSGSRSV1');if(signon.length>1)fail('FINANCIAL_OFX_SHAPE_INVALID');if(signon.length&&value(one(one(signon[0],'SONRS'),'STATUS'),'CODE')!=='0')fail('FINANCIAL_OFX_PROVIDER_ERROR');
 const bank=one(roots[0],'BANKMSGSRSV1');const responses=bank.children;if(!responses.length||responses.some(x=>x.name!=='STMTTRNRS'))fail('FINANCIAL_OFX_UNSUPPORTED');
 const records=[],statements=[],identities=new Map();let duplicateCount=0;
 for(const response of responses){
  if(value(one(response,'STATUS'),'CODE')!=='0')fail('FINANCIAL_OFX_PROVIDER_ERROR');
  const statement=one(response,'STMTRS'),currency=value(statement,'CURDEF');if(!/^[A-Z]{3}$/u.test(currency)||!Object.hasOwn(currencyExponents,currency))fail('FINANCIAL_CURRENCY_EXPONENT_REQUIRED');
  const account=one(statement,'BANKACCTFROM'),institutionId=value(account,'BANKID'),accountId=value(account,'ACCTID');
  const list=one(statement,'BANKTRANLIST');
  if(list.children.some(n=>!['DTSTART','DTEND','STMTTRN'].includes(n.name)))fail('FINANCIAL_OFX_UNSUPPORTED');
  const range={};
  for(const name of ['DTSTART','DTEND']){const fields=list.children.filter(n=>n.name===name);if(fields.length>1)fail('FINANCIAL_OFX_SHAPE_INVALID');if(fields.length)range[name]=parseOfxPostedDate(value(list,name));}
  if(range.DTSTART&&range.DTEND&&range.DTSTART.utc>range.DTEND.utc)fail('FINANCIAL_OFX_RANGE_INVALID');
  const accountRef=financialScopedTransactionId({institutionId,accountId,transactionId:'account-scope'});
  statements.push({accountRef,currency,range,rangeBasis:'provider-search-window-not-posting-filter'});
  for(const transaction of list.children.filter(x=>x.name==='STMTTRN')){
   if(transaction.children.some(n=>['CORRECTFITID','CORRECTACTION','CURRENCY','ORIGCURRENCY'].includes(n.name)))fail('FINANCIAL_OFX_UNSUPPORTED');
   const fitid=value(transaction,'FITID'),transactionType=value(transaction,'TRNTYPE'),postedAt=value(transaction,'DTPOSTED');
   if(!/^[A-Z]+$/u.test(transactionType)||!/^\d{8}(?:\d{6}(?:\.\d+)?(?:\[[^\]\r\n]+\])?)?$/u.test(postedAt))fail('FINANCIAL_OFX_RECORD_INVALID');
   const postedDate=parseOfxPostedDate(postedAt);
   const signedAmountMinor=parseOfxAmountMinor(value(transaction,'TRNAMT'),currencyExponents[currency]);
   const id=financialScopedTransactionId({institutionId,accountId,transactionId:fitid});
   const row={id,accountRef,currency,signedAmountMinor,transactionType,postedAt,postedDate,originalFields:structuredClone(transaction.children),classification:'unclassified'};
   const signature=JSON.stringify(transaction);if(identities.has(id)){if(identities.get(id)!==signature)fail('FINANCIAL_DUPLICATE_CONFLICT');duplicateCount++;continue;}
   identities.set(id,signature);records.push(row);
  }
 }
 return {format:'ofx-bank-xml',sourceSha256:createHash('sha256').update(xml).digest('hex'),sourceAuthenticated:false,executionAuthority:false,records,statements,duplicateCount,classificationRequired:true};
}
