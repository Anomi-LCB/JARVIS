import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve,relative} from 'node:path';import {createHash} from 'node:crypto';

const productionPath=resolve('apps/growth-memory/data/growth.sqlite');
const productionHash=()=>existsSync(productionPath)?createHash('sha256').update(readFileSync(productionPath)).digest('hex'):null;
test('real child-process default SQLite, exported reviews and backup paths stay in owned test root',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-default-memory-isolation-')),before=productionHash();
 try{
  const code=`import {SqliteMemoryStore} from './apps/growth-memory/src/db/sqlite-store.js';
   const s=new SqliteMemoryStore();s.saveReview({reviewId:'synthetic-default-isolation',generatedAt:'2026-10-06T00:00:00.000Z',period:'synthetic',summary:'SYNTHETIC_TEST_ONLY'});
   const b=s.backup({backupId:'synthetic-isolation'});console.log(JSON.stringify({db:s.dbPath,reviews:s.reviewDir,backups:s.backupDir,backup:b.filePath}));s.close();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:root}});
  assert.equal(child.status,0,child.stderr);const paths=JSON.parse(child.stdout.trim());
  for(const path of Object.values(paths)){assert.ok(!relative(root,path).startsWith('..'));assert.equal(existsSync(path),true);}
  assert.equal(productionHash(),before,'hash production DB without reading or replicating its records');
  const missing=spawnSync(process.execPath,['--input-type=module','-e',"import {SqliteMemoryStore} from './apps/growth-memory/src/db/sqlite-store.js';new SqliteMemoryStore();"],
   {encoding:'utf8',env:{...process.env,JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:''}});
  assert.notEqual(missing.status,0);assert.match(missing.stderr,/F_TEST_MEMORY_ROOT_REQUIRED/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('partial test store configuration cannot export synthetic reviews into production default folders',()=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-partial-memory-isolation-'));
 try{
  const code=`import {SqliteMemoryStore} from './apps/growth-memory/src/db/sqlite-store.js';
   const s=new SqliteMemoryStore({dbPath:process.argv[1]});console.log(JSON.stringify({reviews:s.reviewDir,backups:s.backupDir}));s.close();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,join(root,'explicit.sqlite')],
   {encoding:'utf8',env:{...process.env,JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:root}});
  assert.equal(child.status,0,child.stderr);for(const path of Object.values(JSON.parse(child.stdout.trim())))assert.ok(!relative(root,path).startsWith('..'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
