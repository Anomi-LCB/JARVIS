// Pure, bounded JSON transformations. Filesystem and publication stay in the adapter.
const MAX_ROWS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_VALUES = 500_000;
const MAX_DEPTH = 32;
const MAX_FIELDS = 128;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const DATA_WORKFLOW_OPERATIONS = Object.freeze([
  'data.project', 'data.derive', 'data.flatten', 'data.limit', 'data.union',
  'data.reconcile', 'data.window', 'data.statistics', 'data.normalize',
  'text.replace', 'text.redact'
]);
const supportedOperations = new Set(DATA_WORKFLOW_OPERATIONS);

function fail(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  throw error;
}

function safeKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 256 || UNSAFE_KEYS.has(key)) {
    fail('WORKFLOW_PROPERTY_PATH_UNSAFE', String(key));
  }
  return key;
}

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('WORKFLOW_TYPE_MISMATCH', `${label}-must-be-plain-object`);
  }
  return value;
}

function numeric(value, label = 'number') {
  if (typeof value !== 'number' && (typeof value !== 'string'
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value))) {
    fail('WORKFLOW_NUMBER_INVALID', label);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) fail('WORKFLOW_NUMBER_INVALID', label);
  if (Math.abs(number) > Number.MAX_SAFE_INTEGER) fail('WORKFLOW_NUMBER_OVERFLOW', label);
  return Object.is(number, -0) ? 0 : number;
}

function consume(budget, bytes) {
  budget.values += 1;
  budget.bytes += bytes;
  if (budget.bytes > MAX_BYTES || budget.values > MAX_VALUES) fail('WORKFLOW_DATA_BUDGET_EXCEEDED');
}

