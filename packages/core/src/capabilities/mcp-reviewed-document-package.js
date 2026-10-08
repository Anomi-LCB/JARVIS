import {createHash} from 'node:crypto';
import {realpathSync, statSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {readTextSnapshot} from '../../../../apps/pc-agent/src/adapters/filesystem/read-text-snapshot.js';
import {createMcpIntentBinding} from './mcp-intent-binding.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const within = (root, path) => { const p=relative(root,path); return p==='' || (!p.startsWith('..') && !isAbsolute(p)); };
export const reviewedDocumentTool = Object.freeze({
  name:'read_document',
  inputSchema:{type:'object',properties:{documentId:{type:'string'}},required:['documentId'],additionalProperties:false}
});

/** Local deployment configuration only. Paths/authority must never come from MCP metadata. */
export function createReviewedDocumentCatalog({allowedRoot, documents, authorize}) {
  if(typeof allowedRoot!=='string' || !(documents instanceof Map) || !documents.size || documents.size>100 || typeof authorize!=='function') throw fail('A_MCP_DOCUMENT_CONFIG_INVALID');
  const root=realpathSync(resolve(allowedRoot));
  if(!statSync(root).isDirectory())throw fail('A_MCP_DOCUMENT_CONFIG_INVALID');
  const sources=new Map();
  for(const [id,path] of documents){
    if(typeof id!=='string'||!/^[-a-zA-Z0-9_가-힣]{1,64}$/u.test(id)||typeof path!=='string')throw fail('A_MCP_DOCUMENT_CONFIG_INVALID');
    const lexical=resolve(path),physical=realpathSync(lexical);
    if(!within(root,lexical)||!within(root,physical)||!statSync(physical).isFile())throw fail('A_MCP_DOCUMENT_SCOPE_INVALID');
    sources.set(id,{lexical,physical});
  }
  // Bind the reviewed selection to configured sources, without persisting paths in installation records.
  const scope=digest(JSON.stringify([...sources].sort(([a],[b])=>a.localeCompare(b))));
  const fingerprint=digest(`reviewed-document-v1:${scope}`);
  const verifierFingerprint=digest(`independent-utf8-snapshot-v1:${scope}`);
  async function verify({arguments:args,result}){
    if(!args||Object.keys(args).length!==1||!sources.has(args.documentId))return {valid:false};
    const source=sources.get(args.documentId);
    // Keep worst-case escaped text + structured duplicate below the transport's 256 KiB limit.
    const snapshot=await readTextSnapshot({path:source.lexical,maxBytes:16384,checkAllowedPath:async()=>{
      if(await realpath(source.lexical)!==source.physical || !within(root,source.physical))throw fail('A_MCP_DOCUMENT_SOURCE_CHANGED');
    }});
    const expected={documentId:args.documentId,text:snapshot.text,sha256:digest(snapshot.bytes),byteLength:snapshot.bytes.length};
    const content=result?.structuredContent;
    // Compare actual bytes and text, not merely a provider's hash or success message.
    const valid=Boolean(content && Object.keys(content).length===4
      && Object.keys(expected).every(key=>content[key]===expected[key])
      && result.isError!==true && Array.isArray(result.content) && result.content.length===1
      && result.content[0].type==='text' && result.content[0].text===JSON.stringify(expected));
    return {valid,evidenceRef:valid?`local-document:${args.documentId}:${expected.sha256}`:undefined};
  }
  const item={packageId:'jarvis.reviewed-document',version:'1.0.0',tool:reviewedDocumentTool.name,fingerprint,authorize,
    verifiers:new Map([['document.snapshot',{fingerprint:verifierFingerprint,verify}]]),
    createIntentBinding:({manager,connectionId,tool})=>createMcpIntentBinding({manager,connectionId,tool,
      fingerprint:digest(`document-korean-grammar-v1:${scope}`),resolver:objective=>{
        const match=/^등록된 MCP로 "([-a-zA-Z0-9_가-힣]{1,64})" 문서를 읽고 원본과 대조해$/u.exec(objective);
        return match&&sources.has(match[1])?{arguments:{documentId:match[1]},expectedText:'documentId'}:null;
      }})};
  return new Map([['reviewed.document',item]]);
}
