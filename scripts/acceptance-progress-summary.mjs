import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/** Read-only view of the original ledger; never infers or promotes a gate. */
export async function readAcceptanceProgressSummary(workspaceRoot) {
 const source='docs/universal-control-v3-acceptance.json';
 let raw;
 try {raw=await readFile(join(workspaceRoot,source));}
 catch {return {status:'unavailable',source,independentValidation:false,reason:'ledger-not-readable'};}
 try {
  const ledger=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
  if(!Array.isArray(ledger.stages))throw Error();
  const gates=ledger.stages.flatMap(stage=>{if(!Array.isArray(stage.gates))throw Error();return stage.gates;});
  const expected=new Set(Array.from({length:100},(_,i)=>`V3-${String(i+1).padStart(3,'0')}`));
  const counts={verified:0,in_progress:0,pending:0};
  if(gates.length!==100)throw Error();
  for(const gate of gates){
   if(!expected.delete(gate.id)||!Object.hasOwn(counts,gate.status))throw Error();
   counts[gate.status]++;
  }
  if(expected.size)throw Error();
  return {status:'available',source,sourceSha256:createHash('sha256').update(raw).digest('hex'),total:100,counts,
   recordedAcceptancePercent:counts.verified,independentValidation:false,scope:'original-ledger-status-only'};
 }catch {return {status:'unavailable',source,independentValidation:false,reason:'ledger-structure-invalid'};}
}
