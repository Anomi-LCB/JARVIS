// Bounded KRW grammar, with exact integer arithmetic. This extracts source
// facts; it does not authorize spending or prove an effect's total cost.
const bigUnits = {조: 1000000000000n, 억: 100000000n, 만: 10000n};
const smallUnits = {천: 1000n, 백: 100n, 십: 10n};
const max = BigInt(Number.MAX_SAFE_INTEGER);

function scaledNumber(source, scale) {
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u.test(source)) return null;
  const [whole, fraction = ''] = source.replaceAll(',', '').split('.');
  if (whole.length + fraction.length > 64) return null;
  const numerator = BigInt(whole + fraction) * scale;
  const denominator = 10n ** BigInt(fraction.length);
  return numerator % denominator === 0n ? numerator / denominator : null;
}

function sectionValue(source, multiplier) {
  const tokens = source.match(/[\d.,]+|[천백십]/gu) ?? [];
  if (tokens.join('') !== source || !tokens.length) return null;
  let total = 0n, previousUnit = 10000n, number = null;
  for (const token of tokens) {
    if (smallUnits[token]) {
      const unit = smallUnits[token];
      if (number === null || unit >= previousUnit) return null;
      const term = scaledNumber(number, multiplier * unit);
      if (term === null) return null;
      total += term; previousUnit = unit; number = null;
    } else {
      if (number !== null) return null;
      number = token;
    }
  }
  if (number !== null) {
    const term = scaledNumber(number, multiplier);
    if (term === null) return null;
    total += term;
  }
  return total;
}

export function parseGoalScaledInteger(source, scale = 1n) {
  if (typeof scale !== 'bigint' || scale <= 0n) return null;
  if (/\d\s+\d/u.test(source)) return null;
  const expression = source.replaceAll(/\s/gu, '').replace(/^\+/u, '');
  if (!expression || !/^[\d.,조억만천백십]+$/u.test(expression)) return null;
  let total = 0n, start = 0, previousUnit = 10000000000000000n;
  for (let index = 0; index < expression.length; index++) {
    const unit = bigUnits[expression[index]];
    if (!unit) continue;
    if (unit >= previousUnit) return null;
    const term = sectionValue(expression.slice(start, index), unit * scale);
    if (term === null) return null;
    total += term; previousUnit = unit; start = index + 1;
  }
  if (start < expression.length) {
    const tail = sectionValue(expression.slice(start), scale);
    if (tail === null) return null;
    total += tail;
  }
  return total <= max ? Number(total) : null;
}

/** masked must have the same UTF-16 length as source (quoted data is spaces). */
export function extractGoalKrwAmounts(source, masked) {
  // Capture unsupported numeric notation and Korean numerals as one unresolved
  // fact. Never recover a plausible suffix from e.g. -100, 1e3 or 1,00.
  // Whitespace is the only repeated segment separator. Adjacent numeric/unit
  // characters share one class, avoiding exponential partition backtracking
  // on a long numeric string that has no currency suffix.
  const pattern = /(?<![\p{L}\p{N}.,+\-−])([+\-−0-9.,eE영공일이삼사오육칠팔구십백천만억조]+(?:\s+[+\-−0-9.,eE영공일이삼사오육칠팔구십백천만억조]+)*)/gu;
  return [...masked.matchAll(pattern)].flatMap(match => {
    // Test the currency suffix after consuming a whole candidate. Including
    // the suffix in the repeated regex would retry many shorter prefixes of a
    // long space-separated numeric non-money input.
    const suffix = /^\s*원(?:\s*(이하|미만|이상|초과))?/u.exec(masked.slice(match.index + match[0].length));
    if (!suffix) return [];
    const end = match.index + match[0].length + suffix[0].length;
    const minorUnits = parseGoalScaledInteger(match[1]);
    return [{text: source.slice(match.index, end),
      sourceSpan: {start: match.index, end}, currency: 'KRW', minorUnits,
      comparator: ({이하: 'lte', 미만: 'lt', 이상: 'gte', 초과: 'gt'})[suffix[1]] ?? null,
      status: minorUnits === null ? 'unresolved' : 'parsed'}];
  });
}

// Deliberately bounded ISO 4217 subset. Symbols shared by several currencies
// and currencies outside this exact-arithmetic contract remain unresolved.
// No exchange-rate conversion or transaction-cost validation happens here.
const foreignDigits = {USD:2, EUR:2, GBP:2, JPY:0, KWD:3};
const comparatorCode = {이하:'lte',미만:'lt',이상:'gte',초과:'gt'};
function foreignCurrency(token) {
  const compact=token.replaceAll(/\s/gu,'');
  return ({'US$':'USD','미국달러':'USD','유로':'EUR','€':'EUR','엔':'JPY'})[compact]
    ?? (/^[A-Z]{3}$/u.test(compact)?compact:null);
}

