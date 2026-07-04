import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export const defaultPolicyPath = 'apps/policy-security/policies/e/default-policy.json';

export class PolicyAsCodeCompiler {
  constructor({
    policyPath = defaultPolicyPath,
    signingSecret = process.env.JARVIS_POLICY_BUNDLE_SECRET ?? 'jarvis-local-policy-bundle-secret'
  } = {}) {
    this.policyPath = policyPath ?? defaultPolicyPath;
    this.signingSecret = signingSecret;
  }

  load(options = {}) {
    const sourcePath = typeof options === 'string' ? options : (options.path ?? this.policyPath);
    const format = typeof options === 'object' ? options.format : null;
    return this.parseSource(readFileSync(sourcePath, 'utf8'), {
      format: format ?? formatFromPath(sourcePath)
    });
  }

  parseSource(source, { format = 'json' } = {}) {
    const normalizedFormat = String(format ?? 'json').toLowerCase();
    if (['yaml', 'yml'].includes(normalizedFormat)) {
      return parsePolicyYaml(source);
    }
    return JSON.parse(source);
  }

  toYaml(manifest = this.load()) {
    return stringifyPolicyYaml(manifest);
  }

  compile(manifest = this.load()) {
    const validation = this.validate(manifest);
    if (!validation.valid) {
      return { success: false, error: { code: 'E_POLICY_AS_CODE_INVALID', issues: validation.issues } };
    }
    return {
      success: true,
      policyVersion: manifest.policyVersion,
      schemaVersion: manifest.schemaVersion,
      constitution: manifest.constitution,
      constitutionHash: hashPolicySection(manifest.constitution),
      risk: {
        forbiddenActions: new Set(manifest.risk.forbiddenActions),
        tiersByAction: new Map(Object.entries(manifest.risk.tiersByAction))
      },
      dataRules: manifest.dataRules.map((rule) => ({
        ...rule,
        regex: new RegExp(rule.pattern, 'i')
      })),
      approval: manifest.approval,
      capability: manifest.capability,
      toolPoisoning: {
        ...manifest.toolPoisoning,
        blockedInstructionRegexes: manifest.toolPoisoning.blockedInstructionPatterns.map((pattern) => new RegExp(pattern, 'i'))
      },
      promptInjection: {
        ...manifest.promptInjection,
        blockedRegexes: manifest.promptInjection.blockedPatterns.map((rule) => ({
          ...rule,
          regex: new RegExp(rule.pattern, 'i')
        }))
      },
      autonomy: manifest.autonomy,
      manifest
    };
  }

  createSignedBundle(manifest = this.load(), { reason = 'manual_bundle', createdAt = new Date().toISOString() } = {}) {
    const compiled = this.compile(manifest);
    if (!compiled.success) return compiled;
    const bundleBase = {
      bundleSchemaVersion: 'e-policy-bundle-v1',
      policyVersion: manifest.policyVersion,
      schemaVersion: manifest.schemaVersion,
      createdAt,
      reason,
      manifestHash: hashPolicySection(manifest),
      constitutionHash: compiled.constitutionHash,
      manifest
    };
    const bundleHash = hashPolicySection(bundleBase);
    return {
      success: true,
      bundle: {
        ...bundleBase,
        bundleHash,
        signatureAlgorithm: 'HMAC-SHA256',
        signature: signBundleHash(bundleHash, this.signingSecret)
      }
    };
  }

  verifySignedBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return { valid: false, reason: 'bundle_missing' };
    const { signature, signatureAlgorithm, bundleHash, ...unsigned } = bundle;
    if (signatureAlgorithm !== 'HMAC-SHA256') return { valid: false, reason: 'unsupported_signature_algorithm' };
    const expectedBundleHash = hashPolicySection(unsigned);
    if (expectedBundleHash !== bundleHash) {
      return { valid: false, reason: 'bundle_hash_mismatch', expectedBundleHash, bundleHash };
    }
    const expectedManifestHash = hashPolicySection(bundle.manifest);
    if (expectedManifestHash !== bundle.manifestHash) {
      return { valid: false, reason: 'manifest_hash_mismatch', expectedManifestHash, manifestHash: bundle.manifestHash };
    }
    const expectedSignature = signBundleHash(bundleHash, this.signingSecret);
    if (expectedSignature !== signature) return { valid: false, reason: 'signature_mismatch' };
    return {
      valid: true,
      policyVersion: bundle.policyVersion,
      schemaVersion: bundle.schemaVersion,
      bundleHash,
      manifestHash: bundle.manifestHash,
      constitutionHash: bundle.constitutionHash
    };
  }

  compileSignedBundle(bundle) {
    const verification = this.verifySignedBundle(bundle);
    if (!verification.valid) {
      return { success: false, error: { code: 'E_POLICY_BUNDLE_SIGNATURE_INVALID', verification } };
    }
    const compiled = this.compile(bundle.manifest);
    if (!compiled.success) return compiled;
    return {
      ...compiled,
      signedBundle: bundle,
      bundle: {
        ...verification,
        signature: bundle.signature,
        signatureAlgorithm: bundle.signatureAlgorithm,
        createdAt: bundle.createdAt,
        reason: bundle.reason
      }
    };
  }

  externalJsonSchema() {
    return {
      schemaVersion: 'e-policy-json-schema-v1',
      $id: 'https://jarvis.local/schemas/e-policy-schema-v1.json',
      type: 'object',
      required: [
        'policyVersion',
        'schemaVersion',
        'constitution',
        'risk',
        'dataRules',
        'approval',
        'capability',
        'toolPoisoning',
        'promptInjection',
        'autonomy'
      ],
      properties: {
        policyVersion: { type: 'string', minLength: 1 },
        schemaVersion: { const: 'e-policy-schema-v1' },
        constitution: {
          type: 'object',
          required: ['principles'],
          properties: { principles: { type: 'array', minItems: 1, items: { type: 'string' } } }
        },
        risk: {
          type: 'object',
          required: ['forbiddenActions', 'tiersByAction'],
          properties: {
            forbiddenActions: { type: 'array', minItems: 1, items: { type: 'string' } },
            tiersByAction: { type: 'object' }
          }
        },
        dataRules: { type: 'array', minItems: 1 },
        approval: { type: 'object', required: ['tiers'] },
        capability: { type: 'object' },
        toolPoisoning: { type: 'object' },
        promptInjection: { type: 'object' },
        autonomy: { type: 'object' }
      }
    };
  }

  validateAgainstExternalJsonSchema(manifest = this.load(), schema = this.externalJsonSchema()) {
    const issues = [];
    for (const key of schema.required ?? []) {
      if (manifest?.[key] == null) issues.push({ path: key, code: 'schema_required' });
    }
    if (schema.properties?.schemaVersion?.const && manifest?.schemaVersion !== schema.properties.schemaVersion.const) {
      issues.push({ path: 'schemaVersion', code: 'schema_const_mismatch', expected: schema.properties.schemaVersion.const, actual: manifest?.schemaVersion });
    }
    if (!Array.isArray(manifest?.constitution?.principles) || manifest.constitution.principles.length === 0) {
      issues.push({ path: 'constitution.principles', code: 'schema_min_items' });
    }
    if (!Array.isArray(manifest?.risk?.forbiddenActions) || manifest.risk.forbiddenActions.length === 0) {
      issues.push({ path: 'risk.forbiddenActions', code: 'schema_min_items' });
    }
    if (!manifest?.risk?.tiersByAction || typeof manifest.risk.tiersByAction !== 'object') {
      issues.push({ path: 'risk.tiersByAction', code: 'schema_required_object' });
    }
    if (!Array.isArray(manifest?.dataRules) || manifest.dataRules.length === 0) {
      issues.push({ path: 'dataRules', code: 'schema_min_items' });
    }
    if (!manifest?.approval?.tiers || typeof manifest.approval.tiers !== 'object') {
      issues.push({ path: 'approval.tiers', code: 'schema_required_object' });
    }
    const compilerValidation = this.validate(manifest);
    return {
      schemaValidationVersion: 'e-policy-external-json-schema-validation-v1',
      schemaVersion: schema.schemaVersion,
      valid: issues.length === 0 && compilerValidation.valid,
      issueCount: issues.length + compilerValidation.issues.length,
      issues: [...issues, ...compilerValidation.issues]
    };
  }

  migrationSnapshot(manifest = this.load(), { label = 'current' } = {}) {
    return {
      snapshotVersion: 'e-policy-migration-snapshot-v1',
      label,
      policyVersion: manifest.policyVersion,
      schemaVersion: manifest.schemaVersion,
      manifestHash: hashPolicySection(manifest),
      constitutionHash: hashPolicySection(manifest.constitution),
      risk: {
        forbiddenActions: [...(manifest.risk?.forbiddenActions ?? [])].sort(),
        tiersByAction: Object.fromEntries(Object.entries(manifest.risk?.tiersByAction ?? {}).sort(([left], [right]) => left.localeCompare(right)))
      },
      approval: {
        tiers: Object.fromEntries(Object.entries(manifest.approval?.tiers ?? {}).sort(([left], [right]) => left.localeCompare(right))),
        mobileTier4Allowed: manifest.approval?.mobileTier4Allowed === true
      },
      dataRuleIds: (manifest.dataRules ?? []).map((rule) => rule.id).sort(),
      promptPatternIds: (manifest.promptInjection?.blockedPatterns ?? []).map((rule) => rule.id).sort()
    };
  }

  diffMigrationSnapshots(before, after) {
    const beforeSnapshot = before?.snapshotVersion === 'e-policy-migration-snapshot-v1' ? before : this.migrationSnapshot(before, { label: 'before' });
    const afterSnapshot = after?.snapshotVersion === 'e-policy-migration-snapshot-v1' ? after : this.migrationSnapshot(after, { label: 'after' });
    const diffs = [];
    pushDiff(diffs, 'policyVersion', beforeSnapshot.policyVersion, afterSnapshot.policyVersion);
    pushDiff(diffs, 'schemaVersion', beforeSnapshot.schemaVersion, afterSnapshot.schemaVersion);
    pushDiff(diffs, 'constitutionHash', beforeSnapshot.constitutionHash, afterSnapshot.constitutionHash);
    compareObjectKeys(diffs, 'risk.tiersByAction', beforeSnapshot.risk.tiersByAction, afterSnapshot.risk.tiersByAction);
    compareArrays(diffs, 'risk.forbiddenActions', beforeSnapshot.risk.forbiddenActions, afterSnapshot.risk.forbiddenActions);
    compareArrays(diffs, 'dataRuleIds', beforeSnapshot.dataRuleIds, afterSnapshot.dataRuleIds);
    compareArrays(diffs, 'promptPatternIds', beforeSnapshot.promptPatternIds, afterSnapshot.promptPatternIds);
    return {
      diffVersion: 'e-policy-migration-snapshot-diff-v1',
      status: diffs.length === 0 ? 'clean' : 'changed',
      beforeHash: beforeSnapshot.manifestHash,
      afterHash: afterSnapshot.manifestHash,
      diffCount: diffs.length,
      diffs
    };
  }

  ciPolicyDriftGate({ baselineSnapshot, currentSnapshot, allowPolicyVersionChange = false } = {}) {
    const baseline = baselineSnapshot ?? this.migrationSnapshot(this.load(), { label: 'baseline' });
    const current = currentSnapshot ?? this.migrationSnapshot(this.load(), { label: 'current' });
    const diff = this.diffMigrationSnapshots(baseline, current);
    const unapproved = diff.diffs.filter((item) => allowPolicyVersionChange ? item.path !== 'policyVersion' : true);
    return {
      gateVersion: 'e-policy-ci-drift-gate-v1',
      status: unapproved.length === 0 ? 'passed' : 'failed',
      baselineHash: baseline.manifestHash,
      currentHash: current.manifestHash,
      allowPolicyVersionChange,
      unapprovedDriftCount: unapproved.length,
      diff
    };
  }

  fixtureRunnerMatrix({ manifest = this.load() } = {}) {
    const schema = this.externalJsonSchema();
    const yamlSource = this.toYaml(manifest);
    const yamlManifest = this.parseSource(yamlSource, { format: 'yaml' });
    const yamlCompile = this.compile(yamlManifest);
    const schemaValidation = this.validateAgainstExternalJsonSchema(manifest, schema);
    const invalidManifest = cloneJson(manifest);
    delete invalidManifest.approval.tiers;
    const invalidSchemaValidation = this.validateAgainstExternalJsonSchema(invalidManifest, schema);
    const nextManifest = cloneJson(manifest);
    nextManifest.policyVersion = `${manifest.policyVersion}-migration`;
    nextManifest.risk.tiersByAction.CREATE_FILE = 4;
    const migrationDiff = this.diffMigrationSnapshots(this.migrationSnapshot(manifest, { label: 'baseline' }), this.migrationSnapshot(nextManifest, { label: 'candidate' }));
    const cleanDriftGate = this.ciPolicyDriftGate({
      baselineSnapshot: this.migrationSnapshot(manifest, { label: 'baseline' }),
      currentSnapshot: this.migrationSnapshot(manifest, { label: 'current' })
    });
    const driftGate = this.ciPolicyDriftGate({
      baselineSnapshot: this.migrationSnapshot(manifest, { label: 'baseline' }),
      currentSnapshot: this.migrationSnapshot(nextManifest, { label: 'candidate' })
    });
    const items = [
      { fixtureId: 'policy_yaml_loader_roundtrip', passed: yamlCompile.success === true && hashPolicySection(yamlManifest) === hashPolicySection(manifest) },
      { fixtureId: 'policy_external_json_schema_valid', passed: schemaValidation.valid === true },
      { fixtureId: 'policy_external_json_schema_rejects_missing_tiers', passed: invalidSchemaValidation.valid === false },
      { fixtureId: 'policy_migration_snapshot_diff_detects_risk_change', passed: migrationDiff.status === 'changed' && migrationDiff.diffs.some((item) => item.path === 'risk.tiersByAction.CREATE_FILE') },
      { fixtureId: 'policy_ci_drift_gate_clean_passes', passed: cleanDriftGate.status === 'passed' },
      { fixtureId: 'policy_ci_drift_gate_blocks_unapproved_change', passed: driftGate.status === 'failed' }
    ];
    return {
      matrixVersion: 'e-policy-as-code-fixture-runner-matrix-v1',
      status: items.every((item) => item.passed) ? 'passed' : 'failed',
      fixtureCount: items.length,
      yamlLoader: {
        loaderVersion: 'e-policy-yaml-loader-v1',
        sourceBytes: yamlSource.length,
        roundTripHash: hashPolicySection(yamlManifest)
      },
      externalSchema: schema,
      schemaValidation,
      invalidSchemaValidation,
      migrationDiff,
      cleanDriftGate,
      driftGate,
      items
    };
  }

  validate(manifest) {
    const issues = [];
    const requireObject = (path, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) issues.push({ path, code: 'required_object' });
    };
    const requireArray = (path, value) => {
      if (!Array.isArray(value) || value.length === 0) issues.push({ path, code: 'required_nonempty_array' });
    };
    if (!manifest?.policyVersion) issues.push({ path: 'policyVersion', code: 'required' });
    requireObject('constitution', manifest?.constitution);
    requireArray('constitution.principles', manifest?.constitution?.principles);
    requireObject('risk', manifest?.risk);
    requireArray('risk.forbiddenActions', manifest?.risk?.forbiddenActions);
    requireObject('risk.tiersByAction', manifest?.risk?.tiersByAction);
    requireArray('dataRules', manifest?.dataRules);
    requireObject('approval.tiers', manifest?.approval?.tiers);
    requireObject('capability', manifest?.capability);
    requireObject('toolPoisoning', manifest?.toolPoisoning);
    requireArray('toolPoisoning.toolOutputSources', manifest?.toolPoisoning?.toolOutputSources);
    requireArray('toolPoisoning.blockedInstructionPatterns', manifest?.toolPoisoning?.blockedInstructionPatterns);
    requireObject('promptInjection', manifest?.promptInjection);
    requireArray('promptInjection.blockedPatterns', manifest?.promptInjection?.blockedPatterns);
    requireArray('promptInjection.untrustedSourceTypes', manifest?.promptInjection?.untrustedSourceTypes);
    requireObject('promptInjection.decisions', manifest?.promptInjection?.decisions);
    requireObject('autonomy', manifest?.autonomy);
    for (const [tier, rule] of Object.entries(manifest?.approval?.tiers ?? {})) {
      if (!['1', '2', '3', '4', '5'].includes(tier)) issues.push({ path: `approval.tiers.${tier}`, code: 'invalid_tier' });
      if (typeof rule.mobileApprovalAllowed !== 'boolean') issues.push({ path: `approval.tiers.${tier}.mobileApprovalAllowed`, code: 'required_boolean' });
    }
    for (const rule of manifest?.dataRules ?? []) {
      if (!rule?.id) issues.push({ path: 'dataRules.id', code: 'required' });
      if (!rule?.pattern) issues.push({ path: `dataRules.${rule?.id ?? 'unknown'}.pattern`, code: 'required' });
      if (!/^D[0-4]$/.test(rule?.dataClass ?? '')) issues.push({ path: `dataRules.${rule?.id ?? 'unknown'}.dataClass`, code: 'invalid_data_class' });
      if (!/^M[0-4]$/.test(rule?.ministryDataClass ?? '')) issues.push({ path: `dataRules.${rule?.id ?? 'unknown'}.ministryDataClass`, code: 'invalid_ministry_data_class' });
      if (!Array.isArray(rule?.flags) || rule.flags.length === 0) issues.push({ path: `dataRules.${rule?.id ?? 'unknown'}.flags`, code: 'required_nonempty_array' });
      try {
        new RegExp(rule.pattern, 'i');
      } catch {
        issues.push({ path: `dataRules.${rule.id}.pattern`, code: 'invalid_regex' });
      }
    }
    for (const [index, pattern] of (manifest?.toolPoisoning?.blockedInstructionPatterns ?? []).entries()) {
      try {
        new RegExp(pattern, 'i');
      } catch {
        issues.push({ path: `toolPoisoning.blockedInstructionPatterns.${index}`, code: 'invalid_regex' });
      }
    }
    for (const [index, rule] of (manifest?.promptInjection?.blockedPatterns ?? []).entries()) {
      if (!rule?.id) issues.push({ path: `promptInjection.blockedPatterns.${index}.id`, code: 'required' });
      if (!rule?.pattern) issues.push({ path: `promptInjection.blockedPatterns.${index}.pattern`, code: 'required' });
      if (!['high', 'medium', 'low'].includes(rule?.severity)) {
        issues.push({ path: `promptInjection.blockedPatterns.${index}.severity`, code: 'invalid_severity' });
      }
      try {
        new RegExp(rule.pattern, 'i');
      } catch {
        issues.push({ path: `promptInjection.blockedPatterns.${index}.pattern`, code: 'invalid_regex' });
      }
    }
    return { valid: issues.length === 0, issues };
  }
}

