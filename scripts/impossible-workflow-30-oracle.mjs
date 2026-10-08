import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export const IMPOSSIBLE_WORKFLOW_30_ORACLE_VERSION = 'jarvis-impossible-workflow-30-independent-oracle-v1';

const contracts = [
  c('IW01', 'region-sales.csv', 'csv-groups', { groups: { 서울: 150.5, 부산: 100, 대전: 200 }, order: ['대전', '서울', '부산'] }),
  c('IW02', 'active-customers.csv', 'ordered-ids', { ids: ['c3', 'c1', 'c4'] }),
  c('IW03', 'unique-contacts.csv', 'unique-field', { field: 'email', values: ['a@example.test', 'b@example.test', 'c@example.test'] }),
  c('IW04', 'expense-pivot.json', 'pivot', { cells: { '개발/01': 125, '개발/02': 150, '영업/01': 80, '영업/02': 120 } }),
  c('IW05', 'employee-validation.json', 'validation', { valid: true, count: 3, errors: 0 }),
  c('IW06', 'paid-quantity.csv', 'csv-groups', { groups: { book: 6, food: 3 } }),
  c('IW07', 'customer-orders.json', 'join-pairs', { pairs: [['o1', 'c2'], ['o2', 'c1']] }),
  c('IW08', 'unique-events.json', 'unique-field', { field: 'eventId', values: ['v1', 'v2', 'v3'] }),
  c('IW09', 'ledger-balance.json', 'ledger', { balanceMinor: '2', debitMinor: '100000000000031', creditMinor: '100000000000029' }),
  c('IW10', 'unit-conversion.json', 'number', { value: 1250000 }),
  c('IW11', 'typed-condition.json', 'assertion', { passed: true }),
  c('IW12', 'priced-products.json', 'join-pairs', { pairs: [['p1', 'p1'], ['p2', 'p2']], leftField: 'sku', rightField: 'sku' }),
  c('IW13', 'topological-order.json', 'topological', { nodes: ['A', 'B', 'C', 'D', 'E'], edges: [['A', 'C'], ['B', 'C'], ['C', 'D'], ['C', 'E']] }),
  c('IW14', 'shortest-path.json', 'shortest', { start: 'A', end: 'F', distance: 14, path: ['A', 'C', 'B', 'D', 'F'] }),
  c('IW15', 'critical-path.json', 'critical', { duration: 12, path: ['A', 'B', 'D'] }),
  c('IW16', 'optimal-portfolio.json', 'knapsack', { ids: ['A', 'C'], weight: 10, value: 46 }),
  c('IW17', 'resource-schedule.json', 'schedule', { ids: ['A', 'B', 'C', 'D', 'E'], dependencies: { C: ['A'], D: ['B'], E: ['C', 'D'] } }),
  c('IW18', 'schedule-assertion.json', 'assertion', { passed: true, count: 5 }),
  c('IW19', 'tree-inventory.json', 'inventory', { fileCount: 5, paths: ['a/report.txt', 'b/nested/log.txt', 'b/nested/copy.txt', 'c/copy-again.txt', 'c/notes.md'] }),
  c('IW20', 'error-search.json', 'search', { count: 3, tokens: ['ERROR-101', 'ERROR-203', 'ERROR-404'] }),
  c('IW21', 'duplicate-groups.json', 'duplicates', { group: ['b/nested/copy.txt', 'c/copy-again.txt'] }),
  c('IW22', 'large-text-stats.json', 'text-stats', { lines: 6000, words: 30000, inputPath: 'inputs/large.txt' }),
  c('IW23', 'rendered-documents.json', 'rendered', { count: 3, tokens: ['가람', '나래', '다온', 'O-1', 'O-2', 'O-3'] }),
  c('IW24', 'search-count.json', 'assertion', { passed: true, count: 3 }),
  c('IW25', 'process-result.json', 'process-json', { joined: 'alpha:beta', length: 9 }),
  c('IW26', 'pipeline-result.json', 'process-json', { lineCount: 3, unique: 2, lines: ['ALPHA', 'ALPHA', 'BETA'] }),
  c('IW27', 'retry-result.json', 'process-json', { recovered: true, attempt: 2, markerPath: 'outputs/retry-marker.txt' }),
  c('IW28', 'stream-summary.json', 'process-json', { lineCount: 12000, first: 'row-00001', last: 'row-12000' }),
  c('IW29', 'sqlite-summary.csv', 'sqlite-summary', { rows: { A: 15, B: 23 }, databasePath: 'outputs/transactions.db' }),
  c('IW30', 'sqlite-inventory.csv', 'sqlite-inventory', { rows: { i1: ['연필', 10], i2: ['공책', 8], i3: ['지우개', 4] }, databasePath: 'outputs/inventory.db' })
];

