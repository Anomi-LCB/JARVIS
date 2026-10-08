const normalized=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(normalized):Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalized(value[key])])):value;
const same=(a,b)=>JSON.stringify(normalized(a))===JSON.stringify(normalized(b));
export function cardRequiredContent(card){
 const {title,label,subtitle,body,footer,accent}=card;
 return {title,label,subtitle,body:Array.isArray(body)?body:body?[body]:[],footer,accent};
}
export function validateCardPublicationResult(prepared,result){
 if(prepared?.manifestVersion!=='jarvis-card-publication-v1'||!Array.isArray(prepared.cards)||!prepared.cards.length||prepared.cards.length>12
   ||!same(prepared.paths,prepared.cards.map(card=>card.path))||!same(result.artifactManifest,prepared)
   ||!same(result.layoutRequirements,prepared.cards)||!same(result.outputPaths,prepared.paths)
   ||result.cardCount!==prepared.cards.length||result.cards?.length!==prepared.cards.length)throw Error('CARD_ORIGINAL_CONTRACT_MISMATCH');
 for(const [index,card] of prepared.cards.entries()){
  const actual=result.cards[index];
  if(actual.path!==card.path||actual.name!==card.fileName||actual.width!==prepared.width||actual.height!==prepared.height
    ||!same(actual.requiredContent,cardRequiredContent(card)))throw Error('CARD_ORIGINAL_CONTENT_MISMATCH');
 }
 return true;
}
