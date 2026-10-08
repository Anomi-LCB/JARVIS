/** Bounded explicit file creation. Everything after the content marker is data. */
export function parseLiteralTextFileRequest(text) {
 if(typeof text!=='string'||text.length>1200)return null;
 const match=/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))\s+(?:(?:텍스트|메모)\s+)?파일(?:을|를)?\s*(?:만들어줘|만들어주세요|생성해줘|생성해주세요)[.!]?\s+내용은\s*[:：]?\s*([\s\S]+)$/u.exec(text.trim());
 if(!match)return null;
 let fileName=match[1]??match[2]??match[3];
 if(/[\u0000-\u001f<>|?*]/u.test(fileName)||fileName.includes('..')||/[ .]$/u.test(fileName))return null;
 if(!/\.txt$/iu.test(fileName)){if(/\.[^/\\]+$/u.test(fileName))return null;fileName+='.txt';}
 let content=match[4].trim();
 if(content.startsWith('"')||content.startsWith("'")){
  const quote=content[0];if(content.at(-1)!==quote||content.slice(1,-1).includes(quote))return null;
  content=content.slice(1,-1);
 }else if(/[;\r\n]/u.test(content)||/(?:그리고|그다음|다음으로|이어서|[.!]\s+)\s*[\s\S]*(?:보내|발송|삭제|제거|저장|수정|변경|실행|만들)/u.test(content))return null;
 return {fileName,content};
}

/** Whole-request grammar: separators inside quoted data are never actions. */
export function parseLiteralTextFileBatch(text) {
  if (typeof text !== 'string' || text.length > 4800) return null;
  const single = parseLiteralTextFileRequest(text);
  if (single) return [single];
  let quote = null, start = 0;
  const clauses = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === quote) quote = null; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ';') { clauses.push(text.slice(start, i)); start = i + 1; }
  }
  if (quote) return null;
  clauses.push(text.slice(start));
  if (clauses.length < 2 || clauses.length > 4) return null;
  const requests = clauses.map(parseLiteralTextFileRequest);
  if (requests.some(item => !item)) return null;
  // Windows names are case-insensitive; ambiguous repeated targets never write.
  if (new Set(requests.map(item => item.fileName.toLowerCase())).size !== requests.length) return null;
  return requests;
}

export function isLiteralTextFileAttempt(text) {
  return typeof text === 'string' && /파일(?:을|를)?\s*(?:만들어줘|만들어주세요|생성해줘|생성해주세요)[.!]?\s+내용은/u.test(text);
}
