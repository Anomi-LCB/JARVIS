import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {renderInstallFolderSelector} from '../apps/pc-agent/src/install/install-folder-selector.js';
const run=promisify(execFile),releaseId='b'.repeat(64);
test('embedded folder selector reserves concurrent fresh folders and keeps damaged/partial old releases unchanged',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jarvis-folder-reserve-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const script=join(dir,'select-install-folder.ps1'),base=join(dir,'releases');await writeFile(script,'\uFEFF'+renderInstallFolderSelector());
 const select=()=>run('powershell.exe',['-NoProfile','-File',script,'-BaseRoot',base,'-ReleaseId',releaseId],{windowsHide:true});
 const first=(await select()).stdout;assert.equal(first,join(base,releaseId));assert.equal(first,first.trim());
 await writeFile(join(first,'package-manifest.json'),'SYNTHETIC DAMAGED MANIFEST');await writeFile(join(first,'user-owned-marker'),'DO NOT OVERWRITE');
 const results=await Promise.all(Array.from({length:4},select));
 const folders=results.map(r=>r.stdout);assert.equal(new Set(folders).size,4);
 for(const folder of folders){
  const sub=relative(base,folder);assert.ok(!sub.startsWith('..')&&!isAbsolute(sub));assert.ok(sub.startsWith(releaseId+'-repair-'));
  assert.equal((await readFile(join(folder,'.install-reservation'),'utf8')).split(/\r?\n/)[0],releaseId);
 }
 assert.equal(await readFile(join(first,'package-manifest.json'),'utf8'),'SYNTHETIC DAMAGED MANIFEST');assert.equal(await readFile(join(first,'user-owned-marker'),'utf8'),'DO NOT OVERWRITE');
 // An interrupted reservation remains untouched; repeating installation selects another folder.
 const again=(await select()).stdout;assert.ok(!folders.includes(again)&&again!==first);assert.equal((await readdir(base)).length,6);
 const invalid=await run('powershell.exe',['-NoProfile','-File',script,'-BaseRoot',join(dir,'invalid-root'),'-ReleaseId','../invalid'],{windowsHide:true}).then(()=>null,e=>e);
 assert.ok(invalid);await assert.rejects(readdir(join(dir,'invalid-root')),{code:'ENOENT'});
 console.log(JSON.stringify({folderReservationEvidence:{actualWindowsPowerShell:true,concurrentRequests:4,distinctReservations:6,damagedOldCodeUnchanged:true,partialFoldersNotDeleted:true,invalidInputNoFiles:true}}));
});
