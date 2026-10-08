import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishVerifiedHwpStage} from '../apps/pc-agent/src/adapters/hwpx/hwp-publication.js';
const fixture=readFileSync('artifacts/weather-hwp-live/jarvis-weather-professional-table-verified.hwp');
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'jarvis-hwp-publish-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const stagePath=join(root,'jarvis-hwp-stage-fixture.hwp'),targetPath=join(root,'result.hwp');
 writeFileSync(targetPath,'user original');
 return {stagePath,targetPath,errorDetail:'',lastStep:'save-returned',structureVerification:{status:'verified'},backupExisting:path=>{const backup=join(root,'original.bak');renameSync(path,backup);return backup;}};
}
for(const [name,change] of [
 ['missing new stage',()=>{}],
 ['native failure after stage exists',state=>{writeFileSync(state.stagePath,fixture);state.errorDetail='save returned false';}],
 ['save never returned',state=>{writeFileSync(state.stagePath,fixture);state.lastStep='save-start';}],
 ['table structure mismatch',state=>{writeFileSync(state.stagePath,fixture);state.structureVerification={status:'mismatch'};}],
 ['missing structure receipt',state=>{writeFileSync(state.stagePath,fixture);state.structureVerification=null;}],
 ['invalid CFB header',state=>writeFileSync(state.stagePath,Buffer.alloc(1024))],
 ['truncated compound file',state=>writeFileSync(state.stagePath,Buffer.from('d0cf11e0a1b11ae1','hex'))]
])test(`HWP refuses ${name} and preserves existing user output`,t=>{
 const state=setup(t);change(state);let backups=0;const backup=state.backupExisting;state.backupExisting=path=>{backups++;return backup(path);};
 assert.throws(()=>publishVerifiedHwpStage(state));
 assert.equal(readFileSync(state.targetPath,'utf8'),'user original');assert.equal(backups,0);
});
test('verified native HWP stage publishes and preserves previous file in backup',t=>{
 const state=setup(t);writeFileSync(state.stagePath,fixture);
 const result=publishVerifiedHwpStage(state);assert.equal(result.published,true);
 assert.deepEqual(readFileSync(state.targetPath),fixture);assert.equal(readFileSync(result.backupPath,'utf8'),'user original');assert.equal(existsSync(state.stagePath),false);
});
test('new destination needs no backup and publishes only the native stage',t=>{
 const state=setup(t);rmSync(state.targetPath);writeFileSync(state.stagePath,fixture);
 state.backupExisting=()=>{throw Error('unexpected backup');};
 assert.equal(publishVerifiedHwpStage(state).published,true);assert.deepEqual(readFileSync(state.targetPath),fixture);
});
test('publication failure after moving original restores it, without inventing success',t=>{
 const state=setup(t);writeFileSync(state.stagePath,fixture);const backup=state.backupExisting;
 state.backupExisting=path=>{const saved=backup(path);rmSync(state.stagePath);return saved;};
 assert.throws(()=>publishVerifiedHwpStage(state));assert.equal(readFileSync(state.targetPath,'utf8'),'user original');
});