export const impossibleWorkflow30OracleContracts = deepFreeze(contracts);
export const IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256 = sha256(Buffer.from(stableStringify({
  version: IMPOSSIBLE_WORKFLOW_30_ORACLE_VERSION,
  contracts
}), 'utf8'));

export async function verifyImpossibleWorkflow30Case(caseId, caseDir) {
  const contract = contracts.find((item) => item.caseId === caseId);
  if (!contract) throw new Error(`Unknown independent oracle contract: ${caseId}`);
  const root = resolve(caseDir);
  const checks = [];
  const primaryPath = join(root, 'outputs', contract.primary);
  const proofPath = join(root, 'outputs', contract.proof);
  const primary = await readArtifact(primaryPath, checks, 'primary_output');
  const proof = await readArtifact(proofPath, checks, 'proof_output');
  let value = null;
  if (primary) {
    try {
      value = contract.primary.endsWith('.csv') ? parseCsv(primary.bytes.toString('utf8')) : JSON.parse(primary.bytes.toString('utf8'));
      checks.push(check('primary_parseable', true, contract.primary));
    } catch (error) {
      checks.push(check('primary_parseable', false, error.message));
    }
  }
  if (proof) {
    try {
      const parsedProof = JSON.parse(proof.bytes.toString('utf8'));
      checks.push(check('proof_parseable', true, contract.proof));
      checks.push(check('proof_assertion_passed', parsedProof?.passed === true && !containsExplicitFalse(parsedProof), 'proof는 최상위 passed=true이고 어떤 하위 assertion에도 false가 없어야 한다.'));
    } catch (error) {
      checks.push(check('proof_parseable', false, error.message));
    }
  }
  if (value !== null) {
    try {
      const detailChecks = await verifyKind(contract, value, root);
      checks.push(...detailChecks);
    } catch (error) {
      checks.push(check('semantic_oracle_completed', false, error.message));
    }
  }
  const passed = checks.length > 0 && checks.every((item) => item.passed);
  return {
    oracleVersion: IMPOSSIBLE_WORKFLOW_30_ORACLE_VERSION,
    oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
    caseId,
    passed,
    checks,
    artifacts: [primary, proof].filter(Boolean).map(({ bytes, ...item }) => item)
  };
}

function c(caseId, primary, kind, expected) {
  const stem = primary.replace(/\.(?:json|csv)$/u, '');
  return { caseId, primary, proof: `${stem}-proof.json`, kind, expected };
}

async function readArtifact(path, checks, checkId) {
  try {
    const linkMetadata = await lstat(path);
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    const nonempty = metadata.isFile() && !linkMetadata.isSymbolicLink() && bytes.length > 0;
    checks.push(check(checkId, nonempty, `${path} (${bytes.length} bytes)`));
    return { path, size: bytes.length, sha256: sha256(bytes), bytes };
  } catch (error) {
    checks.push(check(checkId, false, `${path}: ${error.code ?? error.message}`));
    return null;
  }
}

