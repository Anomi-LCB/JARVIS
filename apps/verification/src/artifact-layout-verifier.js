import {readFile,writeFile,mkdtemp,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {layoutRequirementsSha256,normalizeLayoutRequirements} from '../../../packages/shared/src/artifact-layout-requirements.js';
import {verifyCardLayout} from '../../pc-agent/src/adapters/visual/card-layout-contract.js';
const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,path)=>{const rel=relative(root,path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
/** Independent G re-read. No producer success claim grants a passed result. */
export async function verifyArtifactLayoutCurrent({executionResult,allowedRoots=[]}){
 const tool=executionResult.toolName;
 if(!['visual.createCards','powerpoint.create'].includes(tool))return null;
 let roots;try{roots=await Promise.all(allowedRoots.map(root=>realpath(resolve(root))));}catch{return {passed:false,proofs:[],reason:'artifact-layout-roots-unavailable'};}
 const snapshots=[];
 const read=async path=>{
  const target=resolve(path),physical=await realpath(target),info=await lstat(target);
  if(!roots.some(root=>inside(root,physical))||physical!==target||!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('artifact-layout-scope-or-size-invalid');
  const bytes=await readFile(target),after=await lstat(target);
  if(after.ino!==info.ino||after.dev!==info.dev||after.mtimeMs!==info.mtimeMs||after.size!==bytes.length)throw Error('artifact-layout-file-changed');
  const digest=sha(bytes);snapshots.push({path:target,sha256:digest});return bytes;
 };
 const scratch=await mkdtemp(join(tmpdir(),'jarvis-g-layout-'));
 const physicalScratch=await realpath(scratch);
 try{
  const proofs=[];
  if(tool==='visual.createCards'){
   if(!Array.isArray(executionResult.cards)||!executionResult.cards.length||executionResult.cards.length>12)throw Error('artifact-layout-cards-invalid');
   const entries=[];
   for(const [index,card] of executionResult.cards.entries()){
    const required=normalizeLayoutRequirements('image.cardLayout',card.requiredContent);
    if(!verifyCardLayout(required,card.layout,card.width,card.height).passed)throw Error('artifact-layout-card-invalid');
    const bytes=await read(card.path);
    if(bytes.length<24||bytes.readUInt32BE(16)!==card.width||bytes.readUInt32BE(20)!==card.height||sha(bytes)!==card.sha256)throw Error('artifact-layout-card-changed');
    const tempPath=join(scratch,`card-${index}.png`);await writeFile(tempPath,bytes);
    entries.push({card:{...required,path:tempPath},layout:card.layout});
    proofs.push({kind:'image.cardLayout',path:resolve(card.path),requirementsSha256:layoutRequirementsSha256('image.cardLayout',required),width:card.width,height:card.height,files:[{path:resolve(card.path),sha256:sha(bytes)}]});
   }
   const payload=Buffer.from(JSON.stringify({entries}),'utf8').toString('base64');
   const output=await run(process.env.JARVIS_PYTHON??'python',[fileURLToPath(new URL('../../pc-agent/src/adapters/visual/verify_card_pixels.py',import.meta.url)),payload],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,encoding:'utf8'});
   if(JSON.parse(output.stdout).status!=='passed')throw Error('artifact-layout-card-pixels-failed');
  }else{
   const requirements=normalizeLayoutRequirements('presentation.contentLayout',executionResult.layoutRequirements);
   const source=resolve(executionResult.presentationSourcePath??executionResult.targetPath),bytes=await read(source);
   if(!source.toLowerCase().endsWith('.pptx'))throw Error('artifact-layout-presentation-source-required');
   await writeFile(join(scratch,'presentation.pptx'),bytes);
   const nativePath=join(executionResult.renderDirectory,'native-report.json'),nativeBytes=await read(nativePath);
   const native=JSON.parse(nativeBytes.toString('utf8').replace(/^\uFEFF/u,''));
   if(native.slides?.length!==requirements.length)throw Error('artifact-layout-presentation-count-invalid');
   await writeFile(join(scratch,'native-report.json'),nativeBytes);
   for(let index=1;index<=requirements.length;index++){
    if(native.slides[index-1].png!==`slide-${index}.png`)throw Error('artifact-layout-render-name-invalid');
    await writeFile(join(scratch,`slide-${index}.png`),await read(join(executionResult.renderDirectory,`slide-${index}.png`)));
   }
   const requestPath=join(scratch,'request.json');await writeFile(requestPath,JSON.stringify({staging:scratch,deck:{slides:requirements}}));
   const output=await run(process.env.JARVIS_PYTHON??'python',[fileURLToPath(new URL('../../pc-agent/src/adapters/powerpoint/verify_presentation.py',import.meta.url)),requestPath],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,encoding:'utf8'});
   const verified=JSON.parse(output.stdout);
   if(verified.status!=='verified'||verified.sha256!==sha(bytes))throw Error('artifact-layout-presentation-current-invalid');
   if(executionResult.targetPath?.toLowerCase().endsWith('.pdf')){
    const pdf=await read(executionResult.targetPath),pdfPath=join(scratch,'presentation.pdf');
    await writeFile(pdfPath,pdf);
    const pdfRequest=join(scratch,'pdf-request.json');
    await writeFile(pdfRequest,JSON.stringify({pdfPath,verifyOnly:false,expectedText:requirements.flatMap(slide=>[slide.title,...slide.bullets]).filter(Boolean)}));
    const checked=await run(process.env.JARVIS_PYTHON??'python',[fileURLToPath(new URL('../../pc-agent/src/adapters/hwpx/raster-pdf.py',import.meta.url)),pdfRequest],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,encoding:'utf8'});
    const content=JSON.parse(checked.stdout);
    if(content.requiredTextVerified!==true||content.textBoundsVerified!==true||content.pageCount!==requirements.length)throw Error('artifact-layout-presentation-pdf-current-invalid');
   }
   proofs.push({kind:'presentation.contentLayout',path:source,requirementsSha256:layoutRequirementsSha256('presentation.contentLayout',requirements),files:[...snapshots]});
  }
  // Detect change during the independent helper invocation before issuing G proof.
  for(const snapshot of [...snapshots])if(sha(await read(snapshot.path))!==snapshot.sha256)throw Error('artifact-layout-changed-during-verification');
  return {passed:true,proofs,semanticMeaning:'not-evaluated',scope:tool==='visual.createCards'?'literal-glyph-pixels-and-layout':'saved-ooxml-native-bounds-and-raster-ink'};
 }catch(error){return {passed:false,proofs:[],reason:/^(artifact-layout)-[a-z-]+$/u.test(error.message)?error.message:'artifact-layout-independent-check-failed'};}
 finally{if(await realpath(scratch)===physicalScratch&&inside(await realpath(tmpdir()),physicalScratch))await rm(scratch,{recursive:true,force:true});}
}
