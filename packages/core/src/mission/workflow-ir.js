const workflowSchemaVersion = 'jarvis-local-workflow-v1';
const maximumWorkflowNodes = 64;
const maximumValueDepth = 40;
const dangerousPropertyNames = new Set(['__proto__', 'prototype', 'constructor']);
const expectedTypes = new Set([
  'any',
  'null',
  'boolean',
  'number',
  'integer',
  'string',
  'array',
  'object'
]);

export const WORKFLOW_SCHEMA_VERSION = workflowSchemaVersion;
export const MAXIMUM_WORKFLOW_NODES = maximumWorkflowNodes;
export const SUPPORTED_WORKFLOW_OPERATIONS = Object.freeze([
  'data.readJson',
  'data.readCsv',
  'text.read',
  'text.extractFields',
  'financial.ofxReport', 'financial.report', 'health.report', 'theology.review', 'safety.simulation',
  'data.filter',
  'data.sort',
  'data.unique',
  'data.groupAggregate',
  'data.join',
  'data.pivot',
  'data.validate',
  'data.project',
  'data.derive',
  'data.flatten',
  'data.limit',
  'data.union',
  'data.reconcile',
  'data.window',
  'data.statistics',
  'data.normalize',
  'text.replace',
  'text.redact',
  'compute.ledger',
  'compute.units',
  'compute.compareChange',
  'graph.toposort',
  'graph.shortestPath',
  'graph.criticalPath',
  'solver.knapsack',
  'solver.schedule',
  'fs.inventory',
  'fs.search',
  'fs.duplicates',
  'text.stats',
  'template.renderMany',
  'process.run',
  'process.pipeline',
  'sqlite.import',
  'sqlite.query',
  'write.json',
  'write.csv',
  'write.text',
  'assert.count',
  'assert.equals'
]);

const supportedOperations = new Set(SUPPORTED_WORKFLOW_OPERATIONS);

export class WorkflowValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.code = code;
    this.details = details;
  }
}

export function validateWorkflowSpec(spec) {
  assertPlainObject(spec, 'workflow spec');
  assertKnownKeys(
    spec,
    new Set(['schemaVersion', 'workflowId', 'description', 'nodes', 'outputs']),
    'workflow spec'
  );
  if (spec.schemaVersion !== workflowSchemaVersion) {
    throw workflowError(
      'A_WORKFLOW_SCHEMA_UNSUPPORTED',
      `schemaVersion must be ${workflowSchemaVersion}.`,
      { observed: spec.schemaVersion ?? null }
    );
  }

  const workflowId = validateIdentifier(spec.workflowId, 'workflowId');
  if (!Array.isArray(spec.nodes) || spec.nodes.length < 1) {
    throw workflowError('A_WORKFLOW_NODES_REQUIRED', 'nodes must be a non-empty array.');
  }
  if (spec.nodes.length > maximumWorkflowNodes) {
    throw workflowError(
      'A_WORKFLOW_NODE_LIMIT',
      `A workflow may contain at most ${maximumWorkflowNodes} nodes.`,
      { observed: spec.nodes.length, maximum: maximumWorkflowNodes }
    );
  }

  const normalizedNodes = spec.nodes.map((node, index) => normalizeNode(node, index));
  const nodeIds = new Set();
  for (const node of normalizedNodes) {
    if (nodeIds.has(node.id)) {
      throw workflowError(
        'A_WORKFLOW_NODE_DUPLICATE',
        `Duplicate workflow node id: ${node.id}`,
        { nodeId: node.id }
      );
    }
    nodeIds.add(node.id);
  }

  for (const node of normalizedNodes) {
    for (const dependencyId of node.dependsOn) {
      if (!nodeIds.has(dependencyId)) {
        throw workflowError(
          'A_WORKFLOW_DEPENDENCY_UNKNOWN',
          `Node ${node.id} depends on unknown node ${dependencyId}.`,
          { nodeId: node.id, dependencyId }
        );
      }
      if (dependencyId === node.id) {
        throw workflowError(
          'A_WORKFLOW_DEPENDENCY_CYCLE',
          `Node ${node.id} cannot depend on itself.`,
          { nodeId: node.id }
        );
      }
    }
  }

  buildTopologicalWaves(normalizedNodes);
  validateReferenceDependencies(normalizedNodes, nodeIds);

  const normalized = {
    schemaVersion: workflowSchemaVersion,
    workflowId,
    nodes: normalizedNodes,
    outputs: normalizeDeclaredOutputs(spec.outputs, nodeIds)
  };
  if (spec.description !== undefined) {
    if (
      typeof spec.description !== 'string'
      || spec.description.length > 2_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(spec.description)
    ) {
      throw workflowError(
        'A_WORKFLOW_DESCRIPTION_INVALID',
        'description must be a string of at most 2000 characters without control characters.'
      );
    }
    normalized.description = spec.description;
  }
  return normalized;
}

