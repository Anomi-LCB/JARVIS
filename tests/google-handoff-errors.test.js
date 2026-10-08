import test from 'node:test';
import assert from 'node:assert/strict';
import {googleHandoffFailureCode,GOOGLE_HANDOFF_FAILURE_CODES} from '../packages/core/src/personal-operations/google-handoff-errors.js';

test('handoff response maps only restart and expiry conditions to safe reconnect codes',async()=>{
  assert.equal(await googleHandoffFailureCode(new Response(JSON.stringify({error:{code:'A_INTEGRATION_HANDOFF_EXPIRED'}}),{status:410})), 'A_GOOGLE_HANDOFF_EXPIRED');
  assert.equal(await googleHandoffFailureCode(new Response(JSON.stringify({error:{code:'A_INTEGRATION_HANDOFF_NOT_FOUND'}}),{status:404})), 'A_GOOGLE_HANDOFF_RESTARTED');
  assert.equal(await googleHandoffFailureCode(new Response(JSON.stringify({error:{code:'A_INTEGRATION_CREDENTIAL_SAVE_FAILED',secret:'private'}}),{status:409})), 'A_GOOGLE_HANDOFF_REJECTED');
  assert.equal(await googleHandoffFailureCode(new Response('invalid',{status:502})), 'A_GOOGLE_HANDOFF_REJECTED');
  assert.equal(await googleHandoffFailureCode(new Response('{}',{status:202})), null);
  assert.deepEqual([...GOOGLE_HANDOFF_FAILURE_CODES].sort(),['A_GOOGLE_HANDOFF_EXPIRED','A_GOOGLE_HANDOFF_REJECTED','A_GOOGLE_HANDOFF_RESTARTED']);
});
