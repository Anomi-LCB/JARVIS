import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error('Financial import requires valid explicit metadata.'),{code});};
/** Exact decimal scaling; exponent is supplied by a reviewed currency contract, never guessed. */
export function parseFinancialDecimalMinor(value,exponent){
 if(typeof value!=='string'||value.length>100||!Number.isSafeInteger(exponent)||exponent<0||exponent>6)fail('FINANCIAL_DECIMAL_INVALID');
 const match=/^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);if(!match)fail('FINANCIAL_DECIMAL_INVALID');
 const fraction=match[3]??'';if(fraction.length>exponent&&/[1-9]/u.test(fraction.slice(exponent)))fail('FINANCIAL_PRECISION_LOSS');
 let result=BigInt(match[2])*10n**BigInt(exponent)+BigInt(fraction.slice(0,exponent).padEnd(exponent,'0')||'0');
 if(match[1])result=-result;
 if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))fail('FINANCIAL_TOTAL_OVERFLOW');
 return Number(result);
}
/** OFX identity is scoped by financial institution + account + FITID (spec §3.2.3).
 * Hash is an opaque identifier, not bank authentication or anonymization. */
export function financialScopedTransactionId({institutionId,accountId,transactionId}){
 for(const item of [institutionId,accountId,transactionId])if(typeof item!=='string'||!item.trim()||item.length>255||/[\u0000-\u001f\u007f]/u.test(item))fail('FINANCIAL_SOURCE_ID_INVALID');
 return 'financial_'+createHash('sha256').update(JSON.stringify([institutionId,accountId,transactionId])).digest('hex');
}
