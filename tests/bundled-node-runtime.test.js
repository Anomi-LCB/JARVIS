import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readBundledNodeRuntime} from '../apps/pc-agent/src/install/bundled-node-runtime.js';
test('explicit pinned Windows runtime bundle preserves bytes/license and rejects changed digest or architecture',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-node-bundle-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const binary=Buffer.alloc(128);binary.write('MZ');binary.writeUInt32LE(64,60);binary.writeUInt32LE(0x4550,64);binary.writeUInt16LE(0x8664,68);
 const executablePath=join(root,'node.exe'),licensePath=join(root,'LICENSE');await writeFile(executablePath,binary);await writeFile(licensePath,'Node.js is licensed for use as follows:\nexternally maintained libraries\nSYNTHETIC CONTRACT INPUT');
 const input={executablePath,licensePath,version:'v24.8.0',expectedSha256:createHash('sha256').update(binary).digest('hex')};
 const bundle=readBundledNodeRuntime(input);assert.deepEqual(bundle.files['runtime/node.exe'],binary);assert.equal(JSON.parse(bundle.files['runtime/node-provenance.json']).releaseSignatureVerified,false);
 assert.throws(()=>readBundledNodeRuntime({...input,expectedSha256:'0'.repeat(64)}),/INTEGRITY_FAILED/);
 binary.writeUInt16LE(0x14c,68);await writeFile(executablePath,binary);assert.throws(()=>readBundledNodeRuntime({...input,expectedSha256:createHash('sha256').update(binary).digest('hex')}),/ARCHITECTURE_INVALID/);
 assert.deepEqual(readBundledNodeRuntime(null),{files:{},sha256:null});
});