export function topologicalWaves(spec) {
  const normalized = validateWorkflowSpec(spec);
  return buildTopologicalWaves(normalized.nodes);
}

export function resolveWorkflowValue(value, outputs) {
  return resolveValue(value, outputs, '$', 0, new WeakSet());
}

function normalizeNode(node, index) {
  assertPlainObject(node, `nodes[${index}]`);
  assertKnownKeys(
    node,
    new Set(['id', 'op', 'dependsOn', 'args', 'when', 'retry']),
    `nodes[${index}]`
  );
  const id = validateIdentifier(node.id, `nodes[${index}].id`);
  if (typeof node.op !== 'string' || !supportedOperations.has(node.op)) {
    throw workflowError(
      'A_WORKFLOW_OPERATION_UNSUPPORTED',
      `Unsupported operation on node ${id}: ${String(node.op ?? '')}`,
      { nodeId: id, operation: node.op ?? null }
    );
  }

  const dependsOn = node.dependsOn === undefined ? [] : normalizeDependencies(node.dependsOn, id);
  const args = node.args === undefined
    ? {}
    : normalizeJsonValue(node.args, `nodes[${index}].args`, 0, new WeakSet());
  if (!isPlainObject(args) || isReferenceObject(args)) {
    throw workflowError(
      'A_WORKFLOW_ARGUMENTS_INVALID',
      `Node ${id} args must be an object.`,
      { nodeId: id }
    );
  }

  const normalized = { id, op: node.op, dependsOn, args };
  if (node.when !== undefined) {
    if (typeof node.when !== 'boolean' && !isReferenceObject(node.when)) {
      throw workflowError(
        'A_WORKFLOW_CONDITION_INVALID',
        `Node ${id} when must be a boolean or one typed reference.`,
        { nodeId: id }
      );
    }
    normalized.when = normalizeJsonValue(node.when, `nodes[${index}].when`, 0, new WeakSet());
    if (isReferenceObject(normalized.when)) {
      const type = normalized.when.$ref.expectedType;
      if (type && type !== 'boolean' && type !== 'any') {
        throw workflowError(
          'A_WORKFLOW_CONDITION_INVALID',
          `Node ${id} when reference must expect a boolean.`,
          { nodeId: id, expectedType: type }
        );
      }
    }
  }
  if (node.retry !== undefined) normalized.retry = normalizeRetry(node.retry, id);
  return normalized;
}

function normalizeDependencies(value, nodeId) {
  if (!Array.isArray(value)) {
    throw workflowError(
      'A_WORKFLOW_DEPENDENCIES_INVALID',
      `Node ${nodeId} dependsOn must be an array.`,
      { nodeId }
    );
  }
  const seen = new Set();
  return value.map((dependencyId, index) => {
    const normalized = validateIdentifier(dependencyId, `${nodeId}.dependsOn[${index}]`);
    if (seen.has(normalized)) {
      throw workflowError(
        'A_WORKFLOW_DEPENDENCY_DUPLICATE',
        `Node ${nodeId} repeats dependency ${normalized}.`,
        { nodeId, dependencyId: normalized }
      );
    }
    seen.add(normalized);
    return normalized;
  });
}

