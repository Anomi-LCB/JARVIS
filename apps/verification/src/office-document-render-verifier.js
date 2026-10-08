import {readFile,writeFile,mkdtemp,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {expectedDocContentItems} from '../../pc-agent/src/pc-agent-runtime.js';
import {verifyDocumentTables} from '../../pc-agent/src/adapters/word/table-verifier.js';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
/** Re-read native Word output, including pdf.create's saved DOCX source. */
export async function verifyOfficeDocumentRenderingCurrent({executionResult,allowedRoots=[]}){
 let scratch;const snapshots=[];
 try{
  const roots=await Promise.all(allowedRoots.map(r=>realpath(resolve(r))));
  const read=async path=>{path=resolve(path);const actual=await realpath(path),info=await lstat(path);const inside=roots.some(root=>{const r=relative(root,actual);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);});
   if(!inside||actual!==path||!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('office-render-current-scope-invalid');
   const bytes=await readFile(path);snapshots.push({path,sha256:sha(bytes)});return bytes;};
  const directory=resolve(executionResult.renderDirectory),sourcePath=resolve(executionResult.documentSourcePath);
  const native=JSON.parse((await read(join(directory,'native-report.json'))).toString('utf8').replace(/^\uFEFF/u,''));
  const source=await read(sourcePath),pdfPath=executionResult.targetPath.toLowerCase().endsWith('.pdf')?executionResult.targetPath:join(directory,'document.pdf'),pdf=await read(pdfPath);
  if(native.status!=='verified'||native.renderer!=='Microsoft Word COM'||native.savedReopenedReadOnly!==true||native.actualRenderingExecuted!==true||native.jobAssigned!==true||native.parentWatchEnabled!==true||native.sourceSha256!==sha(source)||native.pdfSha256!==sha(pdf)||!executionResult.document)throw Error('office-render-current-receipt-invalid');
  const expectedTables=executionResult.document.blocks.filter(b=>b.type==='table').map(b=>[b.columns,...b.rows]);
  const tableProof=await verifyDocumentTables(sourcePath,expectedTables,{allowedRoots});if(!tableProof.passed||tableProof.sha256!==sha(source))throw Error('office-render-current-tables-invalid');
  scratch=await mkdtemp(join(tmpdir(),'jarvis-g-office-render-'));const snapshot=join(scratch,'document.pdf'),input=join(scratch,'input.json');await writeFile(snapshot,pdf,{flag:'wx'});await writeFile(input,JSON.stringify({pdfPath:snapshot,expectedText:expectedDocContentItems(executionResult.document)}),{flag:'wx'});
  const {stdout}=await run(process.env.JARVIS_HWPX_PYTHON??'python',[fileURLToPath(new URL('../../pc-agent/src/adapters/hwpx/raster-pdf.py',import.meta.url)),input],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  const proof=JSON.parse(stdout);if(proof.pageCount!==native.pageCount||proof.pdfSha256!==sha(pdf)||proof.requiredTextVerified!==true||proof.textBoundsVerified!==true)throw Error('office-render-current-pdf-invalid');
  for(const snapshot of snapshots)if(sha(await readFile(snapshot.path))!==snapshot.sha256)throw Error('office-render-current-file-changed');
  return {passed:true,sourceSha256:sha(source),pdfSha256:sha(pdf),actualRenderingExecuted:true,savedStructureVerified:true,requiredPdfTextVerified:true,textBoundsVerified:true,pageCount:proof.pageCount,visualQualityVerified:false};
 }catch(error){return {passed:false,reason:String(error.message).slice(0,600)};}
 finally{if(scratch)await rm(scratch,{recursive:true,force:true});}
}
