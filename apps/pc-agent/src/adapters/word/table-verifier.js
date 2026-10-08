import {readFile,mkdtemp,writeFile,rm,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,path)=>{const r=relative(root,path);return !isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
export async function verifyDocumentTables(path,expectedTables,{allowedRoots=[],python=process.env.JARVIS_PYTHON??'python',profile='tables'}={}){
 let scratch;
 try{
  const roots=await Promise.all(allowedRoots.map(root=>realpath(resolve(root))));
  const target=resolve(path),physical=await realpath(target),before=await lstat(target);
  if(!target.toLowerCase().endsWith('.docx')||physical!==target||!roots.some(root=>inside(root,physical))
    ||!before.isFile()||before.isSymbolicLink()||before.size>16*1024*1024)throw Error('word-table-scope-invalid');
  const data=await readFile(target),after=await lstat(target);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||data.length!==after.size)throw Error('word-table-file-changed');
  const input=JSON.stringify(expectedTables);
  if(Buffer.byteLength(input)>1024*1024)throw Error('word-table-request-limit');
  scratch=await mkdtemp(join(tmpdir(),'jarvis-word-tables-'));
  const copy=join(scratch,'document.docx');await writeFile(copy,data,{flag:'wx'});
  const checked=await new Promise((accept,reject)=>{
   const child=execFile(python,[fileURLToPath(new URL('./verify_tables.py',import.meta.url)),copy,...(profile==='paragraphs'?['--paragraphs']:[])],
    {windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:256*1024},(error,stdout)=>{
     try{const result=JSON.parse(stdout);accept(result);}catch{reject(error??Error('word-table-helper-invalid'));}
    });
   child.stdin.on('error',()=>{});child.stdin.end(input);
  });
  const current=await lstat(target);
  if(current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs
    ||await realpath(target)!==physical||sha(await readFile(target))!==sha(data))throw Error('word-table-file-changed');
  if(checked.passed&&checked.sha256!==sha(data))throw Error('word-table-digest-mismatch');
  return checked;
 }catch(error){return {passed:false,reason:/^word-table-[a-z-]+$/u.test(error.message)?error.message:'word-table-independent-check-failed'};}
 finally{if(scratch&&inside(await realpath(tmpdir()),await realpath(scratch)))await rm(scratch,{recursive:true,force:true});}
}
export const verifyDocumentParagraphs=(path,expected,options={})=>verifyDocumentTables(path,expected,{...options,profile:'paragraphs'});
