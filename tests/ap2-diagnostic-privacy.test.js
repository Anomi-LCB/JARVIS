import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const python=resolve('artifacts/ap2-runtime-20261006/Scripts/python.exe'),sdk=resolve('artifacts/ap2-sdk-20261006/code/sdk/python');
const diagnostic=resolve(sdk,'../.logs/mandate_operations.log');
const fingerprint=()=>existsSync(diagnostic)?createHash('sha256').update(readFileSync(diagnostic)).digest('hex'):null;
test('normal logging disable still writes AP2 tokens; production and fixture null sinks stop that file effect',
 {skip:existsSync(python)&&existsSync(sdk)?false:'Pinned AP2 runtime absent; SDK diagnostic behavior unobserved'},()=>{
  const before=fingerprint();
  const result=spawnSync(python,['-I',resolve('tests/fixtures/ap2-diagnostic-privacy.py'),sdk,
    resolve('packages/core/src/personal-operations/ap2-sdk-verifier.py'),resolve('tests/fixtures/ap2-transaction-evidence.py')],
    {encoding:'utf8',windowsHide:true,maxBuffer:65536});
  assert.equal(result.status,0,'Isolated privacy probe failed');
  const observed=JSON.parse(result.stdout);
  assert.deepEqual(observed.before,{loggingDisabled:true,diagnosticFileCreated:true,presentationRecorded:true});
  assert.deepEqual(observed.after,{sinkIsOsNull:true,diagnosticUnchanged:true,fixtureDiagnosticUnchanged:true});
  assert.equal(fingerprint(),before);
  console.log(JSON.stringify({ap2DiagnosticPrivacy:observed,syntheticOnly:true,productionSdkDiagnosticChanged:false}));
 });
