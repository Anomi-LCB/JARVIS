import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readFileSnapshot} from '../filesystem/read-text-snapshot.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
export class PdfTextReader {
 constructor({python=process.env.JARVIS_PDF_PYTHON??'python',timeoutMs=10000,spawnProcess=spawn}={}){this.python=python;this.timeoutMs=timeoutMs;this.spawnProcess=spawnProcess;}
 async read({path,firstPage=1,maxPages=10,expectedSha256,checkAllowedPath}){
  if(!Number.isSafeInteger(firstPage)||firstPage<1||firstPage>500||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>20) throw Error('PDF_PAGE_RANGE_INVALID');
  const {bytes}=await readFileSnapshot({path,maxBytes:16*1024*1024,checkAllowedPath});const sourceSha256=hash(bytes);
  if(expectedSha256!==undefined&&expectedSha256!==sourceSha256) throw Error('PDF_SOURCE_HASH_MISMATCH');
  const wheel=fileURLToPath(new URL('../../../vendor/pypdf/pypdf-6.19.0-py3-none-any.whl',import.meta.url));
  const provenance=JSON.parse(await readFile(fileURLToPath(new URL('../../../vendor/pypdf/provenance.json',import.meta.url)),'utf8'));
  if(hash(await readFile(wheel))!==provenance.sha256||provenance.version!=='6.19.0') throw Error('PDF_PARSER_INTEGRITY_FAILED');
  const result=await new Promise((accept,reject)=>{
    const child=this.spawnProcess(this.python,['-I','-B',fileURLToPath(new URL('./extract-text.py',import.meta.url)),wheel,String(firstPage),String(maxPages)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',reason=null;const timer=setTimeout(()=>{reason='PDF_PARSE_TIMEOUT';child.kill();},this.timeoutMs);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>1024*1024){reason='PDF_OUTPUT_LIMIT';child.kill();}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.stdin.end(bytes);
    child.once('error',()=>{clearTimeout(timer);reject(Error('PDF_PYTHON_UNAVAILABLE'));});
    child.once('close',code=>{clearTimeout(timer);if(reason||code!==0)reject(Error(reason??'PDF_PARSER_UNAVAILABLE'));else{try{accept(JSON.parse(output));}catch{reject(Error('PDF_RECEIPT_INVALID'));}}});
  });
  if(result.status!=='success') throw Error(result.reason??'PDF_PARSE_FAILED');
  if(result.sourceSha256!==sourceSha256||result.firstPage!==firstPage||result.parserVersion!=='6.19.0'
    ||result.verificationScope!=='text-layer-only'||result.ocrPerformed!==false
    ||!Number.isSafeInteger(result.totalPages)||result.totalPages<firstPage||result.totalPages>500
    ||!Array.isArray(result.pages)||result.pages.length!==Math.min(maxPages,result.totalPages-firstPage+1)
    ||result.pages.some((page,index)=>page.pageNumber!==firstPage+index||typeof page.text!=='string'||!page.text.trim())
    ||result.pages.reduce((sum,page)=>sum+page.text.length,0)>100000
    ||result.truncated!==(firstPage+result.pages.length-1<result.totalPages))throw Error('PDF_RECEIPT_INVALID');
  const after=await readFileSnapshot({path,maxBytes:16*1024*1024,checkAllowedPath});
  if(hash(after.bytes)!==sourceSha256)throw Error('PDF_SOURCE_CHANGED');
  return {...result,bytes:bytes.length,sourceUnchanged:true,readOnly:true};
 }
}
