import { createHash } from 'node:crypto';
import { CapabilityAvailabilityRegistry } from './capability-availability.js';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const semverPattern = /^\d+\.\d+\.\d+$/u;
const adapterCodeVersions = new WeakMap();
export function capabilityAdapterCodeVersion(adapter) { return adapterCodeVersions.get(adapter) ?? null; }

/**
 * A capability package keeps every executable projection together.  A route is
 * never considered ready merely because its skill manifest exists: arguments,
 * adapter contract, execution evidence and an independent verifier must all be
 * present and agree on one tool name before activation.
 */
export class CapabilityPackageRegistry {
  constructor({ clock = () => new Date(), availabilityRegistry = null } = {}) {
    this.clock = clock;
    this.packages = new Map();
    this.activations = new Map();
    this.targetActivations = new Map();
    this.targetIds = new WeakMap();
    this.nextTargetId = 1;
    this.availabilityRegistry = availabilityRegistry ?? new CapabilityAvailabilityRegistry({ clock });
  }

  targetId(target) {
    let id = this.targetIds.get(target);
    if (!id) {
      id = this.nextTargetId;
      this.nextTargetId += 1;
      this.targetIds.set(target, id);
    }
    return id;
  }

  activationKey(toolName, { skillRouter, adapterRegistry, evidenceSchemaRegistry, registerArgumentSchema }) {
    return [
      toolName,
      this.targetId(skillRouter),
      this.targetId(adapterRegistry),
      this.targetId(evidenceSchemaRegistry),
      this.targetId(registerArgumentSchema)
    ].join(':');
  }

  validate(definition, { adapter = null, targets = {} } = {}) {
    const errors = [];
    const toolName = String(definition?.skill?.toolName ?? '');
    if (!definition?.packageId) errors.push('packageId is required.');
    if (!semverPattern.test(String(definition?.version ?? ''))) errors.push('version must be semver.');
    if (!definition?.skill || typeof definition.skill !== 'object') errors.push('skill manifest is required.');
    if (!toolName) errors.push('skill.toolName is required.');
    if (definition?.argumentSchema?.type !== 'object') errors.push('argumentSchema.type must be object.');
    if (!Array.isArray(definition?.argumentSchema?.fields) || definition.argumentSchema.fields.length === 0) {
      errors.push('argumentSchema.fields is required.');
    }
    if (!Array.isArray(definition?.evidenceSchema?.required) || definition.evidenceSchema.required.length === 0) {
      errors.push('evidenceSchema.required is required.');
    }
    if (!definition?.verifierId || typeof definition?.verifyEvidence !== 'function') {
      errors.push('verifierId and verifyEvidence are required.');
    }
    if (!/^[a-f0-9]{64}$/iu.test(String(definition?.verifierFingerprint ?? ''))) {
      errors.push('verifierFingerprint must be a SHA-256 hex digest.');
    } else if (definition?.verifyEvidence?.verifierFingerprint !== definition.verifierFingerprint) {
      errors.push('verifyEvidence.verifierFingerprint must match verifierFingerprint.');
    }
    if (!adapter || typeof adapter !== 'object') errors.push('adapter factory must return an adapter.');
    if (adapter && adapter.contract?.toolName !== toolName) errors.push('adapter contract toolName must match skill.toolName.');
    if (adapter && targets.adapterRegistry?.validateAdapter) {
      const validation = targets.adapterRegistry.validateAdapter(toolName, adapter);
      if (!validation.valid) errors.push(...validation.errors.map((error) => `adapter:${error}`));
    }
    if (targets.skillRouter?.validateSkillManifest) {
      const validation = targets.skillRouter.validateSkillManifest(definition?.skill);
      if (!validation.valid) errors.push(...validation.errors.map((error) => `skill:${error}`));
    }
    const evidenceDeclared = new Set(adapter?.contract?.evidence ?? []);
    for (const field of definition?.evidenceSchema?.adapterEvidence ?? []) {
      if (!evidenceDeclared.has(field)) errors.push(`adapter contract does not declare evidence:${field}`);
    }
    return {
      valid: errors.length === 0,
      errors: [...new Set(errors)],
      toolName,
      packageDigest: definition ? sha256({
        packageId: definition.packageId,
        version: definition.version,
        skill: definition.skill,
        argumentSchema: definition.argumentSchema,
        evidenceSchema: definition.evidenceSchema,
        verifierId: definition.verifierId,
        // Use an explicit, reviewable contract fingerprint. Function#toString()
        // is deliberately avoided because closures and build transforms make it
        // an unstable and incomplete representation of executable semantics.
        verifierFingerprint: definition.verifierFingerprint,
        // A package promotion must bind the review to the exact executable
        // artifact. Legacy first-party packages may omit this until they enter
        // the staged lifecycle; staged promotion itself requires it.
        artifactSha256: definition.artifactSha256 ?? null
      }) : null
    };
  }

