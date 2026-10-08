import {createHash} from 'node:crypto';
const normalize=value=>value instanceof Date?value.toISOString():value&&typeof value==='object'
 ? Array.isArray(value)?value.map(normalize):Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,normalize(value[key])])):value;
export const canonicalEdit=value=>JSON.stringify(normalize(value));
export const editDigest=value=>createHash('sha256').update(canonicalEdit(value)).digest('hex');
export function validateDocumentEditResult(prepared,result){
 if(prepared?.version!=='jarvis-document-edit-v1'||canonicalEdit(result.artifactManifest)!==canonicalEdit(prepared)
   ||canonicalEdit(result.outputPaths)!==canonicalEdit(prepared.paths)||result.targetPath!==prepared.targetPath
   ||result.backupPath!==prepared.backupPath||result.sourceSha256!==prepared.sourceSha256
   ||!Array.isArray(result.editedCells)||!result.editedCells.length)throw Error('DOCUMENT_EDIT_ORIGINAL_CONTRACT_MISMATCH');
 return true;
}
