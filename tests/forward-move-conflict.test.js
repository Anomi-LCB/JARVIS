import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileMoveToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'jarvis-forward-conflict-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const journal=new UndoJournal({journalPath:join(root,'undo.jsonl')});return{root,journal,adapter:new FileMoveToolAdapter({allowedRoots:[root],undoJournal:journal})};}
for(const action of ['move','copy'])test(`late destination is preserved for ${action}`,async t=>{
 const {root,adapter}=fixture(t),from=join(root,'source.txt'),to=join(root,'target.txt');writeFileSync(from,'original');
 const result=await adapter.execute({moves:[{from,to}],conflictResolutions:[{from,to,action}]},{taskId:'late'},
  {beforeMoves:async()=>{writeFileSync(to,'user created');return()=>{};}});
 assert.equal(readFileSync(to,'utf8'),'user created');assert.equal(readFileSync(from,'utf8'),'original');
 assert.equal(result.status,'failed');assert.deepEqual(result.changedItems,[]);assert.deepEqual(result.outputPaths,[]);
});
test('batch fence failure preserves and reports the first completed move',async t=>{
 const {root,adapter,journal}=fixture(t),from=join(root,'one.txt'),to=join(root,'moved.txt'),from2=join(root,'two.txt'),to2=join(root,'other.txt');
 writeFileSync(from,'one');writeFileSync(from2,'two');
 const result=await adapter.execute({moves:[{from,to},{from:from2,to:to2}]},{taskId:'partial'},
  {beforeMoves:async()=>()=>{if(existsSync(to))throw Error('revoked');}});
 assert.equal(result.status,'failed');assert.equal(result.uncertain,true);assert.deepEqual(result.outputPaths,[to]);assert.equal(result.changedItems.length,1);
 assert.equal(existsSync(from),false);assert.equal(readFileSync(to,'utf8'),'one');assert.equal(readFileSync(from2,'utf8'),'two');assert.equal(existsSync(to2),false);
 assert.equal(journal.list().length,1);
 assert.equal(new UndoJournal({journalPath:join(root,'undo.jsonl')}).list().length,1);
});
test('normal file copy and directory move retain supported behavior',async t=>{
 const {root,adapter}=fixture(t),from=join(root,'source.txt'),to=join(root,'copy.txt');writeFileSync(from,'original');
 const copied=await adapter.execute({moves:[{from,to}],conflictResolutions:[{from,to,action:'copy'}]},{taskId:'copy'});
 assert.equal(copied.status,'success');assert.equal(readFileSync(from,'utf8'),'original');assert.equal(readFileSync(to,'utf8'),'original');
 const dir=join(root,'old-dir'),dest=join(root,'new-dir');mkdirSync(dir);writeFileSync(join(dir,'inside.txt'),'nested');
 const moved=await adapter.execute({moves:[{from:dir,to:dest}]},{taskId:'dir'});
 assert.equal(moved.status,'success');assert.equal(existsSync(dir),false);assert.equal(readFileSync(join(dest,'inside.txt'),'utf8'),'nested');
});
test('late directory destination is not merged or replaced',async t=>{
 const {root,adapter}=fixture(t),from=join(root,"old ' directory"),to=join(root,"new ' directory");mkdirSync(from);writeFileSync(join(from,'one.txt'),'original');
 const result=await adapter.execute({moves:[{from,to}]},{taskId:'late-dir'},{beforeMoves:async()=>{mkdirSync(to);writeFileSync(join(to,'two.txt'),'user');return()=>{};}});
 assert.equal(result.status,'failed');assert.equal(readFileSync(join(from,'one.txt'),'utf8'),'original');assert.equal(readFileSync(join(to,'two.txt'),'utf8'),'user');
});
test('conflict resolution cannot redirect a copy outside allowed roots',async t=>{
 const {root,adapter}=fixture(t),outside=mkdtempSync(join(tmpdir(),'jarvis-forward-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 const from=join(root,'from.txt'),to=join(root,'exists.txt'),other=join(outside,'copy.txt');writeFileSync(from,'original');writeFileSync(to,'existing');
 const result=await adapter.execute({moves:[{from,to}],conflictResolutions:[{from,to,action:'copy',targetPath:other}]},{taskId:'outside'});
 assert.equal(result.status,'failed');assert.equal(existsSync(other),false);assert.equal(readFileSync(from,'utf8'),'original');
});
test('changed parent junction is blocked before creating outside directories',async t=>{
 const {root,adapter}=fixture(t),outside=mkdtempSync(join(tmpdir(),'jarvis-forward-junction-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
 const from=join(root,'from.txt'),parent=join(root,'parent'),to=join(parent,'new-sub/target.txt');writeFileSync(from,'original');mkdirSync(parent);
 const result=await adapter.execute({moves:[{from,to}]},{taskId:'junction'},{beforeMoves:async()=>{renameSync(parent,join(root,'held'));symlinkSync(outside,parent,'junction');return()=>{};}});
 assert.equal(result.status,'failed');assert.equal(existsSync(join(outside,'new-sub')),false);assert.equal(readFileSync(from,'utf8'),'original');
});
