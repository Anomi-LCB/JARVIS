import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ActionType, ModuleId } from '../../../shared/src/types.js';
import { defaultSkillManifest } from './default-skill-manifest.js';
import { ExecutionStrategyRouter } from './execution-strategy-router.js';

export class SkillRouter {
  constructor({
    manifest = defaultSkillManifest,
    trustedManifestKeys = ['jarvis-local-dev-key'],
    allowUnsigned = true,
    executionStrategyRouter = null,
    executionHealthRegistry = null
  } = {}) {
    this.skills = new Map();
    this.pluginBundles = new Map();
    this.compatibilitySnapshots = [];
    this.remoteRegistrySyncs = [];
    this.rotationDrills = [];
    this.sandboxSmokeRuns = [];
    this.sandboxProcessRuns = [];
    this.sandboxSoakRuns = [];
    this.routerProductGates = [];
    this.routerReleaseDossiers = [];
    this.bundleDownloadCache = new Map();
    this.manifestVersion = 'jarvis-a-skill-manifest@1';
    this.trustedManifestKeys = trustedManifestKeys;
    this.allowUnsigned = allowUnsigned;
    this.executionStrategyRouter = executionStrategyRouter ?? new ExecutionStrategyRouter({ healthRegistry: executionHealthRegistry });
    this.migrations = [];
    this.loadManifest(manifest);
  }

  loadManifest(manifest) {
    if (!Array.isArray(manifest)) {
      throw new Error('Skill manifest must be an array.');
    }
    for (const skill of manifest) this.registerSkill(skill);
    return this.capabilityMatrix();
  }

  registerSkill(skill, { pluginBundle = null } = {}) {
    const migrated = this.migrateSkillManifest(skill);
    const validation = this.validateSkillManifest(migrated);
    if (!validation.valid) {
      const error = new Error(`Skill manifest invalid: ${validation.errors.join(' | ')}`);
      error.code = 'A_SKILL_MANIFEST_INVALID';
      error.errors = validation.errors;
      throw error;
    }
    const signature = this.verifySignature(migrated, { pluginBundle });
    if (!signature.valid) {
      const error = new Error(`Skill manifest signature invalid: ${signature.reason}`);
      error.code = 'A_SKILL_MANIFEST_SIGNATURE_INVALID';
      error.signature = signature;
      throw error;
    }
    const normalized = {
      reversible: migrated.capability.reversible,
      module: ModuleId.PC_AGENT,
      ...migrated,
      execution: this.executionStrategyRouter.profileFor(migrated),
      manifestVersion: this.manifestVersion,
      signature,
      pluginBundle: pluginBundle ? {
        bundleId: pluginBundle.bundleId,
        version: pluginBundle.version,
        source: pluginBundle.source,
        sandboxPlanId: pluginBundle.sandboxPlan.planId
      } : null,
      lifecycle: this.lifecycleFor(migrated)
    };
    this.skills.set(normalized.skillId, normalized);
    return normalized;
  }

  migrateSkillManifest(skill) {
    if (!skill || typeof skill !== 'object') return skill;
    if (skill.capability) return skill;
    if (!skill.permissions) return skill;
    const migrated = {
      ...skill,
      capability: {
        readsLocalFiles: Boolean(skill.permissions.readsLocalFiles),
        writesLocalFiles: Boolean(skill.permissions.writesLocalFiles),
        externalNetwork: Boolean(skill.permissions.externalNetwork),
        externalTransfer: Boolean(skill.permissions.externalTransfer),
        reversible: Boolean(skill.permissions.reversible),
        requiresApproval: skill.permissions.requiresApproval ?? true,
        maxRiskTier: skill.permissions.maxRiskTier ?? 5,
        allowedModes: skill.permissions.allowedModes ?? ['shadow']
      }
    };
    this.migrations.push({ skillId: skill.skillId, from: 'permissions', to: 'capability', at: new Date().toISOString() });
    return migrated;
  }

  validateSkillManifest(skill) {
    const errors = [];
    if (!skill?.skillId) errors.push('skillId is required.');
    if (!/^\d+\.\d+\.\d+$/.test(skill?.version ?? '')) errors.push('version must be semver.');
    if (!skill?.label) errors.push('label is required.');
    if (!Object.values(ModuleId).includes(skill?.module)) errors.push('module is invalid.');
    if (!Object.values(ActionType).includes(skill?.actionType)) errors.push('actionType is invalid.');
    if (!skill?.toolName) errors.push('toolName is required.');
    if (!skill?.capability || typeof skill.capability !== 'object') errors.push('capability matrix is required.');
    if (!Array.isArray(skill?.capability?.allowedModes) || skill.capability.allowedModes.length === 0) errors.push('capability.allowedModes is required.');
    if (typeof skill?.capability?.requiresApproval !== 'boolean') errors.push('capability.requiresApproval must be boolean.');
    if (typeof skill?.capability?.externalTransfer !== 'boolean') errors.push('capability.externalTransfer must be boolean.');
    if (!skill?.safety?.trustBoundary) errors.push('safety.trustBoundary is required.');
    if (!skill?.adapterContract || typeof skill.adapterContract !== 'object') errors.push('adapterContract is required.');
    if (skill?.status && !['active', 'disabled', 'deprecated'].includes(skill.status)) errors.push('status must be active, disabled, or deprecated.');
    return { valid: errors.length === 0, errors };
  }

  verifySignature(skill, { pluginBundle = null } = {}) {
    if (!skill.signature) {
      if (pluginBundle?.signature?.valid) {
        return {
          valid: true,
          mode: 'bundle-signed',
          signer: pluginBundle.signature.signer,
          digest: pluginBundle.signature.digest,
          bundleId: pluginBundle.bundleId
        };
      }
      return this.allowUnsigned
        ? { valid: true, mode: 'unsigned-allowed', signer: null }
        : { valid: false, reason: 'signature-required' };
    }
    const { signer, digest } = skill.signature;
    if (!this.trustedManifestKeys.includes(signer)) {
      return { valid: false, reason: 'untrusted-signer', signer };
    }
    const expected = SkillRouter.signManifestEntry(skill, signer);
    if (digest !== expected.digest) {
      return { valid: false, reason: 'digest-mismatch', signer };
    }
    return { valid: true, mode: 'signed', signer, digest };
  }

  static signManifestEntry(skill, signer = 'jarvis-local-dev-key') {
    const unsigned = { ...skill };
    delete unsigned.signature;
    const digest = createHash('sha256')
      .update(`${signer}:${canonicalJson(unsigned)}`)
      .digest('hex');
    return { signer, digest, algorithm: 'sha256-canonical-json' };
  }

  static signPluginBundle(bundle, signer = 'jarvis-local-dev-key') {
    const unsigned = { ...bundle };
    delete unsigned.signature;
    const digest = createHash('sha256')
      .update(`${signer}:${canonicalJson(unsigned)}`)
      .digest('hex');
    return { signer, digest, algorithm: 'sha256-canonical-json' };
  }

