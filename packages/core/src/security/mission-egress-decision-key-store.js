import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hardenWindowsSecretFile, protectWithWindowsDpapi, unprotectWithWindowsDpapi } from '../../../shared/src/product-runtime-secrets.js';

const STORE_VERSION = 'a-mission-egress-decision-key-store-v1';
const PROVIDER = 'windows-dpapi-current-user';
const canonical = value => JSON.stringify(normalize(value));
const codedError = (code, cause = null, operationStage = null) => Object.assign(
  new Error(code, cause ? { cause } : undefined),
  { code, ...(operationStage ? { operationStage } : {}) }
);

function acquireLock(path, busyCode, errorCode) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return fd;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve initialization failure */ } try { rmSync(path, { force: true }); } catch { /* preserve initialization failure */ } }
      if (error.code !== 'EEXIST') throw codedError(errorCode, error);
      try {
        const lock = JSON.parse(readFileSync(path, 'utf8'));
        const stale = Number.isInteger(lock.pid) && Date.now() - Date.parse(lock.createdAt) > 120_000
          && !processIsAlive(lock.pid);
        if (stale) { rmSync(path, { force: true }); continue; }
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
      }
      throw codedError(busyCode);
    }
  }
  throw codedError(busyCode);
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function normalize(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
      throw codedError('A_MISSION_EGRESS_CLAIMS_INVALID');
}

export const missionEgressDecisionKeyPath = (env = process.env) => resolve(
  env.LOCALAPPDATA || join(homedir(), '.jarvis'), 'JARVIS', 'security', 'mission-egress-decision-key.json'
);

/**
 * Fail-closed local signing-key storage for scoped Mission egress decisions.
 * The private key is sealed with Windows DPAPI CurrentUser; there is no
 * plaintext or environment-secret fallback. A same-user process can still
 * invoke DPAPI, so this protects the key at rest, not against same-user malware.
 */
export class MissionEgressDecisionKeyStore {
  constructor({ path = missionEgressDecisionKeyPath(), platform = process.platform,
    protect = protectWithWindowsDpapi, unprotect = unprotectWithWindowsDpapi,
    harden = hardenWindowsSecretFile, randomUUIDImpl = randomUUID, clock = () => new Date() } = {}) {
    this.path = resolve(path);
    this.platform = platform;
    this.protect = protect;
    this.unprotect = unprotect;
    this.harden = harden;
    this.randomUUID = randomUUIDImpl;
    this.clock = clock;
  }

  initialize({ initializedBy = 'local-operator' } = {}) {
    this.#assertPlatform();
    if (typeof initializedBy !== 'string' || !initializedBy.trim() || initializedBy.length > 128) {
      throw codedError('A_MISSION_EGRESS_KEY_INITIALIZER_INVALID');
    }
    if (existsSync(this.path)) return this.status();
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.init-lock`;
    let lockFd;
    lockFd = acquireLock(lockPath, 'A_MISSION_EGRESS_KEYSTORE_INITIALIZATION_BUSY', 'A_MISSION_EGRESS_KEYSTORE_INITIALIZATION_FAILED');
    try {
      closeSync(lockFd); lockFd = undefined;
      if (existsSync(this.path)) return this.status();
      const pair = generateKeyPairSync('ed25519');
      const privateDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
      const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
      const keyId = this.#keyId(publicDer);
      const clear = Buffer.from(JSON.stringify({ version: STORE_VERSION, keyId,
        privateKeyDer: privateDer.toString('base64'), publicKeyDer: publicDer.toString('base64'),
        createdAt: new Date().toISOString(), initializedBy: initializedBy.trim() }), 'utf8').toString('base64');
      privateDer.fill(0);
      const temporary = `${this.path}.${this.randomUUID()}.tmp`;
      let operationStage = 'dpapi-protect';
      try {
        const envelope = JSON.stringify({ version: STORE_VERSION, provider: PROVIDER, protectedPayload: this.protect(clear) });
        operationStage = 'write-temporary-file';
        writeFileSync(temporary, `${envelope}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        operationStage = 'acl-harden';
        this.harden(temporary);
        operationStage = 'atomic-rename';
        renameSync(temporary, this.path);
      } catch (error) {
        try { rmSync(temporary, { force: true }); } catch { /* retain original failure */ }
        throw codedError('A_MISSION_EGRESS_KEYSTORE_WRITE_FAILED', error, operationStage);
      }
      const status = this.status();
      if (!status.signingEnabled) throw codedError('A_MISSION_EGRESS_KEYSTORE_WRITE_FAILED', null, 'post-write-readback');
      return status;
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      try { rmSync(lockPath, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  }

  signDecision(claims) {
    const record = this.#read();
    this.#validateClaims(claims);
    const payload = canonical(claims);
    const privateDer = Buffer.from(record.privateKeyDer, 'base64');
    try {
      const signature = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey({ key: privateDer, type: 'pkcs8', format: 'der' }));
      return { version: STORE_VERSION, algorithm: 'Ed25519', keyId: record.keyId,
        claims: JSON.parse(payload), signature: signature.toString('base64url') };
    } catch (error) {
      throw codedError('A_MISSION_EGRESS_SIGN_FAILED', error);
    } finally { privateDer.fill(0); }
  }