async function verifyKind(contract, raw, root) {
  const expected = contract.expected;
  const rows = rowsFrom(raw);
  const text = JSON.stringify(raw);
  switch (contract.kind) {
    case 'csv-groups': {
      const actual = Object.fromEntries(rows.map((row) => [groupKey(row), numericValue(row)]));
      const checks = [check('group_aggregate_exact', mapNumbersEqual(actual, expected.groups), JSON.stringify(actual))];
      if (expected.order) checks.push(check('group_sort_exact', rows.map(groupKey).join('|') === expected.order.join('|'), rows.map(groupKey).join('|')));
      return checks;
    }
    case 'ordered-ids': return [check('ordered_ids_exact', rows.map((row) => String(row.id)).join('|') === expected.ids.join('|'), rows.map((row) => row.id).join('|'))];
    case 'unique-field': {
      const items = rowsFrom(raw);
      const values = items.map((item) => String(item[expected.field]));
      return [check('unique_values_exact', new Set(values).size === expected.values.length && sameSet(values, expected.values), values.join('|'))];
    }
    case 'pivot': {
      const items = rowsFrom(raw);
      const cells = {};
      for (const item of items) {
        const department = String(item.department ?? item.row ?? '');
        for (const [key, value] of Object.entries(item)) if (!['department', 'row'].includes(key)) cells[`${department}/${key}`] = Number(value);
      }
      return [check('pivot_cells_exact', items.length === 2 && mapNumbersEqual(cells, expected.cells), JSON.stringify(cells))];
    }
    case 'validation': return [
      check('validation_is_valid', findScalar(raw, ['valid', 'passed']) === true, text),
      check('validation_count', Number(findScalar(raw, ['count', 'validatedCount'])) === expected.count, text),
      check('validation_errors_empty', arrayLength(raw, ['errors']) === expected.errors, text)
    ];
    case 'join-pairs': {
      const items = rowsFrom(raw);
      const independentlyJoined = await recomputeJoin(contract.caseId, root);
      return [check('join_rows_recomputed_from_inputs', independentlyJoined !== null && canonicalRows(items) === canonicalRows(independentlyJoined), JSON.stringify(items))];
    }
    case 'ledger': return [
      check('ledger_balance_exact_minor', String(findScalar(raw, ['balanceMinor', 'balance', 'netMinor'])) === expected.balanceMinor, text),
      check('ledger_debit_exact_minor', String(findScalar(raw, ['debitMinor', 'totalDebitMinor'])) === expected.debitMinor, text),
      check('ledger_credit_exact_minor', String(findScalar(raw, ['creditMinor', 'totalCreditMinor'])) === expected.creditMinor, text)
    ];
    case 'number': return [check('numeric_value_exact', Number(findScalar(raw, ['value', 'result'])) === expected.value, text)];
    case 'assertion': return [
      check('assertion_passed', findScalar(raw, ['passed', 'success', 'valid']) === true, text),
      ...(expected.count === undefined ? [] : [check('assertion_count', Number(findScalar(raw, ['actual', 'count'])) === expected.count, text)])
    ];
    case 'topological': {
      const order = sequenceFrom(raw, ['order', 'items', 'nodes', 'value']);
      const at = new Map(order.map((id, index) => [String(id), index]));
      return [
        check('topological_nodes_exact', order.length === expected.nodes.length && sameSet(order.map(String), expected.nodes), order.join('|')),
        check('topological_edges_respected', expected.edges.every(([from, to]) => at.get(from) < at.get(to)), order.join('|'))
      ];
    }
    case 'shortest': {
      const path = sequenceFrom(raw, ['path', 'nodes', 'items']);
      return [check('shortest_path_exact', path.map(String).join('|') === expected.path.join('|'), path.join('|')), check('shortest_distance_exact', Number(findScalar(raw, ['distance', 'cost', 'totalWeight'])) === expected.distance, text)];
    }
    case 'critical': {
      const path = sequenceFrom(raw, ['path', 'criticalPath', 'items']);
      return [check('critical_path_exact', path.map(String).join('|') === expected.path.join('|'), path.join('|')), check('critical_duration_exact', Number(findScalar(raw, ['duration', 'totalDuration', 'makespan'])) === expected.duration, text)];
    }
    case 'knapsack': {
      const chosen = sequenceFrom(raw, ['selectedIds', 'ids', 'items']).map((item) => typeof item === 'object' ? item.id : item).map(String);
      return [check('knapsack_ids_exact', sameSet(chosen, expected.ids), chosen.join('|')), check('knapsack_value_exact', Number(findScalar(raw, ['totalValue', 'value'])) === expected.value, text), check('knapsack_capacity_respected', Number(findScalar(raw, ['totalWeight', 'weight'])) <= expected.weight, text)];
    }
    case 'schedule': {
      const items = rowsFrom(raw);
      const sourceTasks = JSON.parse(await readFile(join(root, 'inputs/tasks.json'), 'utf8'));
      const bySourceId = new Map(sourceTasks.map((item) => [String(item.id), item]));
      const ids = items.map((item) => String(item.id ?? item.taskId));
      const timeById = new Map(items.map((item) => [String(item.id ?? item.taskId), { start: Number(item.start ?? item.startTime), end: Number(item.end ?? item.endTime), resource: Number(item.resource) }]));
      const durationsMatch = items.every((item) => {
        const source = bySourceId.get(String(item.id ?? item.taskId));
        const time = timeById.get(String(item.id ?? item.taskId));
        return source && Number.isFinite(time.start) && Number.isFinite(time.end) && time.start >= 0 && time.end - time.start === Number(source.duration);
      });
      const resourcesValid = items.every((item) => Number.isInteger(Number(item.resource)) && Number(item.resource) >= 0 && Number(item.resource) < 2);
      const noResourceOverlap = items.every((left, index) => items.slice(index + 1).every((right) => Number(left.resource) !== Number(right.resource)
        || Number(left.end ?? left.endTime) <= Number(right.start ?? right.startTime)
        || Number(right.end ?? right.endTime) <= Number(left.start ?? left.startTime)));
      return [
        check('schedule_tasks_exact', sameSet(ids, expected.ids), ids.join('|')),
        check('schedule_durations_recomputed', durationsMatch, JSON.stringify(items)),
        check('schedule_dependencies_respected', Object.entries(expected.dependencies).every(([id, dependencies]) => dependencies.every((dep) => timeById.get(dep)?.end <= timeById.get(id)?.start)), JSON.stringify([...timeById])),
        check('schedule_resource_bounds', resourcesValid, JSON.stringify(items.map((item) => item.resource))),
        check('schedule_resource_non_overlap', noResourceOverlap, JSON.stringify(items))
      ];
    }
    case 'inventory': {
      const items = rowsFrom(raw);
      const independent = await inventoryBytes(join(root, 'inputs/tree'));
      const actual = new Map(items.map((item) => [String(item.relativePath ?? item.path ?? item.name).replaceAll('\\', '/'), item]));
      const paths = [...actual.keys()];
      const exactBytes = independent.every((file) => {
        const item = actual.get(file.path) ?? [...actual.entries()].find(([path]) => path.endsWith(file.path))?.[1];
        return item && String(item.sha256 ?? item.contentSha256) === file.sha256 && Number(item.size) === file.size;
      });
      return [
        check('inventory_file_count', items.length === expected.fileCount && independent.length === expected.fileCount, String(items.length)),
        check('inventory_paths', expected.paths.every((suffix) => paths.some((path) => path.endsWith(suffix))), paths.join('|')),
        check('inventory_bytes_recomputed', exactBytes, JSON.stringify(items))
      ];
    }
    case 'search': {
      const actual = rowsFrom(raw).map((item) => ({ path: String(item.relativePath ?? item.path ?? '').replaceAll('\\', '/'), match: item.match, index: Number(item.index) }));
      const independent = await recomputeRegexSearch(join(root, 'inputs/tree'), /ERROR-[0-9]{3}/gu);
      return [check('search_matches_recomputed', canonicalRows(actual) === canonicalRows(independent) && independent.length === expected.count, JSON.stringify(actual))];
    }
    case 'duplicates': {
      const independent = await recomputeDuplicateGroups(join(root, 'inputs/tree'));
      const groups = Array.isArray(raw?.groups) ? raw.groups : rowsFrom(raw);
      const normalized = groups.map((group) => ({ sha256: group.sha256, files: (group.files ?? []).map((file) => String(file.relativePath ?? file.path ?? '').replaceAll('\\', '/')).sort() })).sort((a, b) => String(a.sha256).localeCompare(String(b.sha256)));
      return [check('duplicate_groups_recomputed', canonicalRows(normalized) === canonicalRows(independent), JSON.stringify(normalized))];
    }
    case 'text-stats': {
      const input = await readFile(join(root, expected.inputPath), 'utf8');
      const independentLines = input.split(/\r?\n/u).filter((line) => line.length > 0).length;
      const independentWords = input.trim().split(/\s+/u).filter(Boolean).length;
      return [check('text_lines_recomputed', Number(findScalar(raw, ['lines', 'lineCount'])) === independentLines && independentLines === expected.lines, text), check('text_words_recomputed', Number(findScalar(raw, ['words', 'wordCount'])) === independentWords && independentWords === expected.words, text)];
    }
    case 'rendered': {
      const [template, records] = await Promise.all([readFile(join(root, 'inputs/template.txt'), 'utf8'), readJsonFile(join(root, 'inputs/records.json'))]);
      const expectedTexts = records.map((record) => template.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_match, key) => String(record[key.trim()] ?? '')));
      const actualTexts = rows.map((item) => String(item.text ?? item));
      return [check('render_texts_recomputed', actualTexts.length === expected.count && stableStringify(actualTexts) === stableStringify(expectedTexts), JSON.stringify(actualTexts))];
    }
    case 'process-json': {
      const decoded = decodeProcessJson(raw);
      const exact = Object.entries(expected).filter(([key]) => !key.endsWith('Path')).every(([key, value]) => stableStringify(decoded[key]) === stableStringify(value));
      const checks = [check('process_payload_exact', exact, JSON.stringify(decoded))];
      if (expected.markerPath) checks.push(check('retry_marker_exists', await exists(join(root, expected.markerPath)), expected.markerPath));
      return checks;
    }
    case 'sqlite-summary': {
      const map = Object.fromEntries(rows.map((row) => [String(row.category), Number(row.total)]));
      const dbRows = await querySqlite(join(root, expected.databasePath), 'SELECT category, SUM(CAST(amount AS REAL)) AS total FROM transactions GROUP BY category ORDER BY category');
      const dbMap = Object.fromEntries(dbRows.map((row) => [String(row.category), Number(row.total)]));
      return [check('sqlite_query_rows_exact', mapNumbersEqual(map, expected.rows), JSON.stringify(map)), check('sqlite_database_query_recomputed', mapNumbersEqual(dbMap, expected.rows) && mapNumbersEqual(dbMap, map), JSON.stringify(dbMap))];
    }
    case 'sqlite-inventory': {
      const map = Object.fromEntries(rows.map((row) => [String(row.id), [String(row.name), Number(row.quantity)]]));
      const dbRows = await querySqlite(join(root, expected.databasePath), 'SELECT id, name, quantity FROM inventory ORDER BY id');
      const dbMap = Object.fromEntries(dbRows.map((row) => [String(row.id), [String(row.name), Number(row.quantity)]]));
      return [check('sqlite_upsert_rows_exact', stableStringify(map) === stableStringify(expected.rows), JSON.stringify(map)), check('sqlite_upsert_database_query_recomputed', stableStringify(dbMap) === stableStringify(expected.rows) && stableStringify(dbMap) === stableStringify(map), JSON.stringify(dbMap))];
    }
    default: return [check('known_oracle_kind', false, contract.kind)];
  }
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['items', 'rows', 'records', 'value', 'result', 'groups', 'schedule']) {
    if (Array.isArray(value?.[key])) return value[key];
    if (value?.[key] && typeof value[key] === 'object') {
      const nested = rowsFrom(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
}

function parseCsvLine(line) {
  const cells = []; let cell = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell); return cells;
}

function groupKey(row) { return String(row.group ?? row.key ?? row.name ?? row.region ?? row.category ?? row.department); }
function numericValue(row) { return Number(row.value ?? row.sum ?? row.total ?? row.amount ?? row.quantity); }
function mapNumbersEqual(actual, expected) { return Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => Number(actual[key]) === Number(value)); }
function sameSet(left, right) { return left.length === right.length && [...new Set(left)].sort().join('|') === [...new Set(right)].sort().join('|'); }