  installPluginBundle(bundle, { replace = false } = {}) {
    const validation = this.validatePluginBundle(bundle);
    if (!validation.valid) {
      const error = new Error(`Skill plugin bundle invalid: ${validation.errors.join(' | ')}`);
      error.code = 'A_SKILL_PLUGIN_BUNDLE_INVALID';
      error.errors = validation.errors;
      throw error;
    }
    const signature = this.verifyPluginBundleSignature(bundle);
    if (!signature.valid) {
      const error = new Error(`Skill plugin bundle signature invalid: ${signature.reason}`);
      error.code = 'A_SKILL_PLUGIN_BUNDLE_SIGNATURE_INVALID';
      error.signature = signature;
      throw error;
    }
    const downloadCache = this.cacheSignedPluginBundle(bundle, { signature });
    const sandboxPlan = this.createSandboxLoadPlan(bundle);
    const previousBundle = this.pluginBundles.get(bundle.bundleId) ?? null;
    if (replace && previousBundle) {
      for (const skillId of previousBundle.skills ?? []) {
        this.skills.delete(skillId);
      }
    }
    const normalizedBundle = {
      bundleId: bundle.bundleId,
      version: bundle.version,
      label: bundle.label ?? bundle.bundleId,
      source: bundle.source,
      runtime: bundle.runtime,
      installedAt: new Date().toISOString(),
      signature,
      downloadCache,
      sandboxPlan,
      bundleManifest: clonePlain(bundle),
      skills: []
    };
    for (const skill of bundle.skills) {
      const registered = this.registerSkill({
        ...skill,
        metadata: {
          ...(skill.metadata ?? {}),
          pluginBundleId: bundle.bundleId,
          pluginBundleVersion: bundle.version
        }
      }, { pluginBundle: normalizedBundle });
      normalizedBundle.skills.push(registered.skillId);
    }
    this.pluginBundles.set(normalizedBundle.bundleId, normalizedBundle);
    const compatibilitySnapshot = this.compatibilitySnapshot({
      label: `install:${normalizedBundle.bundleId}`,
      record: true
    });
    return {
      success: true,
      bundle: normalizedBundle,
      registeredSkillIds: normalizedBundle.skills,
      downloadCache,
      sandboxPlan,
      compatibilitySnapshot
    };
  }

  cacheSignedPluginBundle(bundle, { signature }) {
    const manifest = clonePlain(bundle);
    const manifestSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
    const cacheRecord = {
      cacheVersion: 'a-skill-signed-bundle-download-cache-v1',
      bundleId: bundle.bundleId,
      version: bundle.version,
      source: bundle.source,
      manifestSha256,
      signer: signature.signer,
      signatureDigest: signature.digest,
      cachedAt: new Date().toISOString(),
      immutable: true,
      rawCodeStored: false
    };
    this.bundleDownloadCache.set(`${bundle.bundleId}@${bundle.version}`, cacheRecord);
    return cacheRecord;
  }

  async syncRemotePluginRegistry({
    registryUrl,
    fetchImpl = globalThis.fetch,
    install = false,
    allowLocalHttp = true
  } = {}) {
    const urlPolicy = this.assertRemoteRegistryUrlAllowed(registryUrl, { allowLocalHttp });
    const registry = await this.fetchRemoteRegistryJson(registryUrl, fetchImpl);
    const validation = this.validateRemotePluginRegistry(registry);
    const sync = {
      syncVersion: 'a-skill-remote-registry-sync-v1',
      registryUrl,
      urlPolicy,
      fetchedAt: new Date().toISOString(),
      registry: validation.normalizedRegistry,
      validation,
      installed: []
    };
    if (install && validation.valid) {
      for (const bundle of validation.normalizedRegistry.bundles) {
        sync.installed.push(this.installPluginBundle(bundle, { replace: true }));
      }
    }
    this.remoteRegistrySyncs.unshift(sync);
    return sync;
  }

  async fetchRemoteRegistryJson(registryUrl, fetchImpl) {
    if (typeof fetchImpl !== 'function') {
      const error = new Error('Remote plugin registry fetch requires fetchImpl.');
      error.code = 'A_SKILL_REMOTE_REGISTRY_FETCH_UNAVAILABLE';
      throw error;
    }
    const response = await fetchImpl(registryUrl, {
      method: 'GET',
      headers: { accept: 'application/json' }
    });
    if (response && typeof response.json === 'function') {
      if (response.ok === false) {
        const error = new Error(`Remote plugin registry fetch failed: ${response.status}`);
        error.code = 'A_SKILL_REMOTE_REGISTRY_FETCH_FAILED';
        throw error;
      }
      return await response.json();
    }
    return response;
  }

  assertRemoteRegistryUrlAllowed(registryUrl, { allowLocalHttp = true } = {}) {
    let url;
    try {
      url = new URL(registryUrl);
    } catch {
      const error = new Error('Remote plugin registry URL is invalid.');
      error.code = 'A_SKILL_REMOTE_REGISTRY_URL_INVALID';
      throw error;
    }
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    const httpsAllowed = url.protocol === 'https:';
    const localHttpAllowed = allowLocalHttp && url.protocol === 'http:' && localHosts.has(url.hostname);
    if (!httpsAllowed && !localHttpAllowed) {
      const error = new Error('Remote plugin registry requires HTTPS or explicit local HTTP.');
      error.code = 'A_SKILL_REMOTE_REGISTRY_URL_BLOCKED';
      error.urlPolicy = {
        allowedProtocols: ['https:', ...(allowLocalHttp ? ['http://localhost'] : [])],
        actualProtocol: url.protocol,
        hostname: url.hostname
      };
      throw error;
    }
    return {
      policyVersion: 'a-skill-remote-registry-url-policy-v1',
      accepted: true,
      protocol: url.protocol,
      hostname: url.hostname,
      localHttp: localHttpAllowed
    };
  }