// Validate before dereferencing properties, so getters and inherited data never run.
function inspectJson(value, budget, depth = 0, ancestors = new WeakSet(), copy = false) {
  if (depth > MAX_DEPTH) fail('WORKFLOW_DATA_DEPTH_EXCEEDED');
  if (value === null || typeof value === 'boolean') {
    consume(budget, value === null ? 4 : value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    numeric(value);
    consume(budget, String(value).length);
    return value;
  }
  if (typeof value === 'string') {
    // Bound the source before JSON.stringify can allocate its escaped representation.
    if (value.length > MAX_BYTES) fail('WORKFLOW_DATA_BUDGET_EXCEEDED');
    consume(budget, Buffer.byteLength(JSON.stringify(value), 'utf8'));
    return value;
  }
  if (typeof value !== 'object') fail('WORKFLOW_JSON_VALUE_INVALID', typeof value);
  if (ancestors.has(value)) fail('WORKFLOW_DATA_CYCLE');
  const array = Array.isArray(value);
  if (!array) object(value, 'value');
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail('WORKFLOW_JSON_VALUE_INVALID', 'symbol-key');
  ancestors.add(value);
  consume(budget, 2);
  const result = copy ? (array ? [] : {}) : value;
  const keys = Object.keys(value);
  if (array && (keys.length !== value.length || keys.some((key, index) => String(index) !== key))) {
    fail('WORKFLOW_JSON_VALUE_INVALID', 'sparse-or-decorated-array');
  }
  for (const key of keys) {
    if (!array) safeKey(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('WORKFLOW_JSON_VALUE_INVALID', 'accessor');
    consume(budget, (array ? 0 : Buffer.byteLength(JSON.stringify(key), 'utf8') + 1) + 1);
    const child = inspectJson(descriptor.value, budget, depth + 1, ancestors, copy);
    if (copy) result[key] = child;
  }
  ancestors.delete(value);
  return result;
}

function rows(value, label = 'items') {
  const result = Array.isArray(value) ? value : value?.items ?? value?.rows;
  if (!Array.isArray(result)) fail('WORKFLOW_TYPE_MISMATCH', `${label}-must-be-array`);
  if (result.length > MAX_ROWS) fail('WORKFLOW_ROW_LIMIT', label);
  return result;
}

function pathParts(path) {
  const parts = Array.isArray(path) ? path : typeof path === 'string' ? path.split('.') : [];
  if (!parts.length || parts.length > 16) fail('WORKFLOW_PROPERTY_PATH_UNSAFE', String(path));
  return parts.map(safeKey);
}

function at(item, path, required = true) {
  const parts = pathParts(path);
  // Aggregation/CSV outputs may carry an exact dotted column name. Explicit
  // array paths always traverse, allowing callers to disambiguate both forms.
  if (typeof path === 'string' && item && typeof item === 'object' && Object.hasOwn(item, path)) return item[path];
  let current = item;
  for (const key of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      if (required) fail('WORKFLOW_FIELD_MISSING', Array.isArray(path) ? path.join('.') : path);
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function setAt(item, path, value) {
  const keys = pathParts(path);
  const output = { ...object(item, 'row') };
  if (typeof path === 'string' && Object.hasOwn(item, path)) { output[path] = value; return output; }
  let target = output;
  for (const key of keys.slice(0, -1)) {
    const next = object(target[key], key);
    target[key] = { ...next };
    target = target[key];
  }
  target[keys.at(-1)] = value;
  return output;
}

function fields(value, label = 'fields', allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > MAX_FIELDS) {
    fail('WORKFLOW_FIELDS_INVALID', label);
  }
  const seen = new Set();
  return value.map((field) => {
    pathParts(field);
    const key = JSON.stringify(field);
    if (seen.has(key)) fail('WORKFLOW_FIELD_DUPLICATE', String(field));
    seen.add(key);
    return field;
  });
}

function integer(value, label, minimum = 0, maximum = MAX_ROWS) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('WORKFLOW_ARGUMENT_INVALID', label);
  return value;
}

function booleanOption(value, defaultValue, label) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') fail('WORKFLOW_ARGUMENT_INVALID', label);
  return value;
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function collector() {
  const items = [];
  const budget = { bytes: 2, values: 1 };
  return {
    add(item) {
      if (items.length >= MAX_ROWS) fail('WORKFLOW_ROW_LIMIT', 'output');
      inspectJson(item, budget);
      consume(budget, 1);
      items.push(item);
    },
    result(extra = {}) { return { items, count: items.length, ...extra }; }
  };
}

function mapping(value, label) {
  object(value, label);
  const entries = Object.entries(value);
  if (!entries.length || entries.length > MAX_FIELDS) fail('WORKFLOW_FIELDS_INVALID', label);
  for (const [key] of entries) safeKey(key);
  return entries;
}

function project(args) {
  const selected = Array.isArray(args.fields)
    ? fields(args.fields).map((field) => [typeof field === 'string' ? field : field.join('.'), field])
    : mapping(args.fields, 'fields');
  for (const [, source] of selected) pathParts(source);
  const output = collector();
  for (const item of rows(args.items)) output.add(Object.fromEntries(selected.map(([name, source]) => [name, at(item, source)])));
  return output.result();
}

function compileArithmetic(ast, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 128) fail('WORKFLOW_EXPRESSION_LIMIT');
  if (typeof ast === 'number') { const value = numeric(ast); return () => value; }
  object(ast, 'arithmetic-expression');
  const keys = Object.keys(ast);
  if (keys.length === 1 && keys[0] === 'field') {
    pathParts(ast.field);
    return (item) => numeric(at(item, ast.field), String(ast.field));
  }
  if (keys.length === 1 && keys[0] === 'value') {
    const value = numeric(ast.value, 'literal');
    return () => value;
  }
  const binary = new Set(['add', 'subtract', 'multiply', 'divide', 'modulo', 'min', 'max']);
  if (binary.has(ast.op)) {
    if (keys.some((key) => !['op', 'left', 'right'].includes(key))) fail('WORKFLOW_EXPRESSION_INVALID');
    const left = compileArithmetic(ast.left, depth + 1, budget);
    const right = compileArithmetic(ast.right, depth + 1, budget);
    return (item) => {
      const a = left(item); const b = right(item);
      if ((ast.op === 'divide' || ast.op === 'modulo') && b === 0) fail('WORKFLOW_DIVISION_BY_ZERO');
      const value = ast.op === 'add' ? a + b : ast.op === 'subtract' ? a - b
        : ast.op === 'multiply' ? a * b : ast.op === 'divide' ? a / b
          : ast.op === 'modulo' ? a % b : ast.op === 'min' ? Math.min(a, b) : Math.max(a, b);
      return numeric(value, ast.op);
    };
  }
  if (['abs', 'round', 'floor', 'ceil'].includes(ast.op)) {
    if (keys.some((key) => !['op', 'value', ...(ast.op === 'round' ? ['digits'] : [])].includes(key))) fail('WORKFLOW_EXPRESSION_INVALID');
    const value = compileArithmetic(ast.value, depth + 1, budget);
    const digits = ast.op === 'round' ? integer(ast.digits ?? 0, 'round.digits', 0, 8) : 0;
    return (item) => {
      const observed = value(item);
      if (ast.op !== 'round') return numeric(Math[ast.op](observed), ast.op);
      const factor = 10 ** digits;
      return numeric(Math.round(numeric(observed * factor, 'round-scaled')) / factor, 'round');
    };
  }
  fail('WORKFLOW_EXPRESSION_UNSUPPORTED', String(ast.op));
}

function derive(args) {
  const expressions = mapping(args.fields, 'fields').map(([name, ast]) => [name, compileArithmetic(ast)]);
  const output = collector();
  for (const item of rows(args.items)) {
    object(item, 'row');
    // Every expression observes the same input row, independent of mapping order.
    output.add({ ...item, ...Object.fromEntries(expressions.map(([name, evaluate]) => [name, evaluate(item)])) });
  }
  return output.result();
}

function flatten(args) {
  pathParts(args.field);
  const name = safeKey(args.as ?? (typeof args.field === 'string' ? args.field : args.field.join('.')));
  const output = collector();
  for (const item of rows(args.items)) {
    object(item, 'row');
    for (const value of rows(at(item, args.field), 'flatten.field')) output.add({ ...item, [name]: value });
  }
  return output.result();
}

function limit(args) {
  const count = integer(args.count, 'count');
  const offset = integer(args.offset ?? 0, 'offset');
  return { items: rows(args.items).slice(offset, offset + count), count: Math.max(0, Math.min(count, rows(args.items).length - offset)) };
}

function keyFor(item, keyFields) { return stable(keyFields.map((field) => at(item, field))); }

function union(args) {
  const others = args.others ?? [];
  if (!Array.isArray(others) || others.length > 64) fail('WORKFLOW_ARGUMENT_INVALID', 'others');
  const keys = args.keys === undefined ? null : fields(args.keys, 'keys');
  const seen = new Set();
  const output = collector();
  for (const source of [args.items, ...others]) {
    for (const item of rows(source)) {
      if (keys) {
        const key = keyFor(item, keys);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      output.add(item);
    }
  }
  return output.result();
}

function reconcile(args) {
  const keys = fields(args.keys, 'keys');
  const compared = args.fields === undefined ? null : fields(args.fields);
  const includeUnchanged = booleanOption(args.includeUnchanged, false, 'includeUnchanged');
  function index(source) {
    const map = new Map();
    for (const item of rows(source)) {
      object(item, 'row');
      if (compared) for (const field of compared) at(item, field);
      const key = keyFor(item, keys);
      if (map.has(key)) fail('WORKFLOW_RECONCILE_DUPLICATE_KEY', key);
      map.set(key, item);
    }
    return map;
  }
  const before = index(args.items); const after = index(args.other);
  const output = collector();
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(key) ?? null; const next = after.get(key) ?? null;
    const changedFields = previous && next
      ? (compared ?? [...new Set([...Object.keys(previous), ...Object.keys(next)])]).filter((field) => {
        const path = compared ? field : [field];
        return stable(at(previous, path, false)) !== stable(at(next, path, false));
      })
      : [];
    const status = previous === null ? 'added' : next === null ? 'removed' : changedFields.length ? 'changed' : 'unchanged';
    summary[status] += 1;
    if (status !== 'unchanged' || includeUnchanged) {
      output.add({ status, key: Object.fromEntries(keys.map((field) => [Array.isArray(field) ? field.join('.') : field, at(previous ?? next, field)])), before: previous, after: next, changedFields });
    }
  }
  return output.result({ summary });
}

function orderFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FIELDS) fail('WORKFLOW_ARGUMENT_INVALID', 'orderBy');
  return value.map((entry) => {
    const definition = typeof entry === 'string' ? { field: entry, order: 'asc' } : object(entry, 'orderBy');
    pathParts(definition.field);
    const order = definition.order ?? 'asc';
    if (!['asc', 'desc'].includes(order)) fail('WORKFLOW_ARGUMENT_INVALID', 'orderBy.order');
    return { field: definition.field, order };
  });
}

