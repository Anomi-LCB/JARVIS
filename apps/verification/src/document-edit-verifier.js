import {lstat,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSnapshot} from '../../pc-agent/src/adapters/filesystem/read-text-snapshot.js';
import {canonicalEdit,validateDocumentEditResult} from '../../pc-agent/src/adapters/excel/edit-contract.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyDocumentEditCurrent({executionResult:result,allowedRoots=[]}){
 try{
  const plan=result.artifactManifest;validateDocumentEditResult(plan,result);
  const roots=await Promise.all(allowedRoots.map(root=>realpath(resolve(root))));
  const checkAllowedPath=async path=>{const actual=await realpath(path),info=await lstat(path);
   if(info.isSymbolicLink()||!info.isFile()||!roots.some(root=>{const rel=relative(root,actual);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}))throw Error('document-edit-current-scope-invalid');};
  const read=path=>readFileSnapshot({path,maxBytes:64*1024*1024,checkAllowedPath});
  const backup=(await read(plan.backupPath)).bytes,current=(await read(plan.targetPath)).bytes;
  if(sha(backup)!==plan.sourceSha256)throw Error('document-edit-original-backup-hash-mismatch');
  const mod=await import('../../pc-agent/node_modules/exceljs/excel.js'),ExcelJS=mod.default??mod;
  const before=new ExcelJS.Workbook(),after=new ExcelJS.Workbook();await before.xlsx.load(backup);await after.xlsx.load(current);
  const snapshots=wb=>Object.fromEntries(wb.worksheets.map(ws=>{const cells={};ws.eachRow(row=>row.eachCell(cell=>{cells[cell.address]=cell.value;}));return [ws.name,cells];}));
  const expected=snapshots(before),actual=snapshots(after),sheet=plan.sheet??before.worksheets[0]?.name,cells=expected[sheet];
  if(!cells)throw Error('document-edit-requested-sheet-missing');
  const changed=[];
  for(const edit of plan.edits){
   if(edit.cell){const cell=edit.cell.toUpperCase();cells[cell]=edit.value;changed.push(cell);}
   else{const hits=Object.keys(cells).filter(cell=>String(cells[cell]??'').includes(String(edit.findText)));
    if(!hits.length||hits.length>1&&!['all','first'].includes(edit.scope))throw Error('document-edit-find-scope-unresolved');
    for(const cell of edit.scope==='first'?hits.slice(0,1):hits){cells[cell]=typeof cells[cell]==='string'?cells[cell].split(String(edit.findText)).join(String(edit.value)):edit.value;changed.push(cell);}}
  }
  // Excel omits cleared cells; compare their values as null in both maps.
  for(const cell of changed){if(cells[cell]==null)delete cells[cell];}
  if(canonicalEdit(actual)!==canonicalEdit(expected)||canonicalEdit(result.editedCells.map(v=>v.toUpperCase()))!==canonicalEdit(changed))throw Error('document-edit-current-cells-mismatch');
  if(sha((await read(plan.targetPath)).bytes)!==sha(current)||sha((await read(plan.backupPath)).bytes)!==sha(backup))throw Error('document-edit-current-files-changed');
  return {passed:true,sourceSha256:sha(backup),outputSha256:sha(current),changedCells:changed,scope:'all-worksheet-cell-values-not-layout-or-native-formula-recalculation'};
 }catch(error){return {passed:false,reason:error.code??error.message};}
}