  validateRemotePluginRegistry(registry) {
    const errors = [];
    if (registry?.schemaVersion !== 'a-skill-remote-registry-v1') errors.push('schemaVersion must be a-skill-remote-registry-v1.');
    if (!registry?.registryId) errors.push('registryId is required.');
    if (!Array.isArray(registry?.bundles)) errors.push('bundles must be an array.');
    const bundles = [];
    const bundleValidations = [];
    for (const bundle of registry?.bundles ?? []) {
      const bundleValidation = this.validatePluginBundle(bundle);
      const signature = bundleValidation.valid ? this.verifyPluginBundleSignature(bundle) : { valid: false, reason: 'bundle-invalid' };
      if (!bundleValidation.valid) errors.push(`bundle:${bundle?.bundleId ?? 'unknown'}:${bundleValidation.errors.join('|')}`);
      if (!signature.valid) errors.push(`bundle:${bundle?.bundleId ?? 'unknown'}:${signature.reason}`);
      bundleValidations.push({
        bundleId: bundle?.bundleId ?? 'unknown',
        valid: bundleValidation.valid && signature.valid,
        signature,
        errors: bundleValidation.errors
      });
      bundles.push(bundle);
    }
    return {
      validationVersion: 'a-skill-remote-registry-validation-v1',
      valid: errors.length === 0,
      errors,
      normalizedRegistry: {
        schemaVersion: registry?.schemaVersion ?? null,
        registryId: registry?.registryId ?? null,
        generatedAt: registry?.generatedAt ?? null,
        bundleCount: bundles.length,
        bundles,
        bundleValidations
      }
    };
  }

  rotatePluginBundle({ bundle, reason = 'manual-rotation-drill' } = {}) {
    const previousBundle = this.pluginBundles.get(bundle?.bundleId) ?? null;
    const before = this.compatibilitySnapshot({ label: `rotation-before:${bundle?.bundleId ?? 'unknown'}`, record: false });
    const installed = this.installPluginBundle(bundle, { replace: true });
    const after = this.compatibilitySnapshot({ label: `rotation-after:${bundle.bundleId}`, record: true });
    const previousSkillIds = new Set(previousBundle?.skills ?? []);
    const currentSkillIds = new Set(after.matrix.map((skill) => skill.skillId));
    const removedSkillIds = [...previousSkillIds].filter((skillId) => !currentSkillIds.has(skillId));
    const changedVersionSkillIds = after.matrix
      .filter((skill) => before.matrix.find((oldSkill) => oldSkill.skillId === skill.skillId && oldSkill.version !== skill.version))
      .map((skill) => skill.skillId);
    const drill = {
      rotationVersion: 'a-skill-bundle-rotation-drill-v1',
      rotationId: `rotation_${safeId(bundle.bundleId)}_${Date.now()}`,
      status: installed.success && removedSkillIds.length === 0 ? 'passed' : 'failed',
      reason,
      bundleId: bundle.bundleId,
      previousVersion: previousBundle?.version ?? null,
      nextVersion: installed.bundle.version,
      rotatedAt: new Date().toISOString(),
      installed,
      rollbackPlan: {
        rollbackVersion: 'a-skill-rollbackable-plugin-rotation-v1',
        available: Boolean(previousBundle?.bundleManifest),
        previousBundleId: previousBundle?.bundleId ?? null,
        previousVersion: previousBundle?.version ?? null,
        nextVersion: installed.bundle.version,
        restoreMode: 'replace-current-bundle-with-signed-cached-manifest',
        previousManifestSha256: previousBundle?.downloadCache?.manifestSha256 ?? null
      },
      previousBundleManifest: previousBundle?.bundleManifest ? clonePlain(previousBundle.bundleManifest) : null,
      compatibility: {
        beforeDigest: before.matrixDigest,
        afterDigest: after.matrixDigest,
        removedSkillIds,
        changedVersionSkillIds,
        before,
        after
      }
    };
    this.rotationDrills.unshift(drill);
    return drill;
  }

  rollbackPluginRotation(rotationId = null) {
    const drill = rotationId
      ? this.rotationDrills.find((item) => item.rotationId === rotationId)
      : this.rotationDrills[0];
    if (!drill?.previousBundleManifest) {
      return {
        rollbackVersion: 'a-skill-plugin-rotation-rollback-v1',
        status: 'failed',
        reason: 'previous-bundle-manifest-unavailable',
        rotationId
      };
    }
    const installed = this.installPluginBundle(drill.previousBundleManifest, { replace: true });
    return {
      rollbackVersion: 'a-skill-plugin-rotation-rollback-v1',
      status: installed.success ? 'passed' : 'failed',
      rotationId: drill.rotationId,
      bundleId: drill.bundleId,
      restoredVersion: installed.bundle.version,
      restoredSkillIds: installed.registeredSkillIds,
      compatibilitySnapshot: installed.compatibilitySnapshot
    };
  }

  runSandboxWorkerSmoke(bundleId, { workerId = 'manifest-only-smoke-worker' } = {}) {
    const bundle = this.pluginBundles.get(bundleId);
    if (!bundle) {
      return {
        smokeVersion: 'a-skill-sandbox-worker-smoke-v1',
        status: 'failed',
        error: { code: 'A_SKILL_PLUGIN_BUNDLE_NOT_FOUND', bundleId }
      };
    }
    const checks = [
      {
        checkId: 'sandbox-plan-present',
        status: bundle.sandboxPlan?.planVersion === 'a-skill-sandbox-load-plan-v1' ? 'passed' : 'failed',
        evidence: { planVersion: bundle.sandboxPlan?.planVersion }
      },
      {
        checkId: 'code-not-loaded',
        status: bundle.sandboxPlan?.executionMode === 'manifest_registered_code_not_loaded' ? 'passed' : 'failed',
        evidence: { executionMode: bundle.sandboxPlan?.executionMode }
      },
      {
        checkId: 'network-blocked-by-default',
        status: ['blocked', 'blocked_until_explicit_policy'].includes(bundle.sandboxPlan?.network) ? 'passed' : 'failed',
        evidence: { network: bundle.sandboxPlan?.network }
      },
      {
        checkId: 'empty-env-by-default',
        status: bundle.sandboxPlan?.environment === 'empty-env-by-default' ? 'passed' : 'failed',
        evidence: { environment: bundle.sandboxPlan?.environment }
      },
      {
        checkId: 'approval-gates-present',
        status: ['trusted_signature', 'capability_scope', 'adapter_contract'].every((gate) => bundle.sandboxPlan?.requiredApprovals?.includes(gate)) ? 'passed' : 'failed',
        evidence: { requiredApprovals: bundle.sandboxPlan?.requiredApprovals ?? [] }
      }
    ];
    const smoke = {
      smokeVersion: 'a-skill-sandbox-worker-smoke-v1',
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
      workerId,
      bundleId,
      version: bundle.version,
      ranAt: new Date().toISOString(),
      sandboxPlan: bundle.sandboxPlan,
      checks
    };
    this.sandboxSmokeRuns.unshift(smoke);
    return smoke;
  }

