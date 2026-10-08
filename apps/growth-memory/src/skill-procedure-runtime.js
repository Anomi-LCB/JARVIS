import { createHash } from 'node:crypto';

const MAX_CASES = 10;
const MAX_ROWS_PER_CASE = 1_000;
const MAX_TOTAL_ROWS = 5_000;
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_ALIASES = 24;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value), 'utf8').digest('hex');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }

function normalizedHeader(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s_\-./()[\]{}]+/gu, '');
}

function validateAliases(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALIASES
      || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 80)
      || new Set(value.map(normalizedHeader)).size !== value.length) {
    return { valid: false, issue: `${field} must contain 1..${MAX_ALIASES} unique nonempty aliases` };
  }
  return { valid: true };
}

export function validateTabularProcedureDefinition(definition) {
  const issues = [];
  if (!definition || Object.getPrototypeOf(definition) !== Object.prototype
      || definition.kind !== 'tabular-group-sum-v1') issues.push('procedure kind must be tabular-group-sum-v1');
  if (typeof definition?.reportTitle !== 'string' || !definition.reportTitle.trim() || definition.reportTitle.length > 120) {
    issues.push('reportTitle must contain 1..120 characters');
  }
  for (const [field, value] of [['groupAliases', definition?.groupAliases], ['valueAliases', definition?.valueAliases]]) {
    const result = validateAliases(value, field);
    if (!result.valid) issues.push(result.issue);
  }
  if (Array.isArray(definition?.groupAliases) && Array.isArray(definition?.valueAliases)) {
    const group = new Set(definition.groupAliases.map(normalizedHeader));
    if (definition.valueAliases.some(alias => group.has(normalizedHeader(alias)))) issues.push('group and value aliases must be disjoint');
  }
  return { valid: issues.length === 0, issues };
}

function resolveColumn(rows, aliases, role) {
  const available = new Set(rows.flatMap(row => Object.keys(row)));
  // Preserve every physical column: normalization must never select the last
  // spelling silently when two input columns denote the same role.
  const byNormalized = new Map();
  for (const key of available) {
    const normalized = normalizedHeader(key);
    const columns = byNormalized.get(normalized) ?? [];
    columns.push(key);
    byNormalized.set(normalized, columns);
  }
  const matches = aliases.flatMap(alias => byNormalized.get(normalizedHeader(alias)) ?? []);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) return { error: unique.length ? `ambiguous-${role}-column` : `missing-${role}-column` };
  if (rows.some(row => !Object.hasOwn(row, unique[0]))) return { error: `inconsistent-${role}-column` };
  return { column: unique[0] };
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_CASE) return 'rows must contain 1..1000 items';
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) return 'each row must be a plain object';
    const keys = Object.keys(row);
    if (!keys.length || keys.length > 64 || keys.some(key => !key.trim() || key.length > 100 || forbiddenKeys.has(key))) return 'row contains an unsafe or invalid key';
    for (const value of Object.values(row)) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return 'cells must be scalar values';
      if (typeof value === 'string' && value.length > 2_000) return 'cell text exceeds 2000 characters';
      if (typeof value === 'number' && !Number.isFinite(value)) return 'numeric cells must be finite';
    }
  }
  return null;
}

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > MAX_CASES) return { valid: false, issue: 'trialCases must contain 2..10 cases' };
  const ids = new Set();
  const sourceIds = new Set();
  const inputHashes = new Set();
  let rowsTotal = 0;
  let byteTotal = 0;
  for (const item of cases) {
    if (!item || typeof item !== 'object' || !['demonstration', 'holdout'].includes(item.split)
        || typeof item.caseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(item.caseId)
        || typeof item.sourceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(item.sourceId)) {
      return { valid: false, issue: 'each trial needs safe caseId/sourceId and demonstration or holdout split' };
    }
    if (ids.has(item.caseId)) return { valid: false, issue: 'trial case IDs must be unique' };
    ids.add(item.caseId);
    sourceIds.add(item.sourceId);
    const rowsIssue = validateRows(item.rows);
    if (rowsIssue) return { valid: false, issue: `${item.caseId}: ${rowsIssue}` };
    if (!Array.isArray(item.expectedRows) || item.expectedRows.length < 1 || item.expectedRows.length > MAX_ROWS_PER_CASE
        || item.expectedRows.some(row => !row || typeof row.group !== 'string' || !row.group.trim()
          || !Number.isFinite(row.total) || !Number.isSafeInteger(row.count) || row.count < 1)) {
      return { valid: false, issue: `${item.caseId}: expectedRows must contain group, finite total and positive count` };
    }
    const hash = digest(item.rows);
    if (inputHashes.has(hash)) return { valid: false, issue: 'trial cases must use distinct source content' };
    inputHashes.add(hash);
    rowsTotal += item.rows.length;
    byteTotal += Buffer.byteLength(canonicalJson(item), 'utf8');
  }
  if (!cases.some(item => item.split === 'demonstration') || !cases.some(item => item.split === 'holdout')) {
    return { valid: false, issue: 'at least one demonstration and one holdout are required' };
  }
  if (sourceIds.size < 2) return { valid: false, issue: 'demonstration and holdout must come from distinct sources' };
  if (rowsTotal > MAX_TOTAL_ROWS) return { valid: false, issue: `trial rows exceed ${MAX_TOTAL_ROWS}` };
  if (byteTotal > MAX_INPUT_BYTES) return { valid: false, issue: `trial data exceeds ${MAX_INPUT_BYTES} bytes` };
  return { valid: true };
}