function normalizeRetry(value, nodeId) {
  assertPlainObject(value, `${nodeId}.retry`);
  assertKnownKeys(value, new Set(['maxAttempts', 'backoffMs']), `${nodeId}.retry`);
  const maxAttempts = value.maxAttempts ?? 1;
  const backoffMs = value.backoffMs ?? 0;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw workflowError(
      'A_WORKFLOW_RETRY_INVALID',
      `Node ${nodeId} retry.maxAttempts must be an integer from 1 to 5.`,
      { nodeId, observed: maxAttempts }
    );
  }
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 30_000) {
    throw workflowError(
      'A_WORKFLOW_RETRY_INVALID',
      `Node ${nodeId} retry.backoffMs must be an integer from 0 to 30000.`,
      { nodeId, observed: backoffMs }
    );
  }
  return { maxAttempts, backoffMs };
}

function normalizeDeclaredOutputs(value, nodeIds) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumWorkflowNodes) {
    throw workflowError(
      'A_WORKFLOW_OUTPUTS_INVALID',
      `outputs must be an array containing at most ${maximumWorkflowNodes} entries.`
    );
  }
  const paths = new Set();
  return value.map((output, index) => {
    const location = `outputs[${index}]`;
    assertPlainObject(output, location);
    assertKnownKeys(output, new Set(['nodeId', 'path', 'mediaType']), location);
    const nodeId = validateIdentifier(output.nodeId, `${location}.nodeId`);
    if (!nodeIds.has(nodeId)) {
      throw workflowError(
        'A_WORKFLOW_OUTPUT_NODE_UNKNOWN',
        `${location} refers to unknown node ${nodeId}.`,
        { nodeId, location }
      );
    }
    const path = normalizeDeclaredOutputPath(output.path, location);
    const pathKey = process.platform === 'win32' ? path.toLocaleLowerCase() : path;
    if (paths.has(pathKey)) {
      throw workflowError(
        'A_WORKFLOW_OUTPUT_DUPLICATE',
        `Duplicate declared output path: ${path}`,
        { path, location }
      );
    }
    paths.add(pathKey);
    const normalized = { nodeId, path };
    if (output.mediaType !== undefined) {
      if (
        typeof output.mediaType !== 'string'
        || output.mediaType.length < 3
        || output.mediaType.length > 160
        || !/^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+(?:\s*;\s*[a-z\d!#$&^_.+-]+=[a-z\d!#$&^_.+:-]+)*$/iu.test(output.mediaType)
      ) {
        throw workflowError(
          'A_WORKFLOW_OUTPUT_MEDIA_TYPE_INVALID',
          `${location}.mediaType is invalid.`,
          { location }
        );
      }
      normalized.mediaType = output.mediaType;
    }
    return normalized;
  });
}

function normalizeDeclaredOutputPath(value, location) {
  if (typeof value !== 'string') {
    throw workflowError('A_WORKFLOW_OUTPUT_PATH_INVALID', `${location}.path must be a string.`, { location });
  }
  const path = value.trim().replace(/\\/gu, '/');
  const segments = path.split('/');
  if (
    path.length < 1
    || path.length > 1_024
    || path.startsWith('/')
    || /^[a-z]:\//iu.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw workflowError(
      'A_WORKFLOW_OUTPUT_PATH_INVALID',
      `${location}.path must be a safe workspace-relative file path.`,
      { location }
    );
  }
  return path;
}

function normalizeJsonValue(value, location, depth, visiting) {
  if (depth > maximumValueDepth) {
    throw workflowError(
      'A_WORKFLOW_VALUE_DEPTH_LIMIT',
      `Workflow value exceeds the maximum nesting depth at ${location}.`,
      { location, maximum: maximumValueDepth }
    );
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw workflowError('A_WORKFLOW_VALUE_INVALID', `Non-finite number at ${location}.`, { location });
  }
  if (typeof value !== 'object') {
    throw workflowError(
      'A_WORKFLOW_VALUE_INVALID',
      `Only JSON values and typed references are allowed at ${location}.`,
      { location, observedType: typeof value }
    );
  }
  if (visiting.has(value)) {
    throw workflowError('A_WORKFLOW_VALUE_CYCLE', `Circular value at ${location}.`, { location });
  }

  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, `${location}[${index}]`, depth + 1, visiting));
    }
    assertPlainObject(value, location);
    if (Object.hasOwn(value, '$ref')) return normalizeReferenceObject(value, location);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      assertSafePropertyName(key, location);
      result[key] = normalizeJsonValue(item, `${location}.${key}`, depth + 1, visiting);
    }
    return result;
  } finally {
    visiting.delete(value);
  }
}