function findScalar(value, keys) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return value;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key) && !Array.isArray(value[key]) && typeof value[key] !== 'object') return value[key];
  for (const child of Object.values(value)) { const found = findScalar(child, keys); if (found !== undefined) return found; }
  return undefined;
}

function sequenceFrom(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  for (const child of Object.values(value ?? {})) { if (child && typeof child === 'object') { const found = sequenceFrom(child, keys); if (found.length) return found; } }
  return [];
}

function arrayLength(value, keys) { return sequenceFrom(value, keys).length; }

function decodeProcessJson(value) {
  if (value && typeof value === 'object') {
    for (const key of ['stdout', 'output', 'value']) {
      if (typeof value[key] === 'string') { try { return JSON.parse(value[key]); } catch {} }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') { const decoded = decodeProcessJson(child); if (decoded !== child || Object.keys(decoded).some((key) => ['joined', 'lineCount', 'recovered'].includes(key))) return decoded; }
  }
  return value;
}

function containsExplicitFalse(value) {
  if (value === false) return true;
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (value.passed === false || value.success === false || value.valid === false) return true;
  return Object.values(value).some(containsExplicitFalse);
}

function check(checkId, passed, detail) { return { checkId, passed: passed === true, detail: String(detail ?? '') }; }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function nonempty(path) { try { const metadata = await stat(path); return metadata.isFile() && metadata.size > 0; } catch { return false; } }

async function recomputeJoin(caseId, root) {
  if (caseId === 'IW07') {
    const [customers, orders] = await Promise.all([readJsonFile(join(root, 'inputs/customers.json')), readJsonFile(join(root, 'inputs/orders.json'))]);
    const byId = new Map(customers.map((item) => [item.id, item]));
    return orders.filter((order) => byId.has(order.customerId)).map((order) => {
      const customer = byId.get(order.customerId);
      return { ...order, right_id: customer.id, name: customer.name };
    });
  }
  if (caseId === 'IW12') {
    const [products, prices] = await Promise.all([readCsvFile(join(root, 'inputs/products.csv')), readCsvFile(join(root, 'inputs/prices.csv'))]);
    const bySku = new Map(prices.map((item) => [item.sku, item]));
    return products.filter((item) => bySku.has(item.sku)).map((item) => ({ ...item, ...bySku.get(item.sku) }));
  }
  return null;
}

async function inventoryBytes(root) {
  const files = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative(root, path).replaceAll('\\', '/'), size: bytes.length, sha256: sha256(bytes), text: bytes.toString('utf8') });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function recomputeRegexSearch(root, regex) {
  const files = await inventoryBytes(root);
  const matches = [];
  for (const file of files) {
    regex.lastIndex = 0;
    for (const match of file.text.matchAll(regex)) matches.push({ path: file.path, match: match[0], index: match.index });
  }
  return matches;
}

async function recomputeDuplicateGroups(root) {
  const files = await inventoryBytes(root);
  const groups = new Map();
  for (const file of files) {
    if (!groups.has(file.sha256)) groups.set(file.sha256, []);
    groups.get(file.sha256).push(file.path);
  }
  return [...groups.entries()].filter(([, paths]) => paths.length > 1).map(([sha256, paths]) => ({ sha256, files: paths.sort() })).sort((a, b) => a.sha256.localeCompare(b.sha256));
}

async function querySqlite(path, sql) {
  const link = await lstat(path);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error(`SQLite artifact is not a regular file: ${path}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

async function readJsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function readCsvFile(path) { return parseCsv(await readFile(path, 'utf8')); }
function canonicalRows(rows) { return stableStringify([...rows].sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))); }

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }

if (contracts.length !== 30 || new Set(contracts.map((item) => item.caseId)).size !== 30) throw new Error('Independent oracle must contain exactly 30 unique contracts.');