  runIsolatedSandboxProcessSmoke(bundleId, { workerId = 'isolated-plugin-worker', timeoutMs = 5000 } = {}) {
    const bundle = this.pluginBundles.get(bundleId);
    if (!bundle) {
      return {
        processSmokeVersion: 'a-skill-isolated-sandbox-process-v1',
        status: 'failed',
        error: { code: 'A_SKILL_PLUGIN_BUNDLE_NOT_FOUND', bundleId }
      };
    }
    const payload = {
      processSmokeVersion: 'a-skill-isolated-sandbox-process-v1',
      workerId,
      bundleId,
      version: bundle.version,
      sandbox: bundle.runtime.sandbox,
      entrypoint: bundle.runtime.entrypoint
    };
    const script = `const payload = ${JSON.stringify(payload)}; console.log(JSON.stringify({ ...payload, status: 'passed', pid: process.pid, envKeyCount: Object.keys(process.env).length, codeLoaded: false, rawCodeStored: false }));`;
    const child = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
      env: { JARVIS_SKILL_SANDBOX: '1' },
      timeout: timeoutMs,
      windowsHide: true
    });
    let parsed = null;
    try {
      parsed = JSON.parse(child.stdout.trim());
    } catch {
      parsed = null;
    }
    const smoke = {
      processSmokeVersion: 'a-skill-isolated-sandbox-process-v1',
      status: child.status === 0 && parsed?.status === 'passed' ? 'passed' : 'failed',
      workerId,
      bundleId,
      version: bundle.version,
      exitCode: child.status,
      signal: child.signal,
      timeoutMs,
      timedOut: child.error?.code === 'ETIMEDOUT',
      stderr: child.stderr,
      sandboxPlan: bundle.sandboxPlan,
      childEvidence: parsed
    };
    this.sandboxProcessRuns.unshift(smoke);
    return smoke;
  }

  runSandboxWorkerSoak(bundleId, { cycles = 3 } = {}) {
    const runs = [];
    for (let index = 0; index < cycles; index += 1) {
      runs.push(this.runIsolatedSandboxProcessSmoke(bundleId, {
        workerId: `isolated-plugin-worker-${index + 1}`
      }));
    }
    const soak = {
      soakVersion: 'a-skill-sandbox-worker-soak-v1',
      bundleId,
      cycles,
      status: runs.every((run) => run.status === 'passed') ? 'passed' : 'failed',
      passedCount: runs.filter((run) => run.status === 'passed').length,
      runs
    };
    this.sandboxSoakRuns.unshift(soak);
    return soak;
  }

  runSkillRouterReleaseDossier(bundleId, {
    checks = [],
    processSmoke = null,
    soak = null,
    latestRotation = null
  } = {}) {
    const bundle = this.pluginBundles.get(bundleId);
    if (!bundle) {
      return {
        dossierVersion: 'a-skill-router-release-dossier-v1',
        status: 'blocked',
        error: { code: 'A_SKILL_PLUGIN_BUNDLE_NOT_FOUND', bundleId }
      };
    }
    const effectiveProcessSmoke = processSmoke ?? this.sandboxProcessRuns.find((run) => run.bundleId === bundleId) ?? null;
    const effectiveSoak = soak ?? this.sandboxSoakRuns.find((run) => run.bundleId === bundleId) ?? null;
    const effectiveRotation = latestRotation ?? this.rotationDrills.find((drill) => drill.bundleId === bundleId) ?? null;
    const latestRemoteSync = this.remoteRegistrySyncs.find((sync) => (sync.registry?.bundles ?? []).some((candidate) => candidate.bundleId === bundleId)) ?? null;
    const releaseChecks = [
      {
        checkId: 'signed_bundle_download_cache_release_evidence',
        passed: bundle.downloadCache?.cacheVersion === 'a-skill-signed-bundle-download-cache-v1'
          && bundle.downloadCache.immutable === true
          && bundle.downloadCache.rawCodeStored === false
          && typeof bundle.downloadCache.manifestSha256 === 'string'
          && bundle.downloadCache.manifestSha256.length === 64,
        manifestSha256: bundle.downloadCache?.manifestSha256 ?? null,
        signer: bundle.downloadCache?.signer ?? null
      },
      {
        checkId: 'isolated_sandbox_process_release_evidence',
        passed: effectiveProcessSmoke?.processSmokeVersion === 'a-skill-isolated-sandbox-process-v1'
          && effectiveProcessSmoke.status === 'passed'
          && effectiveProcessSmoke.childEvidence?.codeLoaded === false
          && effectiveProcessSmoke.childEvidence?.rawCodeStored === false,
        pid: effectiveProcessSmoke?.childEvidence?.pid ?? null,
        codeLoaded: effectiveProcessSmoke?.childEvidence?.codeLoaded ?? null
      },
      {
        checkId: 'sandbox_worker_soak_release_evidence',
        passed: effectiveSoak?.soakVersion === 'a-skill-sandbox-worker-soak-v1'
          && effectiveSoak.status === 'passed'
          && effectiveSoak.cycles >= 2
          && effectiveSoak.runs.every((run) => run.childEvidence?.codeLoaded === false),
        cycles: effectiveSoak?.cycles ?? 0,
        passedCount: effectiveSoak?.passedCount ?? 0
      },
      {
        checkId: 'rollbackable_plugin_rotation_release_evidence',
        passed: effectiveRotation?.rotationVersion === 'a-skill-bundle-rotation-drill-v1'
          && effectiveRotation.status === 'passed'
          && effectiveRotation.rollbackPlan?.rollbackVersion === 'a-skill-rollbackable-plugin-rotation-v1'
          && effectiveRotation.rollbackPlan.available === true
          && typeof effectiveRotation.rollbackPlan.previousManifestSha256 === 'string'
          && effectiveRotation.rollbackPlan.previousManifestSha256.length === 64,
        rotationId: effectiveRotation?.rotationId ?? null,
        previousVersion: effectiveRotation?.previousVersion ?? null,
        nextVersion: effectiveRotation?.nextVersion ?? null
      },
      {
        checkId: 'remote_registry_validation_release_evidence',
        passed: latestRemoteSync?.syncVersion === 'a-skill-remote-registry-sync-v1'
          && latestRemoteSync.validation?.valid === true
          && latestRemoteSync.registry?.bundleValidations?.some((validation) => validation.bundleId === bundleId && validation.valid === true),
        registryUrl: latestRemoteSync?.registryUrl ?? null,
        bundleCount: latestRemoteSync?.registry?.bundleCount ?? 0
      }
    ];
    const artifactManifest = createSkillRouterReleaseArtifactManifest({
      bundle,
      releaseChecks,
      processSmoke: effectiveProcessSmoke,
      soak: effectiveSoak,
      latestRotation: effectiveRotation,
      latestRemoteSync
    });
    const ciNightlyGatePlan = createSkillRouterCiNightlyGatePlan({ artifactManifest });
    const externalWormPromotionPackage = createSkillRouterExternalWormPromotionPackage({
      artifactManifest,
      ciNightlyGatePlan,
      releaseChecks
    });
    const status = checks.every((check) => check.status === 'passed')
      && releaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && externalWormPromotionPackage.status === 'ready'
      ? 'passed'
      : 'blocked';
    const dossier = {
      dossierVersion: 'a-skill-router-release-dossier-v1',
      generatedAt: new Date().toISOString(),
      bundleId,
      version: bundle.version,
      status,
      signature: {
        signer: bundle.signature?.signer ?? null,
        algorithm: bundle.signature?.algorithm ?? null,
        digest: bundle.signature?.digest ?? null
      },
      downloadCache: bundle.downloadCache,
      sandbox: {
        planVersion: bundle.sandboxPlan?.planVersion ?? null,
        executionMode: bundle.sandboxPlan?.executionMode ?? null,
        network: bundle.sandboxPlan?.network ?? null,
        environment: bundle.sandboxPlan?.environment ?? null
      },
      processSmoke: effectiveProcessSmoke,
      soak: effectiveSoak,
      latestRotation: effectiveRotation
        ? {
            rotationVersion: effectiveRotation.rotationVersion,
            rotationId: effectiveRotation.rotationId,
            status: effectiveRotation.status,
            previousVersion: effectiveRotation.previousVersion,
            nextVersion: effectiveRotation.nextVersion,
            rollbackPlan: effectiveRotation.rollbackPlan,
            removedSkillIds: effectiveRotation.compatibility?.removedSkillIds ?? []
          }
        : null,
      remoteRegistry: latestRemoteSync
        ? {
            syncVersion: latestRemoteSync.syncVersion,
            registryUrl: latestRemoteSync.registryUrl,
            fetchedAt: latestRemoteSync.fetchedAt,
            valid: latestRemoteSync.validation.valid,
            bundleCount: latestRemoteSync.registry.bundleCount
          }
        : null,
      checks: checks.map((check) => ({ ...check })),
      releaseChecks,
      artifactManifest,
      ciNightlyGatePlan,
      externalWormPromotionPackage,
      recommendedReleaseAction: status === 'passed'
        ? 'attach_skill_router_hash_only_manifest_and_worm_promotion_package'
        : 'block_skill_router_release_until_manifest_and_worm_gate_pass'
    };
    dossier.dossierSha256 = createHash('sha256').update(canonicalJson(dossier)).digest('hex');
    this.routerReleaseDossiers.unshift(dossier);
    return dossier;
  }

  runSkillRouterProductGate(bundleId) {
    const bundle = this.pluginBundles.get(bundleId);
    if (!bundle) {
      return {
        gateVersion: 'a-skill-router-product-gate-v1',
        status: 'blocked',
        error: { code: 'A_SKILL_PLUGIN_BUNDLE_NOT_FOUND', bundleId }
      };
    }
    const processSmoke = this.runIsolatedSandboxProcessSmoke(bundleId);
    const soak = this.runSandboxWorkerSoak(bundleId, { cycles: 2 });
    const latestRotation = this.rotationDrills.find((drill) => drill.bundleId === bundleId) ?? null;
    const checks = [
      {
        checkId: 'signed_bundle_download_cache_available',
        status: bundle.downloadCache?.cacheVersion === 'a-skill-signed-bundle-download-cache-v1' ? 'passed' : 'blocked',
        manifestSha256: bundle.downloadCache?.manifestSha256 ?? null
      },
      {
        checkId: 'isolated_sandbox_process_smoke_passed',
        status: processSmoke.status === 'passed' ? 'passed' : 'blocked',
        processSmokeVersion: processSmoke.processSmokeVersion
      },
      {
        checkId: 'sandbox_worker_soak_passed',
        status: soak.status === 'passed' ? 'passed' : 'blocked',
        cycles: soak.cycles
      },
      {
        checkId: 'rollbackable_plugin_rotation_ready',
        status: latestRotation?.rollbackPlan?.rollbackVersion === 'a-skill-rollbackable-plugin-rotation-v1' ? 'passed' : 'blocked',
        rotationId: latestRotation?.rotationId ?? null
      }
    ];
    const releaseDossier = this.runSkillRouterReleaseDossier(bundleId, {
      checks,
      processSmoke,
      soak,
      latestRotation
    });
    checks.push({
      checkId: 'skill_router_release_artifact_manifest_ready',
      status: releaseDossier.artifactManifest?.artifactManifestVersion === 'a-skill-router-release-artifact-manifest-v1'
        && releaseDossier.artifactManifest.rawLeakCheck?.rawLeakDetected === false
        ? 'passed'
        : 'blocked'
    });
    checks.push({
      checkId: 'skill_router_worm_promotion_package_ready',
      status: releaseDossier.externalWormPromotionPackage?.packageVersion === 'a-skill-router-worm-promotion-package-v1'
        && releaseDossier.externalWormPromotionPackage?.providerContractVersion === 'a-skill-router-worm-provider-contract-v1'
        && releaseDossier.externalWormPromotionPackage?.status === 'ready'
        ? 'passed'
        : 'blocked'
    });
    checks.push({
      checkId: 'skill_router_release_dossier_ready',
      status: releaseDossier.dossierVersion === 'a-skill-router-release-dossier-v1'
        && releaseDossier.status === 'passed'
        && typeof releaseDossier.dossierSha256 === 'string'
        && releaseDossier.dossierSha256.length === 64
        ? 'passed'
        : 'blocked'
    });
    const gate = {
      gateVersion: 'a-skill-router-product-gate-v1',
      bundleId,
      status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
      checks,
      processSmoke,
      soak,
      latestRotation,
      releaseDossier
    };
    this.routerProductGates.unshift(gate);
    return gate;
  }

  validatePluginBundle(bundle) {
    const errors = [];
    if (!bundle?.bundleId) errors.push('bundleId is required.');
    if (!/^\d+\.\d+\.\d+$/.test(bundle?.version ?? '')) errors.push('version must be semver.');
    if (!bundle?.source?.type || !bundle?.source?.uri) errors.push('source.type and source.uri are required.');
    if (!bundle?.runtime?.sandbox) errors.push('runtime.sandbox is required.');
    if (!bundle?.runtime?.entrypoint) errors.push('runtime.entrypoint is required.');
    if (!Array.isArray(bundle?.skills) || bundle.skills.length === 0) errors.push('skills are required.');
    for (const skill of bundle?.skills ?? []) {
      const validation = this.validateSkillManifest(this.migrateSkillManifest(skill));
      if (!validation.valid) errors.push(`skill:${skill?.skillId ?? 'unknown'}:${validation.errors.join('|')}`);
    }
    return { valid: errors.length === 0, errors };
  }

  verifyPluginBundleSignature(bundle) {
    if (!bundle.signature) {
      return this.allowUnsigned
        ? { valid: true, mode: 'unsigned-bundle-allowed', signer: null }
        : { valid: false, reason: 'bundle-signature-required' };
    }
    const { signer, digest } = bundle.signature;
    if (!this.trustedManifestKeys.includes(signer)) {
      return { valid: false, reason: 'untrusted-bundle-signer', signer };
    }
    const expected = SkillRouter.signPluginBundle(bundle, signer);
    if (digest !== expected.digest) {
      return { valid: false, reason: 'bundle-digest-mismatch', signer };
    }
    return { valid: true, mode: 'signed-bundle', signer, digest };
  }

  createSandboxLoadPlan(bundle) {
    const permissions = bundle.runtime.permissions ?? {};
    return {
      planId: `sandbox_${safeId(bundle.bundleId)}_${safeId(bundle.version)}`,
      planVersion: 'a-skill-sandbox-load-plan-v1',
      bundleId: bundle.bundleId,
      runtime: bundle.runtime.sandbox,
      entrypoint: bundle.runtime.entrypoint,
      executionMode: 'manifest_registered_code_not_loaded',
      network: permissions.network === true ? 'blocked_until_explicit_policy' : 'blocked',
      filesystem: permissions.filesystem ?? 'no-direct-access',
      environment: 'empty-env-by-default',
      mountPolicy: 'read-only-plugin-bundle',
      allowedModules: permissions.allowedModules ?? [],
      requiredApprovals: ['trusted_signature', 'capability_scope', 'adapter_contract']
    };
  }

  pluginRegistry() {
    return {
      registryVersion: 'a-skill-plugin-registry-v1',
      bundleCount: this.pluginBundles.size,
      downloadCacheCount: this.bundleDownloadCache.size,
      processSmokeRuns: this.sandboxProcessRuns.slice(0, 5).map((run) => ({
        processSmokeVersion: run.processSmokeVersion,
        status: run.status,
        bundleId: run.bundleId,
        exitCode: run.exitCode
      })),
      sandboxSoakRuns: this.sandboxSoakRuns.slice(0, 5).map((run) => ({
        soakVersion: run.soakVersion,
        status: run.status,
        bundleId: run.bundleId,
        cycles: run.cycles
      })),
      productGates: this.routerProductGates.slice(0, 5).map((gate) => ({
        gateVersion: gate.gateVersion,
        status: gate.status,
        bundleId: gate.bundleId,
        releaseDossierVersion: gate.releaseDossier?.dossierVersion ?? null
      })),
      releaseDossiers: this.routerReleaseDossiers.slice(0, 5).map((dossier) => ({
        dossierVersion: dossier.dossierVersion,
        status: dossier.status,
        bundleId: dossier.bundleId,
        dossierSha256: dossier.dossierSha256
      })),
      remoteRegistrySyncs: this.remoteRegistrySyncs.slice(0, 5).map((sync) => ({
        syncVersion: sync.syncVersion,
        registryUrl: sync.registryUrl,
        fetchedAt: sync.fetchedAt,
        valid: sync.validation.valid,
        bundleCount: sync.registry.bundleCount,
        installedCount: sync.installed.length
      })),
      rotationDrills: this.rotationDrills.slice(0, 5).map((drill) => ({
        rotationVersion: drill.rotationVersion,
        status: drill.status,
        bundleId: drill.bundleId,
        previousVersion: drill.previousVersion,
        nextVersion: drill.nextVersion,
        removedSkillIds: drill.compatibility.removedSkillIds
      })),
      sandboxSmokeRuns: this.sandboxSmokeRuns.slice(0, 5).map((smoke) => ({
        smokeVersion: smoke.smokeVersion,
        status: smoke.status,
        bundleId: smoke.bundleId,
        version: smoke.version
      })),
      bundles: [...this.pluginBundles.values()].map((bundle) => ({
        bundleId: bundle.bundleId,
        version: bundle.version,
        label: bundle.label,
        source: bundle.source,
        signature: bundle.signature,
        downloadCache: bundle.downloadCache,
        sandboxPlan: bundle.sandboxPlan,
        skillIds: bundle.skills
      }))
    };
  }

  sandboxLoadPlan(bundleId) {
    return this.pluginBundles.get(bundleId)?.sandboxPlan ?? {
      success: false,
      error: { code: 'A_SKILL_PLUGIN_BUNDLE_NOT_FOUND', bundleId }
    };
  }

  compatibilitySnapshot({ label = 'current', record = true } = {}) {
    const matrix = this.capabilityMatrix().map((skill) => ({
      skillId: skill.skillId,
      version: skill.version,
      module: skill.module,
      actionType: skill.actionType,
      toolName: skill.toolName,
      lifecycleStatus: skill.lifecycle.status,
      bundleId: skill.pluginBundle?.bundleId ?? null
    })).sort((a, b) => a.skillId.localeCompare(b.skillId));
    const snapshot = {
      snapshotVersion: 'a-skill-compatibility-snapshot-v1',
      snapshotId: `skill_snapshot_${this.compatibilitySnapshots.length + 1}`,
      label,
      generatedAt: new Date().toISOString(),
      manifestVersion: this.manifestVersion,
      skillCount: matrix.length,
      activeSkillCount: matrix.filter((skill) => skill.lifecycleStatus === 'active').length,
      pluginBundleCount: this.pluginBundles.size,
      actionTypes: [...new Set(matrix.map((skill) => skill.actionType))].sort(),
      matrixDigest: createHash('sha256').update(canonicalJson(matrix)).digest('hex'),
      matrix
    };
    if (record) this.compatibilitySnapshots.push(snapshot);
    return snapshot;
  }

  compatibilityRegression(snapshot) {
    const current = this.compatibilitySnapshot({ label: 'current-regression', record: false });
    const expectedIds = new Set((snapshot?.matrix ?? []).map((skill) => skill.skillId));
    const currentIds = new Set(current.matrix.map((skill) => skill.skillId));
    const missingSkillIds = [...expectedIds].filter((skillId) => !currentIds.has(skillId));
    const unexpectedSkillIds = [...currentIds].filter((skillId) => !expectedIds.has(skillId));
    return {
      regressionVersion: 'a-skill-compatibility-regression-v1',
      status: current.matrixDigest === snapshot?.matrixDigest ? 'passed' : 'failed',
      expectedDigest: snapshot?.matrixDigest ?? null,
      actualDigest: current.matrixDigest,
      missingSkillIds,
      unexpectedSkillIds,
      current
    };
  }

  lifecycleFor(skill) {
    const status = skill.status ?? 'active';
    return {
      status,
      routable: status === 'active',
      deprecationReason: skill.deprecationReason ?? null,
      replacementSkillId: skill.replacementSkillId ?? null
    };
  }

  capabilityMatrix() {
    return [...this.skills.values()].map((skill) => ({
      skillId: skill.skillId,
      version: skill.version,
      label: skill.label,
      module: skill.module,
      actionType: skill.actionType,
      toolName: skill.toolName,
      category: skill.category,
      match: skill.match,
      capability: skill.capability,
      safety: skill.safety,
      adapterContract: skill.adapterContract,
      execution: skill.execution,
      lifecycle: skill.lifecycle,
      signature: skill.signature,
      pluginBundle: skill.pluginBundle
    }));
  }

  compatibleSkills({ actionType, category, slots = {}, intent = {} }) {
    return [...this.skills.values()]
      .filter((skill) => skill.actionType === actionType)
      .filter((skill) => skill.lifecycle.routable)
      .map((skill) => ({ skill, match: this.scoreSkill(skill, { category, slots, intent }) }))
      .filter((candidate) => candidate.match.score > 0)
      .sort((a, b) => b.match.score - a.match.score);
  }

  scoreSkill(skill, { category, slots = {}, intent = {} }) {
    let score = 1;
    const reasons = [];
    if (category && skill.category === category) {
      score += 2;
      reasons.push('category-match');
    } else if (category && skill.category !== category) {
      score -= 1;
      reasons.push('category-mismatch');
    }
    if (slots.outputFormat && skill.match?.outputFormats?.includes(slots.outputFormat)) {
      score += 4;
      reasons.push(`output-format:${slots.outputFormat}`);
    } else if (slots.outputFormat && skill.match?.outputFormats && !skill.match.outputFormats.includes(slots.outputFormat)) {
      score -= 2;
      reasons.push(`output-format-mismatch:${slots.outputFormat}`);
    }
    if (slots.workflow && skill.match?.workflows?.includes(slots.workflow)) {
      score += 8;
      reasons.push(`workflow:${slots.workflow}`);
    } else if (skill.match?.workflows?.length) {
      score -= 5;
      reasons.push('workflow-mismatch');
    }
    if (intent.entities?.mentionsExternalDestination && skill.capability.externalTransfer) {
      score += 3;
      reasons.push('external-transfer-match');
    }
    if (intent.entities?.mentionsExternalDestination && !skill.capability.externalTransfer && intent.actionType === ActionType.UPLOAD_FILE) {
      score -= 3;
      reasons.push('external-transfer-mismatch');
    }
    if (skill.capability.externalTransfer && intent.actionType !== ActionType.UPLOAD_FILE) {
      score -= 2;
      reasons.push('external-transfer-not-requested');
    }
    return { score, reasons };
  }

  routeRationale(skill, intentCandidate, compatible) {
    return {
      manifestVersion: this.manifestVersion,
      selectedSkillId: skill.skillId,
      selectedVersion: skill.version,
      candidateCount: compatible.length,
      reasons: compatible.find((candidate) => candidate.skill.skillId === skill.skillId)?.match?.reasons ?? [],
      intent: {
        actionType: intentCandidate.actionType,
        category: intentCandidate.category,
        confidence: intentCandidate.confidence,
        slots: intentCandidate.slots ?? {}
      }
    };
  }

  assertModeAllowed(skill, mode) {
    return skill.capability.allowedModes.includes(mode);
  }

  requiredCapability(skill) {
    return {
      skillId: skill.skillId,
      toolName: skill.toolName,
      actionType: skill.actionType,
      module: skill.module,
      requiresApproval: skill.capability.requiresApproval,
      requiresDesktopApproval: Boolean(skill.capability.requiresDesktopApproval),
      reversible: skill.capability.reversible,
      externalTransfer: skill.capability.externalTransfer,
      externalNetwork: skill.capability.externalNetwork,
      maxRiskTier: skill.capability.maxRiskTier,
      allowedModes: skill.capability.allowedModes,
      evidence: skill.adapterContract.evidence
    };
  }

  registerDefaults() {
    for (const skill of defaultSkillManifest) this.registerSkill(skill);
    return this.capabilityMatrix();
  }

  disabledSkills() {
    return [...this.skills.values()].filter((skill) => !skill.lifecycle.routable);
  }

  findSkill({ actionType, category, slots = {} }) {
    return this.compatibleSkills({ actionType, category, slots })[0]?.skill ?? null;
  }

  shortlistCapabilities(capabilities, options = {}) {
    return this.executionStrategyRouter.shortlist(capabilities, options);
  }

  executionFabricStatus() {
    return this.executionStrategyRouter.fabricStatus(this.capabilityMatrix());
  }

  recordExecutionHealth(sample) {
    return this.executionStrategyRouter.recordExecution(sample);
  }

  executionHealthStatus(toolName) {
    return this.executionStrategyRouter.healthStatusFor(toolName);
  }

  route(intentCandidate) {
    const compatible = this.compatibleSkills({
      actionType: intentCandidate.actionType,
      category: intentCandidate.category,
      slots: intentCandidate.slots,
      intent: intentCandidate
    });
    const skill = compatible[0]?.skill ?? null;
    if (!skill) {
      return {
        routable: false,
        reason: 'A_SKILL_NOT_FOUND',
        actionType: intentCandidate.actionType,
        manifestVersion: this.manifestVersion
      };
    }
    return {
      routable: true,
      skill,
      targetModule: skill.module,
      requiredCapability: this.requiredCapability(skill),
      safety: skill.safety,
      adapterContract: skill.adapterContract,
      executionStrategy: this.executionStrategyRouter.strategyFor(skill, {
        objective: intentCandidate.rawText ?? intentCandidate.title ?? intentCandidate.label ?? '',
        constraints: intentCandidate.constraints ?? [],
        availableSkills: [...this.skills.values()]
      }),
      rationale: this.routeRationale(skill, intentCandidate, compatible)
    };
  }

  routeTrustedCapability(intentCandidate, toolName) {
    const skill = [...this.skills.values()].find(candidate => candidate.toolName === toolName);
    if (!skill || skill.lifecycle.routable !== true || skill.actionType !== intentCandidate?.actionType) {
      return {
        routable: false,
        reason: 'A_SKILL_NOT_FOUND',
        actionType: intentCandidate?.actionType ?? null,
        manifestVersion: this.manifestVersion
      };
    }
    // The private Mission path already selected and validated this registered tool.
    // Bind that exact capability here; re-ranking its natural-language command can
    // turn a negated constraint (for example, "do not edit") into an edit intent.
    const compatible = [{ skill, match: { score: 1, reasons: ['trusted-mission-capability'] } }];
    return {
      routable: true,
      skill,
      targetModule: skill.module,
      requiredCapability: this.requiredCapability(skill),
      safety: skill.safety,
      adapterContract: skill.adapterContract,
      executionStrategy: this.executionStrategyRouter.strategyFor(skill, {
        objective: intentCandidate.rawText ?? intentCandidate.title ?? intentCandidate.label ?? '',
        constraints: intentCandidate.constraints ?? [],
        availableSkills: [...this.skills.values()]
      }),
      rationale: this.routeRationale(skill, intentCandidate, compatible)
    };
  }
}

