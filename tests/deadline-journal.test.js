import test from 'node:test';import assert from 'node:assert/strict';import {createDeadlineJournal} from '../src/ui/workspace/deadline-journal.js';
test('deadline journal persists only a bounded request ID and tolerates unavailable storage',()=>{
 const entries=new Map(),storage={getItem:k=>entries.get(k),setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
 const journal=createDeadlineJournal(storage);journal.save('deadline_test-123');assert.equal(createDeadlineJournal(storage).read(),'deadline_test-123');assert.deepEqual([...entries.values()],['deadline_test-123']);
 assert.throws(()=>journal.save('private deadline title'));journal.clear();assert.equal(journal.read(),null);
 entries.set('jarvis.workspace.deadline-change','<script>');assert.equal(journal.read(),null);
 const broken=createDeadlineJournal({getItem(){throw Error();},setItem(){throw Error();},removeItem(){throw Error();}});assert.equal(broken.read(),null);broken.save('deadline_valid');broken.clear();
});