export function extractGoalAmounts(source,masked) {
  const amounts=extractGoalKrwAmounts(source,masked);
  const tokens=/(?:US\$|미국\s*달러|[A-Z]{3}(?![A-Z])|달러|유로|엔|[$€¥£])/gu;
  // One flat character class prevents exponential partitioning. Numeric
  // boundaries retain the whole invalid expression rather than its tail.
  const numberChars='[+\\-−0-9.,eE영공일이삼사오육칠팔구십백천만억조]';
  const before=new RegExp(`(?<![\\p{L}\\p{N}.,+\\-−])(${numberChars}[+\\-−0-9.,eE영공일이삼사오육칠팔구십백천만억조\\s]*)$`,'u');
  const after=new RegExp(`^\\s*(${numberChars}[+\\-−0-9.,eE영공일이삼사오육칠팔구십백천만억조\\s]*)(?![\\p{L}\\p{N}.,+\\-−])`,'u');
  for(const token of masked.matchAll(tokens)) {
    const preceding=masked[token.index-1]??'';
    if(/\p{L}/u.test(preceding)&&!/[eE영공일이삼사오육칠팔구십백천만억조]/u.test(preceding))continue;
    const tokenEnd=token.index+token[0].length;
    const left=before.exec(masked.slice(0,token.index));
    const right=left?null:after.exec(masked.slice(tokenEnd));
    if(!left&&!right)continue;
    const numeric=(left?.[1]??right[1]).trimEnd();
    const start=left?left.index:token.index;
    const numberEnd=left?tokenEnd:tokenEnd+right[0].indexOf(right[1])+numeric.length;
    const qualifier=/^\s*(이하|미만|이상|초과)/u.exec(masked.slice(numberEnd));
    const end=numberEnd+(qualifier?.[0].length??0);
    const overlap=amounts.find(a=>a.sourceSpan.start<end&&a.sourceSpan.end>start);
    if(overlap) {
      // Two currency labels attached to one numeric expression are conflicting
      // source facts, never a reason to silently select the first currency.
      overlap.sourceSpan={start:Math.min(start,overlap.sourceSpan.start),end:Math.max(end,overlap.sourceSpan.end)};
      overlap.text=source.slice(overlap.sourceSpan.start,overlap.sourceSpan.end);
      overlap.currency=null;overlap.minorUnits=null;overlap.status='unresolved';
      overlap.comparator=comparatorCode[qualifier?.[1]]??overlap.comparator;
      continue;
    }
    const currency=foreignCurrency(token[0]);
    const digits=foreignDigits[currency];
    const value=digits===undefined?null:scaledNumber(numeric.replace(/^\+/u,''),10n**BigInt(digits));
    const minorUnits=value===null||value>max?null:Number(value);
    amounts.push({text:source.slice(start,end),sourceSpan:{start,end},currency,minorUnits,
      comparator:comparatorCode[qualifier?.[1]]??null,status:minorUnits===null?'unresolved':'parsed'});
  }
  return amounts.sort((a,b)=>a.sourceSpan.start-b.sourceSpan.start);
}

/** Exact same-currency declared-minor-unit comparison. No price observation,
 * exchange conversion, transaction authority or budget reservation is granted.
 */
export function compareGoalAmount(fact,measurement){
 const base={executionAuthority:false,measurementProvenanceVerified:false};
 const valid=value=>Number.isSafeInteger(value)&&value>=0;
 if(fact?.status!=='parsed'||!['KRW','USD','EUR','GBP','JPY','KWD'].includes(fact.currency)
  ||!valid(fact.minorUnits)||!['lte','lt','gte','gt'].includes(fact.comparator))
  return {...base,passed:false,reason:'source-amount-unresolved'};
 if(measurement?.currency!==fact.currency)return {...base,passed:false,reason:'currency-mismatch'};
 if(measurement.minorUnits===null)return {...base,passed:false,reason:'amount-unmeasured'};
 if(!valid(measurement.minorUnits))return {...base,passed:false,reason:'amount-invalid'};
 const value=measurement.minorUnits,bound=fact.minorUnits;
 const passed=fact.comparator==='lte'?value<=bound:fact.comparator==='lt'?value<bound:
  fact.comparator==='gte'?value>=bound:value>bound;
 return {...base,passed,reason:passed?null:'amount-condition-not-met',currency:fact.currency,
  comparator:fact.comparator,boundaryMinor:bound,declaredMinor:value};
}