  activate(definition, {
    skillRouter,
    adapterRegistry,
    evidenceSchemaRegistry,
    registerArgumentSchema,
    adapterContext = {}
  } = {}) {
    const adapter = definition?.createAdapter?.(adapterContext) ?? definition?.adapter ?? null;
    const targets = { skillRouter, adapterRegistry, evidenceSchemaRegistry };
    const validation = this.validate(definition, { adapter, targets });
    if (!validation.valid) {
      const error = new Error(`Capability package invalid: ${validation.errors.join(' | ')}`);
      error.code = 'A_CAPABILITY_PACKAGE_INVALID';
      error.errors = validation.errors;
      throw error;
    }
    if (!skillRouter || !adapterRegistry || !evidenceSchemaRegistry || typeof registerArgumentSchema !== 'function') {
      const error = new Error('All capability package activation targets are required.');
      error.code = 'A_CAPABILITY_PACKAGE_TARGET_MISSING';
      throw error;
    }

    const toolName = validation.toolName;
    const existingActivation = this.activations.get(toolName);
    if (existingActivation) {
      if (existingActivation.packageDigest !== validation.packageDigest) {
        const error = new Error(`Capability package conflict for ${toolName}.`);
        error.code = 'A_CAPABILITY_PACKAGE_CONFLICT';
        throw error;
      }
    }
    const existingPackage = this.packages.get(definition.packageId);
    if (existingPackage && (existingPackage.packageDigest !== validation.packageDigest || existingPackage.toolName !== toolName)) {
      const error = new Error(`Capability package ID conflict for ${definition.packageId}.`);
      error.code = 'A_CAPABILITY_PACKAGE_ID_CONFLICT';
      throw error;
    }
    const targetActivationKey = this.activationKey(toolName, {
      skillRouter,
      adapterRegistry,
      evidenceSchemaRegistry,
      registerArgumentSchema
    });
    const existingTargetActivation = this.targetActivations.get(targetActivationKey);
    if (existingTargetActivation) return clone(existingTargetActivation);
    if (adapterRegistry.get(toolName)) {
      const error = new Error(`Adapter route already exists for ${toolName}.`);
      error.code = 'A_CAPABILITY_PACKAGE_ROUTE_COLLISION';
      throw error;
    }
    const existingSkill = skillRouter.capabilityMatrix?.().find((item) => item.toolName === toolName);
    if (existingSkill) {
      const error = new Error(`Skill route already exists for ${toolName}.`);
      error.code = 'A_CAPABILITY_PACKAGE_ROUTE_COLLISION';
      throw error;
    }

    const restoreTargets = captureActivationTargets({
      skillRouter,
      adapterRegistry,
      evidenceSchemaRegistry,
      registerArgumentSchema
    });
    let skill;
    try {
      // Keep the argument registrar last and include its transactional snapshot
      // when the registrar exposes one, so even mutate-then-throw failures are
      // compensated together with the other runtime projections.
      skill = skillRouter.registerSkill(definition.skill);
      evidenceSchemaRegistry.register(toolName, definition.evidenceSchema.required);
      adapterRegistry.register(toolName, adapter);
      registerArgumentSchema(toolName, definition.argumentSchema.fields);
    } catch (error) {
      restoreTargets();
      throw error;
    }

    const activatedAt = this.clock().toISOString();
    const activation = {
      activationVersion: 'a-capability-package-activation-v1',
      packageId: definition.packageId,
      version: definition.version,
      toolName,
      skillId: skill.skillId,
      verifierId: definition.verifierId,
      verifierFingerprint: definition.verifierFingerprint,
      packageDigest: validation.packageDigest,
      projections: {
        skill: true,
        arguments: true,
        adapter: true,
        evidence: true,
        verifier: true
      },
      status: 'active',
      activatedAt
    };
    if (!this.packages.has(definition.packageId)) {
      this.packages.set(definition.packageId, Object.freeze({
        toolName,
        packageDigest: validation.packageDigest,
        verifierId: definition.verifierId,
        verifierFingerprint: definition.verifierFingerprint,
        verifyEvidence: definition.verifyEvidence,
        adapter,
        _definition: Object.freeze({
          ...definition,
          skill: clone(definition.skill),
          argumentSchema: clone(definition.argumentSchema),
          evidenceSchema: clone(definition.evidenceSchema)
        })
      }));
    }
    if (!existingActivation) this.activations.set(toolName, activation);
    this.targetActivations.set(targetActivationKey, activation);
    adapterCodeVersions.set(adapter, validation.packageDigest);
    return clone(activation);
  }