function sortRows(rows) {
  return [...rows].sort((left, right) => left.group.localeCompare(right.group, 'ko-KR'));
}

export function runTabularProcedure(definition, rows) {
  const definitionValidation = validateTabularProcedureDefinition(definition);
  if (!definitionValidation.valid) return { success: false, error: 'invalid-procedure-definition', issues: definitionValidation.issues };
  const rowsIssue = validateRows(rows);
  if (rowsIssue) return { success: false, error: 'invalid-trial-input', issues: [rowsIssue] };
  const groupColumn = resolveColumn(rows, definition.groupAliases, 'group');
  const valueColumn = resolveColumn(rows, definition.valueAliases, 'value');
  if (groupColumn.error || valueColumn.error) return { success: false, error: 'column-resolution-failed', issues: [groupColumn.error, valueColumn.error].filter(Boolean) };
  if (groupColumn.column === valueColumn.column) return { success: false, error: 'column-role-collision', issues: ['group and value columns resolved to the same input column'] };
  const grouped = new Map();
  for (const row of rows) {
    const group = String(row[groupColumn.column] ?? '').normalize('NFC').trim();
    const rawValue = row[valueColumn.column];
    const value = typeof rawValue === 'number' ? rawValue
      : typeof rawValue === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(rawValue.trim()) ? Number(rawValue) : NaN;
    if (!group || !Number.isFinite(value)) return { success: false, error: 'invalid-cell-value', issues: ['group values must be nonempty and sum values finite numeric'] };
    const prior = grouped.get(group) ?? { group, total: 0, count: 0 };
    prior.total += value;
    prior.count += 1;
    if (!Number.isFinite(prior.total)) return { success: false, error: 'sum-overflow', issues: ['group sum is not finite'] };
    grouped.set(group, prior);
  }
  const resultRows = sortRows([...grouped.values()]).map(item => ({ group: item.group, total: Number(item.total.toFixed(8)), count: item.count }));
  const markdown = [`# ${definition.reportTitle}`, '', '| 그룹 | 합계 | 건수 |', '|---|---:|---:|',
    ...resultRows.map(item => `| ${item.group.replaceAll('|', '\\|').replace(/[\r\n]/gu, ' ')} | ${item.total} | ${item.count} |`), ''].join('\n');
  return { success: true, groupColumn: groupColumn.column, valueColumn: valueColumn.column, resultRows, markdown };
}

export function evaluateTabularProcedureTrials(definition, cases) {
  const validation = validateCases(cases);
  if (!validation.valid) return { success: false, error: 'invalid-trial-suite', issues: [validation.issue] };
  const runResults = cases.map(item => {
    const result = runTabularProcedure(definition, item.rows);
    const expectedRows = sortRows(item.expectedRows.map(row => ({ group: row.group.normalize('NFC').trim(), total: Number(row.total.toFixed(8)), count: row.count })));
    const expectedSha256 = digest(expectedRows);
    const actualSha256 = result.success ? digest(result.resultRows) : null;
    const columns = result.success ? { group: result.groupColumn, value: result.valueColumn } : null;
    return {
      caseId: item.caseId, sourceId: item.sourceId, split: item.split,
      inputSha256: digest(item.rows), expectedSha256, actualSha256,
      resolvedColumnSha256: columns ? digest(columns) : null,
      inputRowCount: item.rows.length, expectedGroupCount: expectedRows.length,
      actualGroupCount: result.success ? result.resultRows.length : null,
      status: result.success && actualSha256 === expectedSha256 ? 'passed' : 'failed',
      error: result.success ? null : result.error
    };
  });
  const demonstrationColumns = runResults.filter(item => item.split === 'demonstration').map(item => item.resolvedColumnSha256);
  const holdoutColumns = runResults.filter(item => item.split === 'holdout').map(item => item.resolvedColumnSha256);
  const renamedInputObserved = demonstrationColumns.some(value => value && holdoutColumns.some(other => other && value !== other));
  const checks = [
    { id: 'distinct_demo_and_holdout_sources', status: new Set(runResults.filter(item => item.split === 'demonstration').map(item => item.sourceId)).size > 0
        && new Set(runResults.filter(item => item.split === 'holdout').map(item => item.sourceId)).size > 0
        && !runResults.some(holdout => holdout.split === 'holdout' && runResults.some(demo => demo.split === 'demonstration' && demo.sourceId === holdout.sourceId)) ? 'passed' : 'failed' },
    { id: 'renamed_columns_resolved_on_holdout', status: renamedInputObserved ? 'passed' : 'failed' },
    { id: 'all_expected_group_sums_match', status: runResults.every(item => item.status === 'passed') ? 'passed' : 'failed' }
  ];
  return {
    success: true,
    status: checks.every(item => item.status === 'passed') ? 'passed' : 'failed',
    mode: 'cross-material-deterministic-procedure-trials-v1',
    caseCount: runResults.length,
    holdoutCount: runResults.filter(item => item.split === 'holdout').length,
    checks, cases: runResults
  };
}