function hashPolicySection(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function signBundleHash(bundleHash, signingSecret) {
  return createHmac('sha256', signingSecret).update(String(bundleHash)).digest('base64url');
}

function formatFromPath(path) {
  const extension = extname(String(path ?? '')).toLowerCase();
  return extension === '.yaml' || extension === '.yml' ? 'yaml' : 'json';
}

function parsePolicyYaml(source) {
  const manifest = {};
  for (const rawLine of String(source ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    manifest[key] = parseYamlScalar(rawValue);
  }
  return manifest;
}

function parseYamlScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (/^[\[{"]/.test(trimmed) || ['true', 'false', 'null'].includes(trimmed) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function stringifyPolicyYaml(manifest) {
  return Object.keys(manifest)
    .map((key) => `${key}: ${JSON.stringify(manifest[key])}`)
    .join('\n') + '\n';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function pushDiff(diffs, path, before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    diffs.push({ path, type: 'value_changed', before, after });
  }
}

function compareArrays(diffs, path, before = [], after = []) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const item of beforeSet) {
    if (!afterSet.has(item)) diffs.push({ path, type: 'removed', value: item });
  }
  for (const item of afterSet) {
    if (!beforeSet.has(item)) diffs.push({ path, type: 'added', value: item });
  }
}

function compareObjectKeys(diffs, path, before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (!(key in before)) diffs.push({ path: `${path}.${key}`, type: 'added', after: after[key] });
    else if (!(key in after)) diffs.push({ path: `${path}.${key}`, type: 'removed', before: before[key] });
    else if (before[key] !== after[key]) diffs.push({ path: `${path}.${key}`, type: 'value_changed', before: before[key], after: after[key] });
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
