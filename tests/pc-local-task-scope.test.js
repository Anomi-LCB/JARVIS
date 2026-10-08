import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PcLocalTaskScope } from '../apps/pc-agent/src/pc-local-task-scope.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-local-scope-'));
  let time = 1000;
  const handles = [], open = () => { const scope = new PcLocalTaskScope({ dbPath: join(root,'scope.sqlite'), clock: () => time }); handles.push(scope); return scope; };
  t.after(() => { for (const scope of handles) { try { scope.close(); } catch {} } rmSync(root,{recursive:true,force:true}); });
  return {open, setTime: value => {time=value;}};
}

test('local scope starts denied, persists grants, and uses revision compare-and-swap across handles', t => {
  const {open}=fixture(t), a=open(), b=open();
  assert.deepEqual(a.snapshot(),{revision:0,allowedTaskIds:[],expiresAt:0,active:false});
  assert.throws(()=>a.capture('task'),/DENIED/u);
  const updated=a.replace({expectedRevision:0,allowedTaskIds:['한국어_업무','task'],expiresAt:2000});
  assert.equal(updated.revision,1);
  assert.equal(b.snapshot().revision,1);
  assert.throws(()=>b.replace({expectedRevision:0,allowedTaskIds:['other'],expiresAt:2000}),/REVISION_CONFLICT/u);
  const lease=a.capture('task');a.assertCurrent('task',lease);
  assert.throws(()=>a.assertCurrent('task',{...lease}),/LEASE_INVALID/u);
  assert.throws(()=>b.assertCurrent('task',lease),/LEASE_INVALID/u);
  assert.throws(()=>a.assertCurrent('한국어_업무',lease),/LEASE_INVALID/u);
  b.replace({expectedRevision:1,allowedTaskIds:[],expiresAt:0});
  assert.throws(()=>a.assertCurrent('task',lease),/CHANGED/u);
  assert.equal(open().snapshot().active,false);
});

test('expiry survives restart and clock rollback, including rejected permission changes',t=>{
  const {open,setTime}=fixture(t), a=open();
  a.replace({expectedRevision:0,allowedTaskIds:['task'],expiresAt:2000});
  const lease=a.capture('task');setTime(2000);
  assert.throws(()=>a.assertCurrent('task',lease),/EXPIRED/u);
  assert.throws(()=>a.replace({expectedRevision:0,allowedTaskIds:['other'],expiresAt:3000}),/REVISION_CONFLICT/u);
  a.close();setTime(1000);const b=open();
  assert.equal(b.snapshot().active,false);assert.throws(()=>b.capture('task'),/EXPIRED/u);
  assert.throws(()=>b.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:2000}),/EXPIRY_INVALID/u);
});

test('even a same-task grant revision fences an older captured command',t=>{
  const {open}=fixture(t), scope=open();
  scope.replace({expectedRevision:0,allowedTaskIds:['task'],expiresAt:2000});
  const lease=scope.capture('task');
  scope.replace({expectedRevision:1,allowedTaskIds:['task'],expiresAt:3000});
  assert.throws(()=>scope.assertCurrent('task',lease),/CHANGED/u);
  scope.assertCurrent('task',scope.capture('task'));
});

test('invalid local scope input never enables a task',t=>{
  const {open,setTime}=fixture(t), scope=open();
  for(const allowedTaskIds of [['task','task'],['bad/id'],[null],Array.from({length:1001},(_,i)=>`t${i}`)])
    assert.throws(()=>scope.replace({expectedRevision:0,allowedTaskIds,expiresAt:2000}),/INPUT_INVALID/u);
  assert.throws(()=>scope.replace({expectedRevision:-1,allowedTaskIds:['task'],expiresAt:2000}),/INPUT_INVALID/u);
  assert.equal(scope.snapshot().revision,0);setTime(NaN);
  assert.throws(()=>scope.capture('task'),/CLOCK_INVALID/u);
});
