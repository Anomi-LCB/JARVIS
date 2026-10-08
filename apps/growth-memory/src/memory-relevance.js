// Lexical relevance only. This does not infer intent, permission or truth.
const fillers = new Set(['오늘','내일','이번','지난','지금','이전','다시','좀','내','제','그','그것','그거','부탁인데','부탁해',
  '해주세요','해줘','보여줘','알려줘','정리해줘','확인해줘','검토해줘','점검해줘','요약해줘','비교해줘',
  'please','my','the','a','an','and','for','today','now']);
function terms(value, {identifierSegments=false}={}) {
  const words=String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return new Set(words.flatMap(word=>identifierSegments?[word,...word.split(/[_-]+/u).filter(part=>part.length>=2)]:[word]).flatMap(word=>{
    if(fillers.has(word))return [];
    const stem=/^[가-힣]+$/u.test(word)?word.replace(/(?:에서|으로|은|는|을|를|이|가|로|와|과|의|에|도|만)$/u,''):word;
    return stem.length>=2&&!fillers.has(stem)?[word,stem]:[word];
  }));
}
const contentFields=['statement','description','normalizedDescription','text','summary','lesson','reason','command','normalizedCommand'];

// Compile request terms once; offsets refer to the original UTF-16 source text,
// even when a token normalizes to a different number of characters.
export function createMemoryTextMatcher(query) {
  const requested=terms(query);
  return {hasTerms:requested.size>0,findMatch(text) {
    if(!requested.size)return null;
    for(const match of String(text ?? '').matchAll(/[\p{L}\p{N}_-][\p{L}\p{M}\p{N}_-]*/gu)) {
      const available=terms(match[0],{identifierSegments:true});
      if([...available].some(term=>requested.has(term)))return {start:match.index,end:match.index+match[0].length};
    }
    return null;
  }};
}
export function memoryItemRelevant(item, query, {scope} = {}) {
  // Retain the legacy administrative query contract; automatic scoped recall
  // never searches provenance IDs, revisions or confidence metadata.
  if(scope===undefined)return JSON.stringify(item).includes(String(query).split(' ')[0]);
  if(!String(query ?? '').trim())return true;
  const requested=terms(query);if(!requested.size)return false;
  const content=contentFields.filter(key=>typeof item?.[key]==='string').map(key=>item[key]);
  if(Array.isArray(item?.outputPaths))content.push(...item.outputPaths.filter(v=>typeof v==='string'));
  const available=terms(content.join(' '),{identifierSegments:true});
  return [...requested].some(term=>available.has(term));
}
