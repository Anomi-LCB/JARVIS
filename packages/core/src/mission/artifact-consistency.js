import { createHash } from 'node:crypto';

const REQUIRED_KINDS = Object.freeze(['report', 'table', 'card']);
const MAX_FACTS_BYTES = 64 * 1024;

/**
 * Verifies bounded, typed facts shared by report/table/card outputs.
 * This verifies declared fact projections and provenance, not arbitrary prose semantics.
 */
export function verifyArtifactConsistency({ source, artifacts } = {}) {
  const checks = [];
  const sourceValid = isRecord(source) && typeof source.sourceId === 'string' && source.sourceId.length > 0
    && source.sourceId.length <= 200 && Number.isSafeInteger(source.revision) && source.revision >= 1
    && isRecord(source.facts);
  checks.push(check('source_contract_is_valid', sourceValid));
  if (!sourceValid) return result(checks, null);

  let canonicalFacts;
  try {
    canonicalFacts = canonicalJson(source.facts);
    if (Buffer.byteLength(canonicalFacts, 'utf8') > MAX_FACTS_BYTES) throw new Error('facts-too-large');
  } catch {
    checks.push(check('source_facts_are_bounded_json', false));
    return result(checks, null);
  }
  const sourceSha256 = createHash('sha256').update(canonicalFacts).digest('hex');
  checks.push(check('source_facts_are_bounded_json', true));
  checks.push(check('source_digest_matches_canonical_facts', source.digest === sourceSha256));

  const normalized = Array.isArray(artifacts) ? artifacts : [];
  const ids = normalized.map(item => item?.artifactId);
  const kinds = normalized.map(item => item?.kind);
  checks.push(check('exact_report_table_card_set', normalized.length === REQUIRED_KINDS.length
    && REQUIRED_KINDS.every(kind => kinds.filter(value => value === kind).length === 1)));
  checks.push(check('artifact_ids_are_unique', ids.every(id => typeof id === 'string' && id.length > 0)
    && new Set(ids).size === ids.length));

  let allProjectionValid = normalized.length === REQUIRED_KINDS.length;
  let allRevisionValid = allProjectionValid;
  let allFactsEqual = allProjectionValid;
  for (const artifact of normalized) {
    const projectionValid = isRecord(artifact) && typeof artifact.artifactId === 'string'
      && REQUIRED_KINDS.includes(artifact.kind) && isRecord(artifact.sourceRef) && isRecord(artifact.facts);
    allProjectionValid &&= projectionValid;
    if (!projectionValid) { allRevisionValid = false; allFactsEqual = false; continue; }
    allRevisionValid &&= artifact.sourceRef.sourceId === source.sourceId
      && artifact.sourceRef.revision === source.revision && artifact.sourceRef.digest === sourceSha256;
    try { allFactsEqual &&= canonicalJson(artifact.facts) === canonicalFacts; }
    catch { allFactsEqual = false; }
  }
  checks.push(check('every_artifact_has_typed_contract', allProjectionValid));
  checks.push(check('every_artifact_binds_current_source_revision', allRevisionValid));
  checks.push(check('report_table_card_facts_match_source', allFactsEqual));
  return result(checks, { sourceId: source.sourceId, revision: source.revision, sourceSha256,
    artifactCount: normalized.length, kinds: [...kinds].sort() });
}

export function canonicalJson(value) {
  const seen = new Set();
  const visit = (item, depth) => {
    if (depth > 12) throw new TypeError('json-depth-exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      if (typeof item === 'string' && item.length > 20_000) throw new TypeError('string-too-large');
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('non-finite-number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('non-json-value');
    if (seen.has(item)) throw new TypeError('cyclic-json');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 1000) throw new TypeError('array-too-large');
        const descriptors = Object.getOwnPropertyDescriptors(item);
        if (Reflect.ownKeys(item).length !== item.length + 1) throw new TypeError('extended-array');
        const entries = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid-array-item');
          entries.push(visit(descriptor.value, depth + 1));
        }
        return `[${entries.join(',')}]`;
      }
      if (!isRecord(item)) throw new TypeError('non-plain-object');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(descriptors).sort();
      if (keys.length > 500 || keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new TypeError('unsafe-json-key');
      return `{${keys.map(key => {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('accessor-json-value');
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    } finally { seen.delete(item); }
  };
  return visit(value, 0);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function check(id, passed) { return { id, status: passed ? 'passed' : 'failed' }; }
function result(checks, source) { return { status: checks.every(item => item.status === 'passed') ? 'passed' : 'failed', checks, source }; }
