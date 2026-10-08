import test from 'node:test';
import assert from 'node:assert/strict';
import { minimizeExternalText } from '../packages/core/src/mission/mission-planner.js';
import {evaluateMissionDataPurpose} from '../packages/core/src/security/data-purpose-policy.js';

const classification = (extra = {}) => ({ dataClass: 'D0', ministryDataClass: 'M0', classifierVersion: 'synthetic-v1', matchedRules: [], ner: { entities: [] }, ...extra });
for (const [label, result, kind, purpose] of [
  ['unrecognized purpose', classification(), 'USER_REQUEST', 'model-training'],
  ['unknown content kind', classification(), 'UNKNOWN_CONTENT', 'mission-planning'],
  ['personal context used as tool evidence', classification(), 'USER_CONTEXT', 'mission-tool-evidence'],
  ['financial category with inconsistent low rank', classification({ sensitiveFlags: ['financial'] }), 'LOCAL_FILE_CONTENT', 'mission-planning'],
  ['health category with inconsistent low rank', classification({ sensitiveFlags: ['health'] }), 'LOCAL_FILE_CONTENT', 'mission-planning']
]) {
  test(`external minimization withholds ${label}`, () => {
    const redactions = [];
    const output = minimizeExternalText('synthetic private narrative', { classify: () => result }, 'fixture', redactions, kind, { purpose });
    assert.equal(output.includes('synthetic private narrative'), false);
    assert.equal(redactions.length, 1);
  });
}

test('approved public planning and tool evidence keep useful text', () => {
  for (const [kind, purpose] of [['USER_REQUEST', 'mission-planning'], ['USER_CONTEXT', 'mission-planning'], ['LOCAL_FILE_CONTENT', 'mission-tool-evidence']]) {
    const redactions = [];
    assert.equal(minimizeExternalText('공개 연구 자료', { classify: () => classification() }, 'fixture', redactions, kind, { purpose }), '공개 연구 자료');
    assert.equal(redactions.length, 0);
  }
});

test('the full D/M rank matrix keeps higher categories local and never grants execution', () => {
  for(let d=0;d<=4;d++)for(let m=0;m<=4;m++){
    const decision=evaluateMissionDataPurpose({purpose:'mission-planning',contentKind:'USER_REQUEST',classification:classification({dataClass:`D${d}`,ministryDataClass:`M${m}`})});
    assert.equal(decision.action,Math.max(d,m)>=3?'withhold':Math.max(d,m)===2?'mask':'retain');
    assert.equal(decision.executionAuthorized,false);
  }
});

test('unknown categories stay local and unknown purpose text is absent from diagnostics', () => {
  const redactions=[];
  const classifier={classify:()=>classification({sensitiveFlags:['unreviewed-category']})};
  assert.equal(minimizeExternalText('synthetic private text',classifier,'fixture',redactions).includes('synthetic private text'),false);
  const diagnostics=[];
  minimizeExternalText('public',classifier,'fixture',diagnostics,'USER_REQUEST',{purpose:'unknown-purpose-with-private-value'});
  assert.equal(JSON.stringify(diagnostics).includes('private-value'),false);
});
