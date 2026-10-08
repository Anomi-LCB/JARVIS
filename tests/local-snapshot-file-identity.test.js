import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';import {join,dirname,basename,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {createLocalMissionSnapshotRecovery} from '../packages/core/src/mission/local-mission-snapshot-recovery.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
for(const mode of ['unchanged','empty','multiple-chunks','replace-after-open','replace-same-bytes','root-junction-before-open','replace-during-read','grow-during-read'])test('snapshot binds current published file: '+mode,()=>{
 const base=fs.mkdtempSync(join(tmpdir(),'jarvis-snapshot-identity-')),root=join(base,'workspace'),outside=join(base,'outside'),file=join(root,'report.txt'),original=mode==='empty'?'':mode==='multiple-chunks'?'x'.repeat(128*1024):'verified artifact';
 fs.mkdirSync(root);fs.mkdirSync(outside);fs.writeFileSync(file,original);fs.writeFileSync(join(outside,'report.txt'),original);
 const mission={missionId:'selected',observations:[{artifacts:[{rootIndex:0,relativePath:'report.txt',outsideAllowedRoots:false,pathHash:hash(file),contentSha256:hash(original)}]}]};
 const recovery=createLocalMissionSnapshotRecovery({store:{load:()=>[structuredClone(mission)]},allowedRoots:[root]});
 const nativeOpen=fs.openSync,nativeRead=fs.readFileSync,nativeReadChunk=fs.readSync;let fired=false,contentReads=0;
 try{
  fs.openSync=(path,...args)=>{
   if(path===file&&!fired&&['replace-after-open','replace-same-bytes','root-junction-before-open'].includes(mode)){
    fired=true;
    if(mode==='root-junction-before-open'){
     fs.renameSync(root,join(base,'old-workspace'));fs.symlinkSync(outside,root,process.platform==='win32'?'junction':'dir');
     return nativeOpen(path,...args);
    }
    const fd=nativeOpen(path,...args);fs.renameSync(file,join(root,'old-report.txt'));
    fs.writeFileSync(file,mode==='replace-same-bytes'?original:'wrong currently published result');return fd;
   }
   return nativeOpen(path,...args);
  };
  fs.readFileSync=(path,...args)=>{if(typeof path==='number')contentReads++;return nativeRead(path,...args);};
  fs.readSync=(...args)=>{
   contentReads++;const count=nativeReadChunk(...args);
   if(!fired&&['replace-during-read','grow-during-read'].includes(mode)){
    fired=true;
    if(mode==='replace-during-read'){fs.renameSync(file,join(root,'old-report.txt'));fs.writeFileSync(file,'different result');}
    else fs.appendFileSync(file,'oversize append');
   }
   return count;
  };
  syncBuiltinESMExports();
  const result=recovery({missionId:'selected'});
  const valid=['unchanged','empty','multiple-chunks'].includes(mode);
  assert.equal(result.verifiedArtifacts,valid?1:0,JSON.stringify({mode,result,contentReads}));
  assert.equal(result.automaticResume,false);assert.equal(result.evidenceOnly,true);
  if(!valid){assert.equal(fired,true);assert.deepEqual(result.missingArtifactIds,[hash(file)]);
   if(!mode.includes('during-read'))assert.equal(contentReads,0,'changed identity must be rejected before content read');}
 }finally{
  fs.openSync=nativeOpen;fs.readFileSync=nativeRead;fs.readSync=nativeReadChunk;syncBuiltinESMExports();
  assert.equal(dirname(resolve(base)),resolve(tmpdir()));assert.ok(basename(base).startsWith('jarvis-snapshot-identity-'));
  fs.rmSync(base,{recursive:true,force:true});
 }
});