function normalizeReferenceObject(value, location) {
  assertKnownKeys(value, new Set(['$ref']), location);
  const descriptor = value.$ref;
  assertPlainObject(descriptor, `${location}.$ref`);
  assertKnownKeys(descriptor, new Set(['nodeId', 'pointer', 'expectedType']), `${location}.$ref`);
  const nodeId = validateIdentifier(descriptor.nodeId, `${location}.$ref.nodeId`);
  const pointer = descriptor.pointer === undefined ? '' : validateJsonPointer(descriptor.pointer, location);
  const result = { nodeId };
  if (pointer) result.pointer = pointer;
  if (descriptor.expectedType !== undefined) {
    if (typeof descriptor.expectedType !== 'string' || !expectedTypes.has(descriptor.expectedType)) {
      throw workflowError(
        'A_WORKFLOW_REFERENCE_INVALID',
        `Unsupported expectedType at ${location}.`,
        { location, expectedType: descriptor.expectedType }
      );
    }
    result.expectedType = descriptor.expectedType;
  }
  return { $ref: result };
}

function validateJsonPointer(value, location) {
  if (typeof value !== 'string' || (value !== '' && !value.startsWith('/'))) {
    throw workflowError(
      'A_WORKFLOW_REFERENCE_INVALID',
      `Reference pointer at ${location} must be an RFC 6901 JSON Pointer.`,
      { location }
    );
  }
  if (/~(?:[^01]|$)/u.test(value)) {
    throw workflowError(
      'A_WORKFLOW_REFERENCE_INVALID',
      `Reference pointer at ${location} contains an invalid escape.`,
      { location }
    );
  }
  for (const segment of decodePointer(value)) {
    if (dangerousPropertyNames.has(segment)) {
      throw workflowError(
        'A_WORKFLOW_REFERENCE_UNSAFE',
        `Reference pointer at ${location} accesses a forbidden property.`,
        { location, segment }
      );
    }
  }
  return value;
}

function validateReferenceDependencies(nodes, nodeIds) {
  const dependenciesById = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const ancestorsById = new Map();
  const ancestorsFor = (nodeId) => {
    if (ancestorsById.has(nodeId)) return ancestorsById.get(nodeId);
    const ancestors = new Set();
    for (const dependencyId of dependenciesById.get(nodeId) ?? []) {
      ancestors.add(dependencyId);
      for (const ancestorId of ancestorsFor(dependencyId)) ancestors.add(ancestorId);
    }
    ancestorsById.set(nodeId, ancestors);
    return ancestors;
  };

  for (const node of nodes) {
    const references = [
      ...collectReferences(node.args, `${node.id}.args`),
      ...collectReferences(node.when, `${node.id}.when`)
    ];
    const ancestors = ancestorsFor(node.id);
    for (const reference of references) {
      if (!nodeIds.has(reference.nodeId)) {
        throw workflowError(
          'A_WORKFLOW_REFERENCE_UNKNOWN',
          `Node ${node.id} references unknown node ${reference.nodeId}.`,
          { nodeId: node.id, referenceNodeId: reference.nodeId, location: reference.location }
        );
      }
      if (!ancestors.has(reference.nodeId)) {
        throw workflowError(
          'A_WORKFLOW_REFERENCE_UNSAFE',
          `Node ${node.id} may reference only declared predecessor outputs.`,
          { nodeId: node.id, referenceNodeId: reference.nodeId, location: reference.location }
        );
      }
    }
  }
}

