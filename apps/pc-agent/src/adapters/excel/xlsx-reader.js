import {createHash} from 'node:crypto';
import {readFileSnapshot} from '../filesystem/read-text-snapshot.js';
import {readXlsxRegion} from '../../../../../packages/core/src/mission/xlsx-cell-evidence.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class XlsxRegionReader {
 async read({path,sheetName,range='A1:J100',expectedSha256,checkAllowedPath}){
  const {bytes}=await readFileSnapshot({path,maxBytes:16*1024*1024,checkAllowedPath});
  const sourceSha256=hash(bytes);if(expectedSha256!==undefined&&expectedSha256!==sourceSha256)throw Error('XLSX_SOURCE_HASH_MISMATCH');
  const region=readXlsxRegion(bytes,{sheetName,range});
  const after=await readFileSnapshot({path,maxBytes:16*1024*1024,checkAllowedPath});
  if(hash(after.bytes)!==sourceSha256)throw Error('XLSX_SOURCE_CHANGED');
  return {...region,sourceSha256,sourceUnchanged:true,readOnly:true,bytes:bytes.length,verificationScope:'literal-region-values'};
 }
}
