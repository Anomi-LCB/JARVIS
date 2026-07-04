import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function runGoldenShadowCorpus({ registry, corpus, root, variables = {} }) {
  const context = {
    root: resolve(root),
    ...variables
  };
  const fixtures = Array.isArray(corpus) ? corpus : corpus.fixtures ?? [];
  const results = [];
  for (const fixture of fixtures) {
    await prepareFixture(fixture, context);
    const toolName = fixture.toolName;
    const adapter = registry.get(toolName);
    if (!adapter) {
      results.push({
        fixtureId: fixture.fixtureId,
        toolName,
        passed: false,
        failures: [`adapter-not-registered:${toolName}`]
      });
      continue;
    }
    const args = renderValue(fixture.args ?? {}, context);
    const shadow = await adapter.shadow(args);
    const approvalDiff = createApprovalDiff({
      toolName,
      shadow,
      contract: registry.contractFor(toolName)
    });
    const failures = evaluateExpectations({ shadow, approvalDiff }, fixture.expected ?? {});
    results.push({
      fixtureId: fixture.fixtureId,
      title: fixture.title,
      toolName,
      passed: failures.length === 0,
      failures,
      shadow,
      approvalDiff
    });
  }
  return {
    corpusId: corpus.corpusId ?? 'pc-agent-shadow-golden-corpus',
    version: corpus.version ?? '1.0.0',
    fixtureCount: fixtures.length,
    passed: results.every((result) => result.passed),
    passedCount: results.filter((result) => result.passed).length,
    failedCount: results.filter((result) => !result.passed).length,
    results
  };
}

export function createApprovalDiff({ toolName, shadow, contract }) {
  const affectedPaths = new Set();
  if (shadow?.targetPath) affectedPaths.add(shadow.targetPath);
  if (shadow?.outputPath) affectedPaths.add(shadow.outputPath);
  if (shadow?.directory) affectedPaths.add(shadow.directory);
  for (const move of shadow?.moves ?? []) {
    if (move.from) affectedPaths.add(move.from);
    if (move.to) affectedPaths.add(move.to);
  }
  for (const path of shadow?.batchDiff?.creates ?? []) affectedPaths.add(path);
  for (const path of shadow?.batchDiff?.removes ?? []) affectedPaths.add(path);
  const conflictCount = (shadow?.conflicts ?? shadow?.issues ?? []).length;
  const warnings = shadow?.warnings ?? [];
  const expectedChangesCount = shadow?.expectedChangesCount ?? 0;
  const requiresUserApproval = contract?.mutatesSystem === true || conflictCount > 0 || warnings.length > 0;
  return {
    diffVersion: 'b-approval-diff-v1',
    toolName,
    mode: shadow?.mode ?? 'shadow',
    readOnly: contract?.readOnly === true,
    mutatesSystem: contract?.mutatesSystem === true,
    expectedChangesCount,
    affectedPaths: [...affectedPaths].sort(),
    conflictCount,
    warnings,
    requiresUserApproval,
    severity: conflictCount > 0 ? 'conflict' : warnings.length > 0 ? 'warning' : contract?.mutatesSystem === true ? 'approval_required' : 'read_only',
    safeToAutoApprove: contract?.readOnly === true && conflictCount === 0 && warnings.length === 0 && expectedChangesCount === 0,
    summary: summarizeShadow({ toolName, shadow, contract, conflictCount })
  };
}

function summarizeShadow({ toolName, shadow, contract, conflictCount }) {
  if (contract?.readOnly) return `${toolName} is read-only and expects ${shadow?.expectedChangesCount ?? 0} local changes.`;
  if (conflictCount > 0) return `${toolName} has ${conflictCount} preflight conflict(s) before execution.`;
  return `${toolName} expects ${shadow?.expectedChangesCount ?? 0} local change(s) before approval.`;
}

async function prepareFixture(fixture, context) {
  for (const file of fixture.setup?.files ?? []) {
    const path = renderValue(file.path, context);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content ?? '', file.encoding ?? 'utf8');
  }
  for (const directory of fixture.setup?.directories ?? []) {
    await mkdir(renderValue(directory, context), { recursive: true });
  }
}

function evaluateExpectations(result, expected) {
  const failures = [];
  for (const [path, expectedValue] of Object.entries(expected.equals ?? {})) {
    const actual = lookup(result, path);
    if (!Object.is(actual, expectedValue)) {
      failures.push(`${path} expected ${JSON.stringify(expectedValue)} got ${JSON.stringify(actual)}`);
    }
  }
  for (const [path, expectedValue] of Object.entries(expected.includes ?? {})) {
    const actual = lookup(result, path);
    if (Array.isArray(actual)) {
      if (!actual.some((item) => String(item).includes(String(expectedValue)))) {
        failures.push(`${path} expected to include ${JSON.stringify(expectedValue)} got ${JSON.stringify(actual)}`);
      }
    } else if (!String(actual ?? '').includes(String(expectedValue))) {
      failures.push(`${path} expected to include ${JSON.stringify(expectedValue)} got ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}

function lookup(value, path) {
  return path.split('.').reduce((current, part) => current?.[part], value);
}

function renderValue(value, context) {
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, context)]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(context[key] ?? ''));
}