function collectReferences(value, location, result = []) {
  if (value === undefined || value === null || typeof value !== 'object') return result;
  if (isReferenceObject(value)) {
    result.push({ ...value.$ref, location });
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReferences(item, `${location}[${index}]`, result));
    return result;
  }
  for (const [key, item] of Object.entries(value)) collectReferences(item, `${location}.${key}`, result);
  return result;
}

function buildTopologicalWaves(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const remainingDependencies = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  const emitted = new Set();
  const waves = [];

  while (emitted.size < nodes.length) {
    const ready = nodes.filter((node) => (
      !emitted.has(node.id) && remainingDependencies.get(node.id).size === 0
    ));
    if (ready.length === 0) {
      const cycleNodeIds = nodes.filter((node) => !emitted.has(node.id)).map((node) => node.id);
      throw workflowError(
        'A_WORKFLOW_DEPENDENCY_CYCLE',
        'Workflow dependencies contain a cycle.',
        { nodeIds: cycleNodeIds }
      );
    }
    waves.push(ready.map((node) => node));
    for (const node of ready) emitted.add(node.id);
    for (const [nodeId, dependencies] of remainingDependencies) {
      if (emitted.has(nodeId)) continue;
      for (const node of ready) dependencies.delete(node.id);
    }
  }
  return waves;
}

function resolveValue(value, outputs, location, depth, visiting) {
  if (depth > maximumValueDepth) {
    throw workflowError(
      'B_WORKFLOW_VALUE_DEPTH_LIMIT',
      `Resolved workflow value exceeds the maximum nesting depth at ${location}.`,
      { location, maximum: maximumValueDepth }
    );
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw workflowError('B_WORKFLOW_VALUE_INVALID', `Non-finite number at ${location}.`, { location });
  }
  if (typeof value !== 'object') {
    throw workflowError('B_WORKFLOW_VALUE_INVALID', `Invalid value at ${location}.`, { location });
  }
  if (visiting.has(value)) {
    throw workflowError('B_WORKFLOW_VALUE_CYCLE', `Circular value at ${location}.`, { location });
  }

  visiting.add(value);
  try {
    if (isReferenceObject(value)) return resolveReference(value, outputs, location);
    if (Array.isArray(value)) {
      return value.map((item, index) => resolveValue(item, outputs, `${location}[${index}]`, depth + 1, visiting));
    }
    assertPlainObject(value, location, 'B_WORKFLOW_VALUE_INVALID');
    if (Object.hasOwn(value, '$ref')) normalizeReferenceObject(value, location);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      assertSafePropertyName(key, location, 'B_WORKFLOW_VALUE_INVALID');
      result[key] = resolveValue(item, outputs, `${location}.${key}`, depth + 1, visiting);
    }
    return result;
  } finally {
    visiting.delete(value);
  }
}

function resolveReference(referenceObject, outputs, location) {
  const reference = normalizeReferenceObject(referenceObject, location).$ref;
  const output = readOutput(outputs, reference.nodeId, location);
  let resolved = output;
  for (const segment of decodePointer(reference.pointer ?? '')) {
    if (dangerousPropertyNames.has(segment) || resolved === null || typeof resolved !== 'object') {
      throw unresolvedReference(reference, location);
    }
    if (Array.isArray(resolved)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) throw unresolvedReference(reference, location);
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= resolved.length) throw unresolvedReference(reference, location);
      resolved = resolved[index];
      continue;
    }
    if (!Object.hasOwn(resolved, segment)) throw unresolvedReference(reference, location);
    resolved = resolved[segment];
  }
  if (resolved === undefined) throw unresolvedReference(reference, location);
  assertExpectedType(resolved, reference.expectedType, reference, location);
  return cloneResolvedValue(resolved, location, 0, new WeakSet());
}

function readOutput(outputs, nodeId, location) {
  if (outputs instanceof Map) {
    if (!outputs.has(nodeId)) throw unresolvedReference({ nodeId, pointer: '' }, location);
    return outputs.get(nodeId);
  }
  if (!outputs || typeof outputs !== 'object' || !Object.hasOwn(outputs, nodeId)) {
    throw unresolvedReference({ nodeId, pointer: '' }, location);
  }
  return outputs[nodeId];
}

