import {createHash} from 'node:crypto';
const normalize=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(normalize):Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
export const macroPublicationDigest=value=>createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
export function validateMacroPublicationResult(prepared,result) {
  if(prepared?.version!=='jarvis-macro-publication-v1'||typeof prepared.path!=='string'
    ||!prepared.record||macroPublicationDigest(result?.macroPublication)!==macroPublicationDigest(prepared)
    ||result.macroName!==prepared.record.name
    ||JSON.stringify(result.outputPaths)!==JSON.stringify([prepared.path])
    ||result.macroObservation?.path!==prepared.path||result.macroObservation?.sha256!==prepared.expectedSha256
    ||macroPublicationDigest(result.macroObservation.record)!==macroPublicationDigest(prepared.record))throw Error('MACRO_RECEIPT_CONTRACT_MISMATCH');
}
