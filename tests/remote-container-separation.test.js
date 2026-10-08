import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const exec=promisify(execFile);
// This host-side test opts into Docker. It never provisions cloud resources.
// The literal fixture URL also includes the role in the fixed validation bundle.
const roleFixture=new URL('./fixtures/remote-container-role.mjs',import.meta.url);
const image=process.env.JARVIS_SEPARATION_IMAGE;
for(const scenario of ['normal','wrong-facts','revoke-between'])test(`independent Core and PC container filesystems: ${scenario}`,
  {skip:process.env.JARVIS_CROSS_CONTAINER_TEST!=='1',timeout:60000},async t=>{
    assert.ok(image&&/^[a-z0-9][a-z0-9./:_-]+$/u.test(image));assert.ok(roleFixture.pathname);
    const tag=`jarvis-separation-${randomUUID()}`,children=[];
    t.after(async()=>{
      for(const item of children){
        // Only exact UUID names created in this test; never enumerate/remove other containers.
        try{await exec('docker',['rm','-f',item.name],{windowsHide:true});}catch{}
        item.process.stdin.destroy();item.process.kill();
      }
    });
    function launch(role,network,mode,endpoint,scope=''){
      const name=`${tag}-${role}`;
      const args=['run','--rm','-i','--name',name,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','64','--memory','1g','--cpus','1','--user',role==='b'?'2002:2002':'1000:1000',
        '--tmpfs','/tmp:rw,nosuid,nodev,size=256m',image,'node','tests/fixtures/remote-container-role.mjs',role,mode,endpoint,scope];
      const process=spawn('docker',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
      children.push({name,process});let stderr='';process.stderr.on('data',chunk=>stderr+=chunk);
      const queue=[],waiters=[];let terminal=null;
      createInterface({input:process.stdout}).on('line',line=>{
        let value;try{value=JSON.parse(line);}catch{return;}
        waiters.length?waiters.shift().resolve(value):queue.push(value);
      });
      process.on('error',error=>{terminal=error;while(waiters.length)waiters.shift().reject(error);});
      process.on('exit',code=>{terminal=new Error(`container ${role} exit ${code}: ${stderr}`);while(waiters.length)waiters.shift().reject(terminal);});
      return {name,send:value=>process.stdin.write(JSON.stringify(value)+'\n'),next:async()=>{
        const value=queue.length?queue.shift():await new Promise((resolve,reject)=>{
          if(terminal)return reject(terminal);
          const timer=setTimeout(()=>reject(new Error(`container ${role} observation timeout: ${stderr}`)),15000);
          waiters.push({resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
        });
        if(value.type==='error')throw new Error(value.message);return value;
      }};
    }
    const pc=launch('b','none','normal','17776'),pcReady=await pc.next();assert.equal(pcReady.type,'ready');
    const core=launch('core',`container:${pc.name}`,`artifact-pc-observer-os-boundary-four-files${scenario==='normal'?'':`-${scenario}`}`,'http://127.0.0.1:17776',pcReady.rootScopeSha256);
    const coreReady=await core.next();assert.equal(coreReady.type,'ready');
    assert.equal(pcReady.uid,2002);assert.equal(coreReady.uid,1000);assert.equal(pcReady.capabilities,'0000000000000000');assert.equal(coreReady.capabilities,'0000000000000000');
    assert.notEqual(coreReady.mountNamespace,pcReady.mountNamespace,'independent mount namespaces');
    assert.equal(coreReady.networkNamespace,pcReady.networkNamespace,'only isolated loopback network is shared');
    core.send('run');let done;
    while(!done){const message=await core.next();if(message.type==='pc-observer-config')pc.send({...message,type:'observe-artifact'});else if(message.type==='result')done=message;}
    assert.equal(done.coreDirectRead,'ENOENT','PC file is absent in Core filesystem');
    assert.equal(done.coreCapabilities,'0000000000000000');assert.equal(done.coreUid,1000);
    assert.equal(done.result.goalContract.requirements.length,4);assert.equal(done.allGrowthCount,4);assert.equal(done.allWorkCount,4);assert.equal(done.pendingFollowups,0);
    if(scenario==='normal')assert.equal(done.result.status,'COMPLETED');
    else{assert.notEqual(done.result.status,'COMPLETED');assert.ok(done.result.verificationSummary.criteria[0].reasons.includes(scenario==='wrong-facts'?'criterion-artifact-facts-or-provenance-mismatch':'remote-consistency-current-observation-unavailable'));}
    pc.send({type:'probe'});const probe=await pc.next();assert.equal(probe.type,'probe');assert.equal(probe.calls.length,4);
    assert.ok(probe.reads.every(item=>item.pid===pcReady.pid));assert.equal(new Set(probe.reads.map(item=>item.taskId)).size,4);
    assert.equal(probe.contents.source.facts.total,42);assert.equal(probe.contents.card.facts.total,scenario==='wrong-facts'?99:42);
    console.log(JSON.stringify({scenario,mountNamespaces:{pc:pcReady.mountNamespace,core:coreReady.mountNamespace},networkShared:true,
      directRead:done.coreDirectRead,status:done.result.status,adapterCalls:probe.calls.length,growth:done.allGrowthCount,work:done.allWorkCount,criteria:done.result.verificationSummary}));
  });
