import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {staticAppSourceFilter} from '../scripts/static-app-source-filter.mjs';
test('web console copy preserves Android source but excludes mutable build outputs and locks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'jarvis-static-filter-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=join(root,'apps'),output=join(root,'dist');
 for(const path of ['mobile/android/.gradle/8.13/checksums.lock','mobile/android/app/build/generated/BuildConfig.java','mobile/android/.jarvis-gradle-includes/plugin.gradle','mobile/android/app/src/main/AndroidManifest.xml','mobile/src/api/android-official-intents.js','pc-agent/src/device-observation.js']){
  await mkdir(join(input,path,'..'),{recursive:true});await writeFile(join(input,path),path);
 }
 await cp(input,output,{recursive:true,filter:staticAppSourceFilter});
 for(const path of ['mobile/android/.gradle/8.13/checksums.lock','mobile/android/app/build/generated/BuildConfig.java','mobile/android/.jarvis-gradle-includes/plugin.gradle'])await assert.rejects(access(join(output,path)),{code:'ENOENT'});
 for(const path of ['mobile/android/app/src/main/AndroidManifest.xml','mobile/src/api/android-official-intents.js','pc-agent/src/device-observation.js'])assert.equal(await readFile(join(output,path),'utf8'),path);
 assert.equal(staticAppSourceFilter('C:\\app\\android\\.gradle\\locked'),false);
 assert.equal(staticAppSourceFilter('apps/mobile/android/app/build.gradle'),true);
});