  replace(definition, {
    skillRouter,
    adapterRegistry,
    evidenceSchemaRegistry,
    registerArgumentSchema,
    adapterContext = {},
    expectedActiveDigest
  } = {}) {
    const toolName = String(definition?.skill?.toolName ?? '');
    const current = this.activations.get(toolName);
    if (!current || !expectedActiveDigest || current.packageDigest !== expectedActiveDigest) {
      const error = new Error(`Capability package active version changed for ${toolName}.`);
      error.code = 'A_CAPABILITY_PACKAGE_STALE_ACTIVE_VERSION';
      throw error;
    }
    const targetKey = this.activationKey(toolName, {
      skillRouter, adapterRegistry, evidenceSchemaRegistry, registerArgumentSchema
    });
    const targetActivations = [...this.targetActivations.entries()].filter(([, item]) => item.toolName === toolName);
    // Registry package/verifier state is shared by this registry instance. Do
    // not let a target-local replacement silently change other runtime targets.
    if (targetActivations.length !== 1 || targetActivations[0][0] !== targetKey) {
      const error = new Error(`Capability package replacement requires exactly one matching runtime target for ${toolName}.`);
      error.code = 'A_CAPABILITY_PACKAGE_REPLACEMENT_TARGET_AMBIGUOUS';
      throw error;
    }
    const targetRestore = captureActivationTargets({ skillRouter, adapterRegistry, evidenceSchemaRegistry, registerArgumentSchema });
    const registrySnapshot = {
      packages: new Map(this.packages),
      activations: new Map(this.activations),
      targetActivations: new Map(this.targetActivations)
    };
    try {
      removeSkillProjection(skillRouter, current.skillId);
      adapterRegistry.adapters?.delete(toolName);
      adapterRegistry.contracts?.delete(toolName);
      evidenceSchemaRegistry.schemas?.delete(toolName);
      removeArgumentProjection(registerArgumentSchema, toolName);
      this.packages.delete(current.packageId);
      this.activations.delete(toolName);
      this.targetActivations.delete(targetKey);
      return this.activate(definition, {
        skillRouter, adapterRegistry, evidenceSchemaRegistry, registerArgumentSchema, adapterContext
      });
    } catch (error) {
      targetRestore();
      this.packages = registrySnapshot.packages;
      this.activations = registrySnapshot.activations;
      this.targetActivations = registrySnapshot.targetActivations;
      throw error;
    }
  }

