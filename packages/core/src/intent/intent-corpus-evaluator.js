import { IntentParser } from './intent-parser.js';
import { LocalSemanticIntentAdapter } from './semantic-intent-adapter.js';

const defaultThresholds = Object.freeze({
  intentAccuracy: 0.9,
  slotAccuracy: 0.82,
  entityAccuracy: 0.85,
  complexityAccuracy: 0.8,
  combinedAccuracy: 0.86
});

export function evaluateIntentCorpus(corpus, {
  parser = new IntentParser(),
  thresholds = defaultThresholds,
  createdAt = '2026-06-18T00:00:00.000Z'
} = {}) {
  const fixtures = Array.isArray(corpus) ? corpus : corpus?.fixtures ?? [];
  const effectiveThresholds = { ...defaultThresholds, ...(corpus?.thresholds ?? {}), ...thresholds };
  const totals = {
    intent: { passed: 0, total: 0 },
    slots: { passed: 0, total: 0 },
    entities: { passed: 0, total: 0 },
    complexity: { passed: 0, total: 0 }
  };
  const results = fixtures.map((fixture) => {
    const parsed = parser.parse(fixture.command, {
      requestId: fixture.id,
      createdAt
    });
    const expected = fixture.expected ?? {};
    const intentPass = !expected.actionType || parsed.actionType === expected.actionType;
    if (expected.actionType) {
      totals.intent.total += 1;
      if (intentPass) totals.intent.passed += 1;
    }

    const slotChecks = compareRecord(parsed.slots ?? {}, expected.slots ?? {});
    const entityChecks = compareRecord(parsed.entities ?? {}, expected.entities ?? {});
    const complexityChecks = compareRecord(parsed.complexity ?? {}, expected.complexity ?? {});
    addChecks(totals.slots, slotChecks);
    addChecks(totals.entities, entityChecks);
    addChecks(totals.complexity, complexityChecks);

    return {
      id: fixture.id,
      command: fixture.command,
      expected,
      parsed,
      passed: intentPass && slotChecks.every((check) => check.passed) && entityChecks.every((check) => check.passed) && complexityChecks.every((check) => check.passed),
      checks: {
        intent: { passed: intentPass, expected: expected.actionType, actual: parsed.actionType },
        slots: slotChecks,
        entities: entityChecks,
        complexity: complexityChecks
      }
    };
  });

  const metrics = {
    intentAccuracy: ratio(totals.intent),
    slotAccuracy: ratio(totals.slots),
    entityAccuracy: ratio(totals.entities),
    complexityAccuracy: ratio(totals.complexity)
  };
  metrics.combinedAccuracy = round((metrics.intentAccuracy + metrics.slotAccuracy + metrics.entityAccuracy + metrics.complexityAccuracy) / 4);
  const passed = Object.entries(effectiveThresholds).every(([metric, threshold]) => metrics[metric] >= threshold);

  return {
    version: corpus?.version ?? 'intent-corpus-evaluation-v1',
    fixtureCount: fixtures.length,
    thresholds: effectiveThresholds,
    metrics,
    passed,
    failures: results.filter((result) => !result.passed).map(compactFailure),
    byActionType: summarizeByAction(results),
    results
  };
}

export function assertIntentCorpusReadiness(corpus, options = {}) {
  const report = evaluateIntentCorpus(corpus, options);
  if (!report.passed) {
    const failures = report.failures.slice(0, 5).map((failure) => `${failure.id}: ${failure.reasons.join(', ')}`).join('; ');
    throw new Error(`Intent corpus readiness failed: ${failures}`);
  }
  return report;
}