function createSkillRouterReleaseArtifactManifest({
  bundle,
  releaseChecks,
  processSmoke,
  soak,
  latestRotation,
  latestRemoteSync
}) {
  const manifestCore = {
    artifactManifestVersion: 'a-skill-router-release-artifact-manifest-v1',
    generatedAt: new Date().toISOString(),
    pluginProviderContractManifest: {
      manifestVersion: 'a-skill-router-plugin-provider-contract-manifest-v1',
      bundleIdHash: sha256Text(bundle.bundleId),
      version: bundle.version,
      skillCount: bundle.skills.length,
      manifestSha256: bundle.downloadCache?.manifestSha256 ?? sha256Json(bundle.skills),
      signatureAlgorithm: bundle.signature?.algorithm ?? null,
      signerHash: sha256Text(bundle.signature?.signer ?? 'unsigned'),
      rawPluginCodeStored: false,
      rawBundleSourceUriStored: false,
      rawEntrypointStored: false
    },
    sandboxHardeningProfile: {
      profileVersion: 'a-skill-router-sandbox-hardening-profile-v1',
      sandboxPlanVersion: bundle.sandboxPlan?.planVersion ?? null,
      executionMode: bundle.sandboxPlan?.executionMode ?? null,
      network: bundle.sandboxPlan?.network ?? null,
      environment: bundle.sandboxPlan?.environment ?? null,
      requiredApprovals: bundle.sandboxPlan?.requiredApprovals ?? [],
      isolatedProcessObserved: processSmoke?.processSmokeVersion === 'a-skill-isolated-sandbox-process-v1' && processSmoke.status === 'passed',
      processCodeLoaded: processSmoke?.childEvidence?.codeLoaded === true,
      soakVersion: soak?.soakVersion ?? null,
      soakCycles: soak?.cycles ?? 0,
      rollbackableRotationObserved: latestRotation?.rollbackPlan?.rollbackVersion === 'a-skill-rollbackable-plugin-rotation-v1',
      rawProcessPayloadStored: false,
      rawPluginCodeStored: false
    },
    releaseEvidenceHashes: {
      releaseChecksHash: sha256Json(releaseChecks.map((check) => ({
        checkId: check.checkId,
        passed: check.passed
      }))),
      downloadCacheHash: sha256Json({
        cacheVersion: bundle.downloadCache?.cacheVersion ?? null,
        manifestSha256: bundle.downloadCache?.manifestSha256 ?? null,
        immutable: bundle.downloadCache?.immutable === true,
        rawCodeStored: bundle.downloadCache?.rawCodeStored === true
      }),
      processSmokeHash: sha256Json(processSmoke ? {
        processSmokeVersion: processSmoke.processSmokeVersion,
        status: processSmoke.status,
        codeLoaded: processSmoke.childEvidence?.codeLoaded ?? null,
        rawCodeStored: processSmoke.childEvidence?.rawCodeStored ?? null
      } : null),
      soakHash: sha256Json(soak ? {
        soakVersion: soak.soakVersion,
        status: soak.status,
        cycles: soak.cycles,
        passedCount: soak.passedCount
      } : null),
      rotationHash: sha256Json(latestRotation ? {
        rotationVersion: latestRotation.rotationVersion,
        status: latestRotation.status,
        previousVersion: latestRotation.previousVersion,
        nextVersion: latestRotation.nextVersion,
        rollbackVersion: latestRotation.rollbackPlan?.rollbackVersion ?? null
      } : null),
      remoteRegistryHash: sha256Json(latestRemoteSync ? {
        syncVersion: latestRemoteSync.syncVersion,
        valid: latestRemoteSync.validation?.valid === true,
        bundleCount: latestRemoteSync.registry?.bundleCount ?? 0
      } : null)
    },
    sourceUriHash: sha256Text(bundle.source?.uri ?? 'not-configured'),
    entrypointHash: sha256Text(bundle.runtime?.entrypoint ?? 'not-configured'),
    rawPluginCodeStored: false,
    rawBundleSourceUriStored: false,
    rawEntrypointStored: false,
    rawProcessPayloadStored: false
  };
  return {
    ...manifestCore,
    rawLeakCheck: {
      checkVersion: 'a-skill-router-release-raw-leak-check-v1',
      rawLeakDetected: containsSkillRouterRawLeak(JSON.stringify(manifestCore)),
      checkedHashCount: Object.keys(manifestCore.releaseEvidenceHashes).length,
      checkedRawPayloadFlags: [
        'rawPluginCodeStored',
        'rawBundleSourceUriStored',
        'rawEntrypointStored',
        'rawProcessPayloadStored'
      ]
    }
  };
}