function scalarCompare(left, right) {
  if (!['string', 'number', 'boolean'].includes(typeof left) || typeof left !== typeof right) {
    fail('WORKFLOW_ORDER_TYPE_MISMATCH');
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function window(args) {
  const partitionBy = fields(args.partitionBy ?? [], 'partitionBy', true);
  const orderBy = orderFields(args.orderBy);
  const kind = args.kind ?? 'rowNumber';
  if (!['rowNumber', 'rank', 'denseRank', 'runningSum'].includes(kind)) fail('WORKFLOW_ARGUMENT_INVALID', 'window.kind');
  if (kind === 'runningSum') pathParts(args.valueField);
  const name = safeKey(args.as ?? kind);
  const groups = new Map();
  const compare = (a, b) => {
    for (const order of orderBy) {
      const result = scalarCompare(at(a, order.field), at(b, order.field));
      if (result) return order.order === 'desc' ? -result : result;
    }
    return 0;
  };
  for (const item of rows(args.items)) {
    object(item, 'row');
    // Validate singleton groups too: sorting alone would never invoke a comparator.
    for (const order of orderBy) scalarCompare(at(item, order.field), at(item, order.field));
    const key = keyFor(item, partitionBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const output = collector();
  for (const group of groups.values()) {
    group.sort(compare);
    let rank = 0; let denseRank = 0; let total = 0; let correction = 0;
    for (let index = 0; index < group.length; index += 1) {
      if (!index || compare(group[index - 1], group[index]) !== 0) { rank = index + 1; denseRank += 1; }
      if (kind === 'runningSum') {
        const value = numeric(at(group[index], args.valueField), String(args.valueField)) - correction;
        const next = numeric(total + value, 'runningSum');
        correction = (next - total) - value;
        total = next;
      }
      output.add({ ...group[index], [name]: kind === 'rank' ? rank : kind === 'denseRank' ? denseRank : kind === 'runningSum' ? total : index + 1 });
    }
  }
  return output.result();
}

function statistics(args) {
  pathParts(args.field);
  const values = rows(args.items).map((item) => numeric(at(item, args.field), String(args.field))).sort((a, b) => a - b);
  let sum = 0; let correction = 0;
  for (const value of values) {
    const adjusted = value - correction;
    const next = numeric(sum + adjusted, 'statistics.sum');
    correction = (next - sum) - adjusted;
    sum = next;
  }
  const count = values.length;
  const mean = count ? numeric(sum / count, 'statistics.mean') : null;
  let squared = 0;
  for (const value of values) squared = numeric(squared + (value - mean) ** 2, 'statistics.variance');
  const variance = count ? numeric(squared / count, 'statistics.variance') : null;
  const quantile = (fraction) => {
    if (!count) return null;
    const index = (count - 1) * fraction; const lower = Math.floor(index); const ratio = index - lower;
    return numeric(values[lower] * (1 - ratio) + values[Math.ceil(index)] * ratio, 'statistics.quantile');
  };
  const result = { count, min: count ? values[0] : null, max: count ? values.at(-1) : null, sum, mean, median: quantile(0.5), variance, stddev: count ? Math.sqrt(variance) : null, q1: quantile(0.25), q3: quantile(0.75) };
  return { items: [result], count: 1, statistics: result };
}

function transformTextFields(args, transform) {
  const selected = fields(args.fields);
  const output = collector();
  for (const item of rows(args.items)) {
    let changed = object(item, 'row');
    for (const field of selected) {
      const value = at(changed, field);
      if (value !== null && typeof value !== 'string') fail('WORKFLOW_TYPE_MISMATCH', `${field}-must-be-string-or-null`);
      changed = setAt(changed, field, value === null ? null : transform(value));
    }
    output.add(changed);
  }
  return output.result();
}

function normalize(args) {
  const trim = booleanOption(args.trim, true, 'trim');
  const nullEmpty = booleanOption(args.nullEmpty, false, 'nullEmpty');
  const letterCase = args.case ?? 'none';
  if (!['none', 'lower', 'upper'].includes(letterCase)) fail('WORKFLOW_ARGUMENT_INVALID', 'case');
  if (args.unicode !== undefined && !['NFC', 'NFKC'].includes(args.unicode)) fail('WORKFLOW_ARGUMENT_INVALID', 'unicode');
  return transformTextFields(args, (value) => {
    let text = args.unicode ? value.normalize(args.unicode) : value;
    if (trim) text = text.trim();
    if (letterCase === 'lower') text = text.toLowerCase();
    if (letterCase === 'upper') text = text.toUpperCase();
    return nullEmpty && !text.length ? null : text;
  });
}

function replace(args) {
  if (typeof args.search !== 'string' || !args.search.length || typeof args.replacement !== 'string') fail('WORKFLOW_ARGUMENT_INVALID', 'replace');
  return transformTextFields(args, (value) => {
    let count = 0; let offset = 0; let found;
    while ((found = value.indexOf(args.search, offset)) !== -1) { count += 1; offset = found + args.search.length; }
    if (value.length + count * (args.replacement.length - args.search.length) > MAX_BYTES) fail('WORKFLOW_DATA_BUDGET_EXCEEDED');
    // A replacement callback preserves literal dollar signs and match tokens.
    return value.replaceAll(args.search, () => args.replacement);
  });
}

function redact(args) {
  const patterns = {
    email: /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9](?:[A-Z0-9.-]{0,251}[A-Z0-9])?\.[A-Z]{2,63}(?![A-Z0-9-])/giu,
    phone: /(?<![\p{L}\p{N}])(?:\+\d{1,3}[- .]?)?(?:\(\d{2,4}\)|\d{2,4})[- .]?\d{3,4}[- .]?\d{4}(?![\p{L}\p{N}])/gu
  };
  if (!Object.hasOwn(patterns, args.preset)) fail('WORKFLOW_ARGUMENT_INVALID', 'redact.preset');
  const mask = args.mask ?? '[REDACTED]';
  if (typeof mask !== 'string' || mask.length > 256) fail('WORKFLOW_ARGUMENT_INVALID', 'redact.mask');
  return transformTextFields(args, (value) => {
    let resultLength = value.length;
    for (const match of value.matchAll(patterns[args.preset])) {
      resultLength += mask.length - match[0].length;
      if (resultLength > MAX_BYTES) fail('WORKFLOW_DATA_BUDGET_EXCEEDED');
    }
    return value.replace(patterns[args.preset], () => mask);
  });
}

/**
 * All operations return {items, count}. Numeric derivation/statistics use bounded
 * IEEE-754 values; exact financial amounts must use compute.ledger instead.
 * Dotted string paths prefer an exact own column, then nested traversal;
 * arrays explicitly traverse own properties. Unsafe parts always fail first.
 */
export function executeDataWorkflowOperation(op, args) {
  if (!supportedOperations.has(op)) fail('WORKFLOW_OPERATION_UNSUPPORTED', String(op));
  object(args, 'args');
  const input = inspectJson(args, { bytes: 0, values: 0 }, 0, new WeakSet(), true);
  const implementations = {
    'data.project': project, 'data.derive': derive, 'data.flatten': flatten,
    'data.limit': limit, 'data.union': union, 'data.reconcile': reconcile,
    'data.window': window, 'data.statistics': statistics, 'data.normalize': normalize,
    'text.replace': replace, 'text.redact': redact
  };
  const result = implementations[op](input);
  inspectJson(result, { bytes: 0, values: 0 });
  return result;
}