export function evaluateIntentCorpusWithSemantic(corpus, {
  ruleParser = new IntentParser(),
  semanticAdapter = new LocalSemanticIntentAdapter({ parser: ruleParser }),
  createdAt = '2026-06-18T00:00:00.000Z',
  ruleThresholds = defaultThresholds,
  semanticThresholds = {
    ...defaultThresholds,
    intentAccuracy: 0.88,
    slotAccuracy: 0.82,
    combinedAccuracy: 0.84
  },
  agreementThreshold = 0.82
} = {}) {
  const ruleReport = evaluateIntentCorpus(corpus, {
    parser: ruleParser,
    thresholds: ruleThresholds,
    createdAt
  });
  const semanticReport = evaluateIntentCorpus(corpus, {
    parser: semanticAdapter,
    thresholds: semanticThresholds,
    createdAt
  });
  const fixtures = Array.isArray(corpus) ? corpus : corpus?.fixtures ?? [];
  const comparisons = fixtures.map((fixture) => {
    const ruleParsed = ruleParser.parse(fixture.command, { requestId: `${fixture.id}:rule`, createdAt });
    const semanticParsed = semanticAdapter.parse(fixture.command, { requestId: `${fixture.id}:semantic`, createdAt });
    return {
      id: fixture.id,
      command: fixture.command,
      expectedActionType: fixture.expected?.actionType ?? null,
      ruleActionType: ruleParsed.actionType,
      semanticActionType: semanticParsed.actionType,
      agreed: ruleParsed.actionType === semanticParsed.actionType,
      semanticConfidence: semanticParsed.confidence,
      semanticProfileId: semanticParsed.semantic?.profileId ?? null,
      semanticMatchedPrototype: semanticParsed.semantic?.matchedPrototype ?? null,
      ruleReasons: ruleParsed.reasons ?? [],
      semanticReasons: semanticParsed.reasons ?? []
    };
  });
  const agreement = ratio({
    passed: comparisons.filter((item) => item.agreed).length,
    total: comparisons.length
  });
  const disagreements = comparisons.filter((item) => !item.agreed);
  const actionComparison = summarizeActionComparison(comparisons);
  return {
    version: 'intent-corpus-semantic-comparison-v1',
    fixtureCount: fixtures.length,
    ruleReport,
    semanticReport,
    agreementThreshold,
    agreement,
    passed: ruleReport.passed && semanticReport.passed && agreement >= agreementThreshold,
    disagreements,
    actionComparison,
    comparisons
  };
}

function compareRecord(actual, expected) {
  return Object.entries(expected).map(([key, expectedValue]) => {
    const actualValue = actual[key];
    return {
      key,
      expected: expectedValue,
      actual: actualValue,
      passed: matchesExpected(actualValue, expectedValue)
    };
  });
}

function summarizeActionComparison(comparisons) {
  const summary = new Map();
  for (const item of comparisons) {
    const key = item.expectedActionType ?? 'UNSPECIFIED';
    const current = summary.get(key) ?? { actionType: key, total: 0, agreed: 0, semanticCorrect: 0 };
    current.total += 1;
    if (item.agreed) current.agreed += 1;
    if (item.semanticActionType === item.expectedActionType) current.semanticCorrect += 1;
    summary.set(key, current);
  }
  return [...summary.values()].map((item) => ({
    ...item,
    agreementRate: round(item.agreed / item.total),
    semanticAccuracy: round(item.semanticCorrect / item.total)
  }));
}

function matchesExpected(actual, expected) {
  if (Array.isArray(expected)) return expected.includes(actual);
  if (expected && typeof expected === 'object') {
    if (expected.includes) return String(actual ?? '').includes(expected.includes);
    if (expected.oneOf) return expected.oneOf.includes(actual);
    if (expected.present) return actual !== undefined && actual !== null && actual !== '';
  }
  return Object.is(actual, expected);
}

function addChecks(total, checks) {
  total.total += checks.length;
  total.passed += checks.filter((check) => check.passed).length;
}

function ratio(total) {
  if (!total.total) return 1;
  return round(total.passed / total.total);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function compactFailure(result) {
  const reasons = [];
  if (!result.checks.intent.passed) {
    reasons.push(`intent expected ${result.checks.intent.expected} got ${result.checks.intent.actual}`);
  }
  for (const group of ['slots', 'entities', 'complexity']) {
    for (const check of result.checks[group]) {
      if (!check.passed) reasons.push(`${group}.${check.key} expected ${JSON.stringify(check.expected)} got ${JSON.stringify(check.actual)}`);
    }
  }
  return { id: result.id, command: result.command, reasons };
}

function summarizeByAction(results) {
  const summary = new Map();
  for (const result of results) {
    const actionType = result.expected.actionType ?? 'UNSPECIFIED';
    const current = summary.get(actionType) ?? { actionType, total: 0, passed: 0 };
    current.total += 1;
    if (result.passed) current.passed += 1;
    summary.set(actionType, current);
  }
  return [...summary.values()].map((item) => ({ ...item, passRate: round(item.passed / item.total) }));
}