function assertExpectedType(value, expectedType, reference, location) {
  if (!expectedType || expectedType === 'any') return;
  const actualType = workflowValueType(value);
  const matches = expectedType === 'integer'
    ? Number.isInteger(value)
    : actualType === expectedType;
  if (!matches) {
    throw workflowError(
      'B_WORKFLOW_REFERENCE_TYPE_MISMATCH',
      `Reference ${reference.nodeId}${reference.pointer ?? ''} expected ${expectedType} but received ${actualType}.`,
      { location, nodeId: reference.nodeId, pointer: reference.pointer ?? '', expectedType, actualType }
    );
  }
}

function cloneResolvedValue(value, location, depth, visiting) {
  if (depth > maximumValueDepth) {
    throw workflowError('B_WORKFLOW_VALUE_DEPTH_LIMIT', `Output is too deeply nested at ${location}.`, { location });
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') {
    throw workflowError('B_WORKFLOW_VALUE_INVALID', `Referenced output is not JSON-safe at ${location}.`, { location });
  }
  if (visiting.has(value)) {
    throw workflowError('B_WORKFLOW_VALUE_CYCLE', `Referenced output is circular at ${location}.`, { location });
  }
  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneResolvedValue(item, `${location}[${index}]`, depth + 1, visiting));
    }
    if (!isPlainObject(value)) {
      throw workflowError('B_WORKFLOW_VALUE_INVALID', `Referenced output is not a JSON object at ${location}.`, { location });
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      assertSafePropertyName(key, location, 'B_WORKFLOW_VALUE_INVALID');
      result[key] = cloneResolvedValue(item, `${location}.${key}`, depth + 1, visiting);
    }
    return result;
  } finally {
    visiting.delete(value);
  }
}

function decodePointer(pointer) {
  if (!pointer) return [];
  return pointer.slice(1).split('/').map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
}

function unresolvedReference(reference, location) {
  return workflowError(
    'B_WORKFLOW_REFERENCE_UNRESOLVED',
    `Could not resolve workflow reference ${reference.nodeId}${reference.pointer ?? ''}.`,
    { location, nodeId: reference.nodeId, pointer: reference.pointer ?? '' }
  );
}

function workflowValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateIdentifier(value, location) {
  if (typeof value !== 'string') {
    throw workflowError('A_WORKFLOW_IDENTIFIER_INVALID', `${location} must be a string.`, { location });
  }
  const normalized = value.normalize('NFKC').trim();
  if (
    normalized.length < 1
    || normalized.length > 128
    || /[\u0000-\u001f\u007f\s/\\]/u.test(normalized)
    || dangerousPropertyNames.has(normalized)
  ) {
    throw workflowError(
      'A_WORKFLOW_IDENTIFIER_INVALID',
      `${location} is not a safe workflow identifier.`,
      { location }
    );
  }
  return normalized;
}

function assertPlainObject(value, location, code = 'A_WORKFLOW_SPEC_INVALID') {
  if (!isPlainObject(value)) {
    throw workflowError(code, `${location} must be an object.`, { location });
  }
}

function assertKnownKeys(value, allowedKeys, location) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw workflowError(
      'A_WORKFLOW_UNKNOWN_FIELD',
      `${location} contains unsupported fields: ${unknown.join(', ')}`,
      { location, fields: unknown }
    );
  }
}

function assertSafePropertyName(key, location, code = 'A_WORKFLOW_VALUE_INVALID') {
  if (dangerousPropertyNames.has(key)) {
    throw workflowError(code, `Forbidden property ${key} at ${location}.`, { location, property: key });
  }
}

function isReferenceObject(value) {
  return isPlainObject(value) && Object.hasOwn(value, '$ref') && Object.keys(value).length === 1;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function workflowError(code, message, details = {}) {
  return new WorkflowValidationError(code, message, details);
}