  verify(toolName, evidence) {
    const activation = this.activations.get(toolName);
    const stored = this.packages.get(activation?.packageId);
    if (!stored) {
      return {
        toolName,
        valid: false,
        verifierId: null,
        verifierFingerprint: null,
        packageDigest: null,
        reasons: ['capability-package-not-active']
      };
    }
    const result = stored.verifyEvidence(evidence);
    return {
      toolName,
      verifierId: stored.verifierId,
      verifierFingerprint: stored.verifierFingerprint,
      packageDigest: activation.packageDigest,
      valid: result === true || result?.valid === true,
      reasons: result?.reasons ?? (result === true ? [] : ['capability-evidence-rejected'])
    };
  }

  recordAvailability(observation) {
    this.availabilityRegistry.recordObservation(observation);
    return this.availabilityFor(observation);
  }
  forgetAvailability(binding,options){return this.availabilityRegistry.forgetObservation(binding,options);}

  availabilityFor(binding, options = {}) {
    const activation = this.activations.get(binding.capabilityId);
    return this.availabilityRegistry.evaluate(binding, {
      ...options,
      codeReady: Boolean(activation && Object.values(activation.projections).every(Boolean)),
      codeVersion: activation?.packageDigest ?? null
    });
  }

  status() {
    const activations = [...this.activations.values()].map(clone).sort((a, b) => a.toolName.localeCompare(b.toolName));
    const codeReadyCount = activations.filter((item) => Object.values(item.projections).every(Boolean)).length;
    return {
      registryVersion: 'a-capability-package-registry-v1',
      packageCount: activations.length,
      targetActivationCount: this.targetActivations.size,
      // Compatibility alias: this has always counted code projections, not accounts or devices.
      readyCount: codeReadyCount,
      readyCountBasis: 'code-projections-only',
      codeReadyCount,
      availability: this.availabilityRegistry.status({
        codeContext: capabilityId => {
          const activation = this.activations.get(capabilityId);
          return {
            codeReady: Boolean(activation && Object.values(activation.projections).every(Boolean)),
            codeVersion: activation?.packageDigest ?? null
          };
        }
      }),
      ghostRouteCount: activations.filter((item) => !item.projections.adapter).length,
      orphanAdapterCount: activations.filter((item) => !item.projections.skill).length,
      activations
    };
  }
}

function removeSkillProjection(skillRouter, skillId) {
  if (skillRouter?.skills instanceof Map) {
    skillRouter.skills.delete(skillId);
    return;
  }
  if (Array.isArray(skillRouter?.skills)) {
    const index = skillRouter.skills.findIndex((skill) => skill.skillId === skillId);
    if (index >= 0) skillRouter.skills.splice(index, 1);
  }
}

function removeArgumentProjection(registrar, toolName) {
  if (typeof registrar?.snapshot !== 'function' || typeof registrar?.restore !== 'function') return;
  const snapshot = registrar.snapshot();
  if (snapshot instanceof Map) {
    snapshot.delete(toolName);
    registrar.restore(snapshot);
  } else if (Array.isArray(snapshot?.schemas)) {
    registrar.restore({
      ...snapshot,
      schemas: snapshot.schemas.filter(([name]) => name !== toolName)
    });
  }
}

function captureActivationTargets({ skillRouter, adapterRegistry, evidenceSchemaRegistry, registerArgumentSchema }) {
  const restorers = [
    snapshotContainer(skillRouter, 'skills'),
    snapshotContainer(adapterRegistry, 'adapters'),
    snapshotContainer(adapterRegistry, 'contracts'),
    snapshotContainer(evidenceSchemaRegistry, 'schemas'),
    snapshotRegistrar(registerArgumentSchema)
  ].filter(Boolean);
  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}

function snapshotRegistrar(registrar) {
  if (typeof registrar?.snapshot !== 'function' || typeof registrar?.restore !== 'function') return null;
  const snapshot = registrar.snapshot();
  return () => registrar.restore(snapshot);
}

function snapshotContainer(owner, key) {
  const container = owner?.[key];
  if (container instanceof Map) {
    const entries = [...container.entries()];
    return () => {
      container.clear();
      for (const [entryKey, value] of entries) container.set(entryKey, value);
    };
  }
  if (Array.isArray(container)) {
    const items = [...container];
    return () => {
      container.length = 0;
      container.push(...items);
    };
  }
  return null;
}
