// Linux isolation experiment only. Synthetic values; privileged setup never ships as a service.
import { mkdtempSync, mkdirSync, writeFileSync, chownSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readPrivateFile } from '../../packages/core/src/personal-operations/private-file.js';
if(process.argv[2]==='probe'){
  const paths=JSON.parse(process.argv[3]),results=[];
  for(const [name,path] of Object.entries(paths)){
    let rawReadable=false,guardedReadable=false,code=null;
    try{rawReadable=readFileSync(path).length>0;}catch(error){code=error.code;}
    try{guardedReadable=readPrivateFile(path).length>0;}catch{}
    results.push({name,rawReadable,guardedReadable,code});
  }
  const proc=readFileSync('/proc/self/status','utf8');
  process.stdout.write(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),capEff:proc.match(/^CapEff:\s*(\w+)/m)?.[1],noNewPrivs:proc.match(/^NoNewPrivs:\s*(\d+)/m)?.[1],results}));
}else{
  assert.equal(process.platform,'linux');assert.equal(process.geteuid(),0);
  const root=mkdtempSync(join(tmpdir(),'jarvis-role-isolation-')),paths={},rows=[];
  const startedAt=new Date().toISOString();chmodSync(root,0o711);
  try{
    for(const [role,uid] of [['broker',2000],['core',2001],['worker',2002]]){
      const dir=join(root,role);mkdirSync(dir,{mode:0o700});
      const path=join(dir,'private-key');writeFileSync(path,`synthetic-${role}`,{mode:0o600});chownSync(path,uid,uid);paths[role]=path;
      if(role==='broker'){const token=join(dir,'openbao-token');writeFileSync(token,'synthetic-reader-token',{mode:0o600});chownSync(token,uid,uid);paths.openbao=token;}
      chownSync(dir,uid,uid);
    }
    for(const [role,uid] of [['broker',2000],['core',2001],['worker',2002]]){
      const row=JSON.parse(execFileSync(process.execPath,[new URL(import.meta.url).pathname,'probe',JSON.stringify(paths)],{uid,gid:uid,env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000}));
      assert.equal(row.uid,uid);assert.equal(row.capEff,'0000000000000000');assert.equal(row.noNewPrivs,'1');
      for(const item of row.results){const allowed=item.name===role||(role==='broker'&&item.name==='openbao');assert.equal(item.rawReadable,allowed);assert.equal(item.guardedReadable,allowed);if(!allowed)assert.equal(item.code,'EACCES');}
      rows.push({role,...row});
    }
    process.stdout.write(JSON.stringify({schemaVersion:1,status:'passed',startedAt,observedAt:new Date().toISOString(),syntheticOnly:true,productionActivation:false,checks:12,rows})+'\n');
  }finally{
    // Setup has CHOWN, not DAC_OVERRIDE. Reclaim only the synthetic directories it created.
    for(const role of ['broker','core','worker']){const dir=join(root,role);if(existsSync(dir)){chownSync(dir,0,0);chmodSync(dir,0o700);}}
    rmSync(root,{recursive:true,force:true});
  }
}