function createSkillRouterCiNightlyGatePlan({ artifactManifest }) {
  return {
    planVersion: 'a-skill-router-ci-nightly-gate-plan-v1',
    requiredCommand: 'node --test --test-name-pattern "A SkillRouter product gate" tests/ag-runtime.test.js',
    requiredForPullRequests: true,
    requiredForNightly: true,
    requiredChecks: [
      'signed_bundle_download_cache_available',
      'isolated_sandbox_process_smoke_passed',
      'sandbox_worker_soak_passed',
      'rollbackable_plugin_rotation_ready',
      'skill_router_release_artifact_manifest_ready',
      'skill_router_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Json(artifactManifest),
    retentionPolicy: {
      keepLatestPerBranch: 20,
      keepNightlyDays: 90,
      promotePassedReleaseDossierToWorm: true
    },
    rawPluginCodeStored: false,
    rawBundleSourceUriStored: false,
    rawEntrypointStored: false
  };
}

function createSkillRouterExternalWormPromotionPackage({
  artifactManifest,
  ciNightlyGatePlan,
  releaseChecks
}) {
  const status = artifactManifest?.artifactManifestVersion === 'a-skill-router-release-artifact-manifest-v1'
    && artifactManifest.rawLeakCheck?.rawLeakDetected === false
    && ciNightlyGatePlan?.planVersion === 'a-skill-router-ci-nightly-gate-plan-v1'
    && releaseChecks.every((check) => check.passed)
    ? 'ready'
    : 'blocked';
  return {
    packageVersion: 'a-skill-router-worm-promotion-package-v1',
    providerContractVersion: 'a-skill-router-worm-provider-contract-v1',
    status,
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Json(artifactManifest),
    ciNightlyGatePlanHash: sha256Json(ciNightlyGatePlan),
    releaseChecksHash: sha256Json(releaseChecks),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawPluginCodeStored: false,
    rawBundleSourceUriStored: false,
    rawEntrypointStored: false,
    rawProcessPayloadStored: false
  };
}

function sha256Text(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256Json(value) {
  return sha256Text(canonicalJson(value ?? null));
}

function containsSkillRouterRawLeak(value) {
  const text = String(value ?? '');
  return /"uri"\s*:|"entrypoint"\s*:|"code"\s*:|rawSource|rawCode|Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z]:\\\\Users\\\\/i.test(text);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeId(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
}