  verifyDecision(envelope) {
    if (!envelope || envelope.version !== STORE_VERSION || envelope.algorithm !== 'Ed25519'
      || typeof envelope.signature !== 'string' || !envelope.claims || typeof envelope.claims !== 'object') return false;
    try {
      const record = this.#read();
      if (envelope.keyId !== record.keyId) return false;
      const publicDer = Buffer.from(record.publicKeyDer, 'base64');
      try { return verify(null, Buffer.from(canonical(envelope.claims), 'utf8'),
        createPublicKey({ key: publicDer, type: 'spki', format: 'der' }), Buffer.from(envelope.signature, 'base64url')); }
      finally { publicDer.fill(0); }
    } catch { return false; }
  }

  rotate({ rotatedBy = 'local-operator' } = {}) {
    this.#assertPlatform();
    if (typeof rotatedBy !== 'string' || !rotatedBy.trim() || rotatedBy.length > 128) {
      throw codedError('A_MISSION_EGRESS_KEY_ROTATOR_INVALID');
    }
    const lockPath = `${this.path}.rotate-lock`;
    let lockFd;
    lockFd = acquireLock(lockPath, 'A_MISSION_EGRESS_KEYSTORE_ROTATION_BUSY', 'A_MISSION_EGRESS_KEYSTORE_ROTATION_FAILED');
    try {
    closeSync(lockFd); lockFd = undefined;
    const old = this.#read();
    const pair = generateKeyPairSync('ed25519');
    const privateDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
    const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
    const keyId = this.#keyId(publicDer);
    const clear = Buffer.from(JSON.stringify({ version: STORE_VERSION, keyId,
      privateKeyDer: privateDer.toString('base64'), publicKeyDer: publicDer.toString('base64'),
      createdAt: new Date().toISOString(), rotatesKeyId: old.keyId, rotatedBy: rotatedBy.trim() }), 'utf8').toString('base64');
    privateDer.fill(0);
    const temporary = `${this.path}.${this.randomUUID()}.rotate`;
    let operationStage = 'dpapi-protect';
    try {
      const protectedPayload = this.protect(clear);
      operationStage = 'write-temporary-file';
      writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, provider: PROVIDER,
        protectedPayload })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      operationStage = 'acl-harden';
      this.harden(temporary);
      operationStage = 'atomic-rename';
      renameSync(temporary, this.path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* retain original failure */ }
      throw codedError('A_MISSION_EGRESS_KEYSTORE_ROTATION_FAILED', error, operationStage);
    }
    let next;
    try { next = this.#read(); }
    catch (error) { throw codedError('A_MISSION_EGRESS_KEYSTORE_ROTATION_FAILED', error, 'post-write-readback'); }
    return { previousKeyId: old.keyId, activeKeyId: next.keyId,
      previousKeyRevoked: true, existingGrantsRemainValid: false };
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      try { rmSync(lockPath, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  }

  recoverUnreadable({ recoveredBy = 'local-operator' } = {}) {
    this.#assertPlatform();
    if (typeof recoveredBy !== 'string' || !recoveredBy.trim() || recoveredBy.length > 128) {
      throw codedError('A_MISSION_EGRESS_KEY_RECOVERER_INVALID');
    }
    const lockPath = `${this.path}.rotate-lock`;
    let lockFd = acquireLock(lockPath, 'A_MISSION_EGRESS_KEYSTORE_RECOVERY_BUSY', 'A_MISSION_EGRESS_KEYSTORE_RECOVERY_FAILED');
    try {
      closeSync(lockFd); lockFd = undefined;
      if (!existsSync(this.path)) throw codedError('A_MISSION_EGRESS_KEYSTORE_RECOVERY_NOT_NEEDED');
      const currentStatus = this.status();
      if (currentStatus.signingEnabled) throw codedError('A_MISSION_EGRESS_KEYSTORE_RECOVERY_NOT_NEEDED');
      if (currentStatus.reason !== 'key-store-unreadable') throw codedError('A_MISSION_EGRESS_KEYSTORE_RECOVERY_STATE_INVALID');
      const previousEnvelopeSha256 = createHash('sha256').update(readFileSync(this.path)).digest('hex');
      const pair = generateKeyPairSync('ed25519');
      const privateDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
      const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
      const keyId = this.#keyId(publicDer);
      const clear = Buffer.from(JSON.stringify({ version: STORE_VERSION, keyId,
        privateKeyDer: privateDer.toString('base64'), publicKeyDer: publicDer.toString('base64'),
        createdAt: new Date().toISOString(), recoveredBy: recoveredBy.trim(), previousEnvelopeSha256 }), 'utf8').toString('base64');
      privateDer.fill(0);
      const temporary = `${this.path}.${this.randomUUID()}.recover`;
      let operationStage = 'dpapi-protect';
      try {
        const protectedPayload = this.protect(clear);
        operationStage = 'write-temporary-file';
        writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, provider: PROVIDER,
          protectedPayload })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        operationStage = 'acl-harden';
        this.harden(temporary);
        operationStage = 'atomic-rename';
        renameSync(temporary, this.path);
      } catch (error) {
        try { rmSync(temporary, { force: true }); } catch { /* preserve recovery failure */ }
        throw codedError('A_MISSION_EGRESS_KEYSTORE_RECOVERY_FAILED', error, operationStage);
      }
      let recovered;
      try { recovered = this.#read(); }
      catch (error) { throw codedError('A_MISSION_EGRESS_KEYSTORE_RECOVERY_FAILED', error, 'post-write-readback'); }
      return { recovered: true, activeKeyId: recovered.keyId, recoveredBy: recovered.recoveredBy,
        previousEnvelopeSha256, previousKeyRevoked: true, existingGrantsRemainValid: false };
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      try { rmSync(lockPath, { force: true }); } catch { /* retain the recovery result */ }
    }
  }

  status() {
    if (this.platform !== 'win32') return { configured: false, provider: 'unavailable', protectedByOs: false,
      signingEnabled: false, reason: 'windows-dpapi-required' };
    if (!existsSync(this.path)) return { configured: false, provider: PROVIDER, protectedByOs: true,
      signingEnabled: false, reason: 'key-not-initialized' };
    try {
      const record = this.#read();
      return { configured: true, provider: PROVIDER, protectedByOs: true, signingEnabled: true,
        algorithm: 'Ed25519', keyId: record.keyId, createdAt: record.createdAt ?? null,
        initializedBy: record.initializedBy ?? null, rotatedBy: record.rotatedBy ?? null,
        rotatesKeyId: record.rotatesKeyId ?? null, recoveredBy: record.recoveredBy ?? null,
        previousEnvelopeSha256: record.previousEnvelopeSha256 ?? null, privateKeyExported: false };
    } catch {
      return { configured: false, provider: PROVIDER, protectedByOs: true, signingEnabled: false,
        reason: 'key-store-unreadable' };
    }
  }

  #read() {
    this.#assertPlatform();
    let envelope;
    try { envelope = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { throw codedError('A_MISSION_EGRESS_KEYSTORE_UNREADABLE', error); }
    if (envelope.version !== STORE_VERSION || envelope.provider !== PROVIDER || typeof envelope.protectedPayload !== 'string') {
      throw codedError('A_MISSION_EGRESS_KEYSTORE_METADATA_INVALID');
    }
    try {
      const clear = Buffer.from(this.unprotect(envelope.protectedPayload), 'base64').toString('utf8');
      const record = JSON.parse(clear);
      if (record.version !== STORE_VERSION || typeof record.privateKeyDer !== 'string' || typeof record.publicKeyDer !== 'string'
        || record.keyId !== this.#keyId(Buffer.from(record.publicKeyDer, 'base64'))) throw new Error('metadata');
      const privateDer = Buffer.from(record.privateKeyDer, 'base64');
      const publicDer = Buffer.from(record.publicKeyDer, 'base64');
      try {
        const derivedPublic = createPublicKey(createPrivateKey({ key: privateDer, type: 'pkcs8', format: 'der' })).export({ type: 'spki', format: 'der' });
        if (!derivedPublic.equals(publicDer)) throw new Error('keypair');
      } finally { privateDer.fill(0); publicDer.fill(0); }
      return record;
    } catch (error) { throw codedError('A_MISSION_EGRESS_KEYSTORE_UNSEAL_FAILED', error); }
  }

  #keyId(publicDer) { return `sha256:${createHash('sha256').update(publicDer).digest('hex').slice(0, 24)}`; }
  #assertPlatform() { if (this.platform !== 'win32') throw codedError('A_MISSION_EGRESS_KEYSTORE_UNAVAILABLE'); }
  #validateClaims(claims) {
    const issuedAt = Date.parse(claims?.issuedAt ?? ''), expiresAt = Date.parse(claims?.expiresAt ?? ''), now = this.clock().getTime();
    const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
    if (!claims || claims.decision !== 'allow' || !identifier(claims.decisionId) || !identifier(claims.missionId)
      || !identifier(claims.callKey) || !identifier(claims.providerId) || !identifier(claims.toolName)
      || !/^[a-f0-9]{64}$/u.test(claims.contentSha256 ?? '') || claims.use !== 'single-call'
      || !identifier(claims.approvedBy) || !identifier(claims.policyVersion)
      || !['policy-auto', 'mission-gate'].includes(claims.authorizationMode)
      || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 30_000
      || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 300_000
      || claims.authorizationMode === 'mission-gate' && !identifier(claims.gateId)
      || claims.authorizationMode === 'policy-auto' && (claims.gateId != null || !claims.approvedBy.startsWith('policy:'))) {
      throw codedError('A_MISSION_EGRESS_CLAIMS_INVALID');
    }
  }
}
