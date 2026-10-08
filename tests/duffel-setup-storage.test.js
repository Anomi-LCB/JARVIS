import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,rmdirSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {planDuffelUserStorage,prepareDuffelUserStorage} from '../scripts/duffel-setup-storage.mjs';
import {createDuffelSetupController} from '../scripts/duffel-setup-controller.mjs';
import {saveDuffelTestCredential} from '../packages/core/src/personal-operations/duffel-credential-setup.js';
import {setFixturePrivateAcl} from './fixtures/windows-private-acl.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'jarvis-storage-한글 공백-'));
  const plan=planDuffelUserStorage({LOCALAPPDATA:root});
  t.after(()=>{
    // Only known test-owned leaves; never recursive deletion or path enumeration into another shell.
    if(existsSync(plan.directory)){for(const name of readdirSync(plan.directory))unlinkSync(join(plan.directory,name));rmdirSync(plan.directory);}
    for(const path of [dirname(plan.directory),dirname(dirname(plan.directory)),root])if(existsSync(path))rmdirSync(path);
  });
  return {root,plan};
}
test('planning and controller inspection never create storage; partial explicit paths are not mixed with defaults',()=>{
  assert.equal(planDuffelUserStorage({}),null);assert.equal(planDuffelUserStorage({LOCALAPPDATA:'relative'}),null);
  const env={LOCALAPPDATA:tmpdir(),JARVIS_DUFFEL_SETUP_ENABLED:'1'};
  assert.equal(createDuffelSetupController({env,platform:'win32'}).read().available,true);
  for(const extra of [{JARVIS_DUFFEL_SETUP_VAULT:'only-one'},{JARVIS_WINDOWS_SERVICE:'1'},{JARVIS_DUFFEL_SETUP_ENABLED:'0'}])
    assert.equal(createDuffelSetupController({env:{...env,...extra},platform:'win32'}).status().available,false);
});
test('Windows first setup creates private storage; reinitialization preserves real DPAPI ciphertext and metadata',{skip:process.platform!=='win32'},t=>{
  const {plan}=fixture(t);assert.equal(existsSync(plan.directory),false);
  assert.equal(prepareDuffelUserStorage(plan),plan);
  const saved=saveDuffelTestCredential({...plan,apiKey:'duffel_test_synthetic_storage_only',readConsent:true});
  const vault=readFileSync(plan.vaultPath),metadata=readFileSync(plan.metadataPath);
  assert.doesNotMatch(vault.toString(),/duffel_test_|apiKey/u);
  prepareDuffelUserStorage(plan);
  assert.deepEqual(readFileSync(plan.vaultPath),vault);assert.deepEqual(readFileSync(plan.metadataPath),metadata);
  assert.equal(saved.executionAuthorized,false);
  assert.throws(()=>prepareDuffelUserStorage({...plan,vaultPath:join(tmpdir(),'outside.json')}),/DIRECTORY_INVALID/u);
  console.log(JSON.stringify({observedAt:new Date().toISOString(),storage:'actual-Windows-DPAPI',reusedWithoutRewrite:true,provider:'not-called'}));
});
test('unmanaged existing directory is rejected without adopting or overwriting its files',{skip:process.platform!=='win32'},t=>{
  const {plan}=fixture(t);mkdirSync(plan.directory,{recursive:true});writeFileSync(plan.metadataPath,'existing-user-content');
  assert.throws(()=>prepareDuffelUserStorage(plan),/DIRECTORY_INVALID/u);
  assert.equal(readFileSync(plan.metadataPath,'utf8'),'existing-user-content');assert.equal(existsSync(join(plan.directory,'setup-owner.json')),false);
});
test('shared credential file ACL blocks setup even when private marker remains valid',{skip:process.platform!=='win32'},t=>{
  const {plan}=fixture(t);prepareDuffelUserStorage(plan);writeFileSync(plan.vaultPath,'synthetic-ciphertext');
  setFixturePrivateAcl(plan.vaultPath,true);
  assert.throws(()=>prepareDuffelUserStorage(plan),/DIRECTORY_INVALID/u);
  assert.equal(readFileSync(plan.vaultPath,'utf8'),'synthetic-ciphertext');
});
test('valid user click prepares default storage before launching fixed helper; invalid input does not',{skip:process.platform!=='win32'},t=>{
  const {root,plan}=fixture(t);let launch;
  const child=new EventEmitter();Object.assign(child,{pid:123456,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  const controller=createDuffelSetupController({env:{LOCALAPPDATA:root,JARVIS_DUFFEL_SETUP_ENABLED:'1'},spawnImpl:(...args)=>{launch=args;return child;}});
  assert.equal(controller.read().available,true);assert.equal(existsSync(plan.directory),false);
  assert.throws(()=>controller.start({apiKey:'do-not-send'},controller.read().nonce),/INPUT_INVALID/u);assert.equal(existsSync(plan.directory),false);
  controller.start({},controller.read().nonce);assert.equal(existsSync(plan.directory),true);
  assert.equal(launch[2].env.JARVIS_DUFFEL_SETUP_VAULT,plan.vaultPath);assert.equal(launch[2].env.JARVIS_DUFFEL_SETUP_METADATA,plan.metadataPath);
  child.exitCode=1;child.stderr.write('A_DUFFEL_SETUP_CANCELLED');child.emit('close',1);
  assert.equal(controller.status().state,'cancelled');assert.equal(existsSync(plan.vaultPath),false);
});
