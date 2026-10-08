import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateTabularProcedureTrials, runTabularProcedure, validateTabularProcedureDefinition } from '../apps/growth-memory/src/skill-procedure-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-platform-g05-cross-material.json', import.meta.url), 'utf8'));

test('tabular procedure resolves renamed headers and matches expected grouped results on held-out data', () => {
  const result = evaluateTabularProcedureTrials(fixture.procedureDefinition, fixture.cases);
  assert.equal(result.success, true);
  assert.equal(result.status, 'passed');
  assert.equal(result.mode, 'cross-material-deterministic-procedure-trials-v1');
  assert.deepEqual(result.checks.map(item => item.status), ['passed', 'passed', 'passed']);
  assert.equal(result.cases[0].resolvedColumnSha256 === result.cases[1].resolvedColumnSha256, false);
  assert.ok(result.cases.every(item => item.status === 'passed' && /^[a-f0-9]{64}$/u.test(item.inputSha256)));
  const rendered = runTabularProcedure(fixture.procedureDefinition, fixture.cases[1].rows);
  assert.equal(rendered.success, true);
  assert.match(rendered.markdown, /\| Education \| 20 \| 2 \|/u);
  assert.equal(JSON.stringify(result).includes('Total KRW'), false, 'evaluation evidence must not retain input column names');
});

test('tabular procedure refuses unapproved renamed columns, ambiguous aliases, and unsafe keys', () => {
  const failed = evaluateTabularProcedureTrials(fixture.procedureDefinition, [fixture.cases[0], fixture.failureInjection]);
  assert.equal(failed.success, true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cases[1].status, 'failed');
  assert.equal(failed.cases[1].error, 'column-resolution-failed');
  assert.equal(validateTabularProcedureDefinition({ ...fixture.procedureDefinition,
    valueAliases: [...fixture.procedureDefinition.valueAliases, 'Team'] }).valid, false);
  assert.equal(runTabularProcedure(fixture.procedureDefinition, [{ Team: 'A', Amount: 1, Department: 'B' }]).success, false,
    'distinct physical headers matching one semantic role are ambiguous and must fail');
});

test('trial suites require distinct demonstration and holdout source data', () => {
  const repeated = fixture.cases.map(item => ({ ...item, sourceId: 'same-source' }));
  const result = evaluateTabularProcedureTrials(fixture.procedureDefinition, repeated);
  assert.equal(result.success, false);
  assert.equal(result.error, 'invalid-trial-suite');
  assert.equal(evaluateTabularProcedureTrials(fixture.procedureDefinition, [fixture.cases[0]]).success, false);
});
