import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync as removePathSync, writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CapabilityPackagePromotionJournal } from '../packages/core/src/capabilities/capability-package-promotion-journal.js';
import { CapabilityPackagePromotionManager } from '../packages/core/src/capabilities/capability-package-promotion.js';
import { RuntimeTrustKernel } from '../packages/core/src/security/runtime-trust-kernel.js';

function fixtureSigner(key = 'journal-test-key') {
  return {
    keyId: 'fixture-key-v1',
    sign: value => createHmac('sha256', key).update(String(value)).digest('base64url'),
    verify: (value, signature) => createHmac('sha256', key).update(String(value)).digest('base64url') === signature
  };
}

function fixtureTrustKernel() {
  const anchors = new Map();
  return {
    anchors,
    verifyLocalJournalHead(id, head) {
      const current = anchors.get(id) ?? { sequence: 0, headHash: 'GENESIS' };
      if (head.sequence < current.sequence) return { valid: false, reason: 'journal-truncated-or-replayed' };
      if (head.sequence === current.sequence && head.headHash !== current.headHash) return { valid: false, reason: 'journal-anchor-mismatch' };
      return { valid: true, needsAnchor: head.sequence > current.sequence };
    },
    anchorLocalJournalHead(id, head) {
      const checked = this.verifyLocalJournalHead(id, head);
      if (!checked.valid) throw Object.assign(new Error(checked.reason), { code: 'A_TRUST_LOCAL_JOURNAL_ANCHOR_INVALID' });
      anchors.set(id, head);
    }
  };
}

test('signed promotion journal recovers a verified head without persisting owner session IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-'));
  const filePath = join(dir, 'promotion.jsonl');
  const signer = fixtureSigner();
  const trustKernel = fixtureTrustKernel();
  try {
    const first = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    first.append('stage_created', { stageId: 'stage-1', packageDigest: 'a'.repeat(64) });
    first.append('owner_reviewed', { stageId: 'stage-1', ownerSessionId: 'must-not-persist', reviewerFingerprint: 'b'.repeat(64) });
    const raw = await readFile(filePath, 'utf8');
    assert.equal(raw.includes('must-not-persist'), false);

    const recovered = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    assert.equal(recovered.status().integrity, 'verified');
    assert.equal(recovered.status().sequence, 2);
    assert.deepEqual(recovered.status().unfinishedStages, [{ stageId: 'stage-1', lastEvent: 'owner_reviewed' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('valid signatures from a different journal identity cannot become recovery history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jarvis-promotion-domain-')),filePath=join(dir,'promotion.jsonl');
 const signer=fixtureSigner(),trustKernel=fixtureTrustKernel();
 try{
  const first=new CapabilityPackagePromotionJournal({filePath,signer,trustKernel,journalId:'different-journal'});
  first.append('stage_created',{stageId:'other-domain-stage'});
  assert.throws(()=>new CapabilityPackagePromotionJournal({filePath,signer,trustKernel}),{code:'A_CAPABILITY_PACKAGE_JOURNAL_INVALID'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('signed promotion journal detects tampering and truncation against the trust-state anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-tamper-'));
  const filePath = join(dir, 'promotion.jsonl');
  const signer = fixtureSigner();
  const trustKernel = fixtureTrustKernel();
  try {
    const journal = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    journal.append('stage_created', { stageId: 'stage-1' });
    journal.append('evaluation_passed', { stageId: 'stage-1', evidenceRef: 'run:2' });
    const lines = (await readFile(filePath, 'utf8')).trimEnd().split(/\r?\n/u);
    await writeFile(filePath, `${lines[0]}\n`, 'utf8');
    assert.throws(() => new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel }), { code: 'A_CAPABILITY_PACKAGE_JOURNAL_ANCHOR_INVALID' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn JSONL tail is preserved and blocks promotion-journal recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-torn-'));
  const filePath = join(dir, 'promotion.jsonl');
  const signer = fixtureSigner();
  const trustKernel = fixtureTrustKernel();
  try {
    const journal = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    journal.append('promotion_started', { stageId: 'partially-written-promotion' });
    await appendFile(filePath, '{"journalVersion":"a-capability-package-promotion-journal-v1"', 'utf8');
    const damagedBytes = await readFile(filePath, 'utf8');

    assert.throws(() => new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel }), {
      code: 'A_CAPABILITY_PACKAGE_JOURNAL_TORN_TAIL'
    });
    assert.equal(await readFile(filePath, 'utf8'), damagedBytes, 'recovery must preserve damaged bytes for operator review');
    assert.deepEqual(trustKernel.anchors.get('capability-package-promotions'), journal.head(),
      'invalid trailing bytes must not advance or erase the signed anchor');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a trust-state anchor persistence failure leaves a valid suffix that restart can safely reconcile', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-anchor-write-failure-'));
  const filePath = join(dir, 'promotion.jsonl');
  const statePath = join(dir, 'trust-state.json');
  const keyPath = join(dir, 'trust-key.json');
  try {
    const kernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    if (kernel.keyProvider.persistent !== true || kernel.keyProvider.fallback === true) {
      t.skip('Protected persistent runtime trust key is unavailable on this host.');
      return;
    }
    const previousPersist = kernel.persistState.bind(kernel);
    kernel.persistState = reason => {
      if (reason === 'local-journal-anchor:capability-package-promotions') {
        throw Object.assign(new Error('injected trust-state persistence failure'), { code: 'A_TRUST_STATE_PERSIST_INJECTED' });
      }
      return previousPersist(reason);
    };
    const journal = new CapabilityPackagePromotionJournal({
      filePath,
      signer: kernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }),
      trustKernel: kernel
    });
    assert.throws(() => journal.append('promotion_started', { stageId: 'anchor-failure-stage' }), {
      code: 'A_CAPABILITY_PACKAGE_JOURNAL_WRITE_FAILED', causeCode: 'A_TRUST_STATE_PERSIST_INJECTED'
    });

    const recoveredKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    const signer = recoveredKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' });
    const raw = await readFile(filePath, 'utf8');
    const durableRecord = JSON.parse(raw.trimEnd().split(/\r?\n/u).at(-1));
    assert.equal(recoveredKernel.verifyLocalJournalHead('capability-package-promotions', {
      sequence: durableRecord.sequence, headHash: durableRecord.recordHash
    }).needsAnchor, true);

    const recoveredJournal = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel: recoveredKernel });
    assert.equal(recoveredJournal.status().sequence, 1);
    assert.deepEqual(recoveredJournal.status().pendingTransitions, [{ id: 'anchor-failure-stage', operation: 'promotion' }]);
    const manager = new CapabilityPackagePromotionManager({ registry: {}, targets: {}, journal: recoveredJournal });
    assert.throws(() => manager.stage({}), { code: 'A_CAPABILITY_PACKAGE_RECOVERY_REQUIRED' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a real Windows trust-state replacement failure preserves the prior anchor and reconciles the journal on restart', async t => {
  if (process.platform !== 'win32') {
    t.skip('This replacement-failure behavior is specific to the Windows trust-state file replacement path.');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-rename-failure-'));
  const filePath = join(dir, 'promotion.jsonl');
  const statePath = join(dir, 'trust-state.json');
  const keyPath = join(dir, 'trust-key.json');
  const backupPath = join(dir, 'trust-state.backup.json');
  try {
    const kernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    if (kernel.keyProvider.persistent !== true || kernel.keyProvider.fallback === true) {
      t.skip('Protected persistent runtime trust key is unavailable on this host.');
      return;
    }
    const previousPersist = kernel.persistState.bind(kernel);
    kernel.persistState = reason => {
      if (reason !== 'local-journal-anchor:capability-package-promotions') return previousPersist(reason);
      renameSync(statePath, backupPath);
      mkdirSync(statePath);
      writeFileSync(join(statePath, 'block-replacement'), 'keep target as a non-empty directory');
      try {
        return previousPersist(reason);
      } finally {
        removePathSync(statePath, { recursive: true, force: true });
        renameSync(backupPath, statePath);
      }
    };
    const journal = new CapabilityPackagePromotionJournal({
      filePath,
      signer: kernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }),
      trustKernel: kernel
    });
    assert.throws(() => journal.append('promotion_started', { stageId: 'rename-failure-stage' }), error =>
      error.code === 'A_CAPABILITY_PACKAGE_JOURNAL_WRITE_FAILED'
      && ['EPERM', 'EACCES', 'EISDIR', 'ENOTDIR'].includes(error.causeCode));
    assert.ok(readdirSync(dir).some(name => name.startsWith('trust-state.json.') && name.endsWith('.tmp')),
      'failed replacement must leave the written temporary state visible for crash diagnostics');

    const recoveredKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    const signer = recoveredKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' });
    const durableRecord = JSON.parse((await readFile(filePath, 'utf8')).trimEnd().split(/\r?\n/u).at(-1));
    assert.equal(recoveredKernel.verifyLocalJournalHead('capability-package-promotions', {
      sequence: durableRecord.sequence, headHash: durableRecord.recordHash
    }).needsAnchor, true);
    const recovered = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel: recoveredKernel });
    assert.deepEqual(recovered.status().pendingTransitions, [{ id: 'rename-failure-stage', operation: 'promotion' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows child termination after trust-state temp write or successful rename preserves pending promotion', async t => {
  if (process.platform !== 'win32') {
    assert.ok(true, 'Windows filesystem boundary test is skipped on other platforms');
    return;
  }
  const journalUrl = new URL('../packages/core/src/capabilities/capability-package-promotion-journal.js', import.meta.url).href;
  const kernelUrl = new URL('../packages/core/src/security/runtime-trust-kernel.js', import.meta.url).href;
  for (const boundary of ['after-temp-write', 'after-state-rename']) {
    const dir = await mkdtemp(join(tmpdir(), `jarvis-promotion-state-kill-${boundary}-`));
    const filePath = join(dir, 'promotion.jsonl');
    const statePath = join(dir, 'trust-state.json');
    const keyPath = join(dir, 'trust-key.json');
    const signalPath = join(dir, 'boundary-reached.signal');
    const releasePath = join(dir, 'parent-kill.signal');
    const initial = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    if (initial.keyProvider.persistent !== true || initial.keyProvider.fallback === true) {
      await rm(dir, { recursive: true, force: true });
      t.skip('Protected persistent runtime trust key is unavailable on this host.');
      return;
    }
    t.after(() => rm(dir, { recursive: true, force: true }));
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync.bind(fs);
      const rename = fs.renameSync.bind(fs);
      let armed = false;
      function pauseAt(label) {
        write(${JSON.stringify(signalPath)}, label, 'utf8');
        while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      fs.writeFileSync = (target, ...args) => {
        const result = write(target, ...args);
        if (armed && typeof target === 'string' && target.startsWith(${JSON.stringify(statePath + '.')}) && target.endsWith('.tmp') && ${JSON.stringify(boundary)} === 'after-temp-write') pauseAt('temp-written');
        return result;
      };
      fs.renameSync = (source, target) => {
        const result = rename(source, target);
        if (armed && target === ${JSON.stringify(statePath)} && ${JSON.stringify(boundary)} === 'after-state-rename') pauseAt('state-renamed');
        return result;
      };
      syncBuiltinESMExports();
      const { RuntimeTrustKernel } = await import(${JSON.stringify(kernelUrl)});
      const { CapabilityPackagePromotionJournal } = await import(${JSON.stringify(journalUrl)});
      const kernel = new RuntimeTrustKernel({ statePath: ${JSON.stringify(statePath)}, keyPath: ${JSON.stringify(keyPath)}, testMode: false });
      const journal = new CapabilityPackagePromotionJournal({ filePath: ${JSON.stringify(filePath)}, signer: kernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }), trustKernel: kernel });
      armed = true;
      journal.append('promotion_started', { stageId: ${JSON.stringify(boundary)}, packageDigest: 'f'.repeat(64) });
      process.exit(8);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 5_000;
    while (!existsSync(signalPath) && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(signalPath), true, `${boundary} must reach its filesystem boundary`);
    child.kill('SIGKILL');
    const [exitCode, signal] = await exited;
    assert.ok(signal === 'SIGKILL' || (signal === null && exitCode !== 0), `${boundary} child must terminate abnormally`);

    const recoveredKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    const recovered = new CapabilityPackagePromotionJournal({
      filePath,
      signer: recoveredKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }),
      trustKernel: recoveredKernel
    });
    assert.deepEqual(recovered.status().pendingTransitions, [{ id: boundary, operation: 'promotion' }], `${boundary} must remain pending`);
    const manager = new CapabilityPackagePromotionManager({ registry: {}, targets: {}, journal: recovered });
    assert.throws(() => manager.stage({}), { code: 'A_CAPABILITY_PACKAGE_RECOVERY_REQUIRED' });
  }
});

test('an interrupted promotion journal blocks new lifecycle mutations until recovery review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-pending-'));
  const filePath = join(dir, 'promotion.jsonl');
  const trustKernel = fixtureTrustKernel();
  try {
    const journal = new CapabilityPackagePromotionJournal({ filePath, signer: fixtureSigner(), trustKernel });
    journal.append('promotion_started', { stageId: 'stage-crashed', packageDigest: 'c'.repeat(64) });
    const recoveredJournal = new CapabilityPackagePromotionJournal({ filePath, signer: fixtureSigner(), trustKernel });
    assert.deepEqual(recoveredJournal.status().pendingTransitions, [{ id: 'stage-crashed', operation: 'promotion' }]);
    const manager = new CapabilityPackagePromotionManager({ registry: {}, targets: {}, journal: recoveredJournal });
    assert.throws(() => manager.stage({}), { code: 'A_CAPABILITY_PACKAGE_RECOVERY_REQUIRED' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('independent promotion journal writers refresh the signed head under a shared process lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-writers-'));
  const filePath = join(dir, 'promotion.jsonl');
  const signer = fixtureSigner();
  const trustKernel = fixtureTrustKernel();
  try {
    // Model two independently composed Core runtimes that both loaded the same
    // initial head. The second writer must refresh while holding the file lock.
    const first = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    const second = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    first.append('stage_created', { stageId: 'stage-a' });
    second.append('stage_created', { stageId: 'stage-b' });

    const recovered = new CapabilityPackagePromotionJournal({ filePath, signer, trustKernel });
    assert.equal(recovered.status().sequence, 2);
    assert.deepEqual(recovered.records.map(record => record.sequence), [1, 2]);
    assert.equal(recovered.records[1].previousHash, recovered.records[0].recordHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two Core child processes append a single verified promotion chain', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-processes-'));
  const filePath = join(dir, 'promotion.jsonl');
  const statePath = join(dir, 'trust-state.json');
  const keyPath = join(dir, 'trust-key.json');
  const initialKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
  if (initialKernel.keyProvider.persistent !== true || initialKernel.keyProvider.fallback === true) {
    t.skip('Protected persistent runtime trust key is unavailable on this host.');
    await rm(dir, { recursive: true, force: true });
    return;
  }
  const journalUrl = new URL('../packages/core/src/capabilities/capability-package-promotion-journal.js', import.meta.url).href;
  const kernelUrl = new URL('../packages/core/src/security/runtime-trust-kernel.js', import.meta.url).href;
  const code = `
    import { CapabilityPackagePromotionJournal } from ${JSON.stringify(journalUrl)};
    import { RuntimeTrustKernel } from ${JSON.stringify(kernelUrl)};
    const kernel = new RuntimeTrustKernel({ statePath: ${JSON.stringify(statePath)}, keyPath: ${JSON.stringify(keyPath)}, testMode: false });
    const journal = new CapabilityPackagePromotionJournal({ filePath: ${JSON.stringify(filePath)}, signer: kernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }), trustKernel: kernel });
    for (let index = 0; index < 10; index++) journal.append('stage_created', { stageId: process.argv[1] + '-' + index });
    process.send({ status: 'completed', sequence: journal.status().sequence });
  `;
  const children = ['core-a', 'core-b'].map(label => spawn(process.execPath, ['--input-type=module', '-e', code, label], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  }));
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  });
  const outcomes = await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let message;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Promotion writer timed out: ${stderr}`));
    }, 30000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on('message', value => { message = value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!message || code !== 0) {
        reject(new Error(`Promotion writer exited without successful receipt (${code}, ${signal}): ${stderr}`));
      } else resolve({ message, exit: [code, signal] });
    });
  })));
  const messages = outcomes.map(outcome => outcome.message);
  const exits = outcomes.map(outcome => outcome.exit);
  assert.deepEqual(messages.map(message => message.status), ['completed', 'completed']);
  assert.ok(exits.every(([code]) => code === 0));

  const finalKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
  const recovered = new CapabilityPackagePromotionJournal({
    filePath,
    signer: finalKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }),
    trustKernel: finalKernel
  });
  assert.equal(recovered.status().sequence, 20);
  assert.deepEqual(recovered.records.map(record => record.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
});

test('Core child kill around journal durability boundaries yields only oracle-approved pending states', async t => {
  const journalUrl = new URL('../packages/core/src/capabilities/capability-package-promotion-journal.js', import.meta.url).href;
  const kernelUrl = new URL('../packages/core/src/security/runtime-trust-kernel.js', import.meta.url).href;
  const cases = [
    { phase: 'before-write', expectedSequence: 0, expectedAnchored: false },
    { phase: 'after-fsync-before-anchor', expectedSequence: 1, expectedAnchored: false },
    { phase: 'after-anchor', expectedSequence: 1, expectedAnchored: true }
  ];

  for (const scenario of cases) {
    const dir = await mkdtemp(join(tmpdir(), `jarvis-promotion-kill-${scenario.phase}-`));
    const filePath = join(dir, 'promotion.jsonl');
    const statePath = join(dir, 'trust-state.json');
    const keyPath = join(dir, 'trust-key.json');
    const provisioned = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    if (provisioned.keyProvider.persistent !== true || provisioned.keyProvider.fallback === true) {
      await rm(dir, { recursive: true, force: true });
      t.skip('Protected persistent runtime trust key is unavailable on this host.');
      return;
    }
    t.after(() => rm(dir, { recursive: true, force: true }));

    const code = `
      import { CapabilityPackagePromotionJournal } from ${JSON.stringify(journalUrl)};
      import { RuntimeTrustKernel } from ${JSON.stringify(kernelUrl)};
      const phase = process.argv[1];
      const kernel = new RuntimeTrustKernel({ statePath: ${JSON.stringify(statePath)}, keyPath: ${JSON.stringify(keyPath)}, testMode: false });
      const purposeSigner = kernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' });
      const signer = { ...purposeSigner, sign(value) { const signature = purposeSigner.sign(value); if (phase === 'before-write') process.kill(process.pid, 'SIGKILL'); return signature; } };
      const trustKernel = {
        verifyLocalJournalHead: (...args) => kernel.verifyLocalJournalHead(...args),
        anchorLocalJournalHead(id, head) {
          if (phase === 'after-fsync-before-anchor') process.kill(process.pid, 'SIGKILL');
          const result = kernel.anchorLocalJournalHead(id, head);
          if (phase === 'after-anchor') process.kill(process.pid, 'SIGKILL');
          return result;
        }
      };
      const journal = new CapabilityPackagePromotionJournal({ filePath: ${JSON.stringify(filePath)}, signer, trustKernel });
      journal.append('promotion_started', { stageId: 'crash-stage', packageDigest: 'e'.repeat(64) });
      process.exit(9);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, scenario.phase], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const [exitCode, signal] = await once(child, 'exit');
    assert.ok(signal === 'SIGKILL' || (signal === null && exitCode !== 0),
      `${scenario.phase} must terminate abnormally at the injected boundary (exit=${exitCode}, signal=${signal})`);

    const recoveredKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    const anchorSigner = recoveredKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' });
    let durableHead = { sequence: 0, headHash: 'GENESIS' };
    try {
      const raw = await readFile(filePath, 'utf8');
      const lastRecord = JSON.parse(raw.trimEnd().split(/\r?\n/u).at(-1));
      durableHead = { sequence: lastRecord.sequence, headHash: lastRecord.recordHash };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const beforeRecovery = recoveredKernel.verifyLocalJournalHead('capability-package-promotions', durableHead);
    assert.equal(beforeRecovery.needsAnchor === true, scenario.phase === 'after-fsync-before-anchor');
    const probe = new CapabilityPackagePromotionJournal({ filePath, signer: anchorSigner, trustKernel: recoveredKernel });
    assert.equal(probe.status().sequence, scenario.expectedSequence, `${scenario.phase} sequence`);

    if (scenario.expectedSequence === 0) {
      assert.deepEqual(probe.status().pendingTransitions, []);
      assert.equal(beforeRecovery.needsAnchor, false);
    } else {
      assert.deepEqual(probe.status().pendingTransitions, [{ id: 'crash-stage', operation: 'promotion' }]);
      assert.equal(recoveredKernel.verifyLocalJournalHead('capability-package-promotions', probe.head()).needsAnchor, false,
        'journal reconstruction must anchor a valid fsynced suffix before reporting ready');
      const manager = new CapabilityPackagePromotionManager({ registry: {}, targets: {}, journal: probe });
      assert.throws(() => manager.stage({}), { code: 'A_CAPABILITY_PACKAGE_RECOVERY_REQUIRED' });
    }
  }
});

test('a real child termination during journal record write preserves torn bytes and fails closed on restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-partial-write-kill-'));
  const filePath = join(dir, 'promotion.jsonl');
  const statePath = join(dir, 'trust-state.json');
  const keyPath = join(dir, 'trust-key.json');
  try {
    const provisioned = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    if (provisioned.keyProvider.persistent !== true || provisioned.keyProvider.fallback === true) {
      t.skip('Protected persistent runtime trust key is unavailable on this host.');
      return;
    }
    const kernelUrl = new URL('../packages/core/src/security/runtime-trust-kernel.js', import.meta.url).href;
    const journalUrl = new URL('../packages/core/src/capabilities/capability-package-promotion-journal.js', import.meta.url).href;
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync.bind(fs);
      let armed = false;
      fs.writeFileSync = (target, data, ...options) => {
        if (armed && typeof target === 'number' && typeof data === 'string' && data.endsWith('\\n')) {
          const partial = data.slice(0, Math.max(1, Math.floor(data.length / 2)));
          write(target, partial, ...options);
          process.kill(process.pid, 'SIGKILL');
          return;
        }
        return write(target, data, ...options);
      };
      syncBuiltinESMExports();
      const { RuntimeTrustKernel } = await import(${JSON.stringify(kernelUrl)});
      const { CapabilityPackagePromotionJournal } = await import(${JSON.stringify(journalUrl)});
      const kernel = new RuntimeTrustKernel({ statePath: ${JSON.stringify(statePath)}, keyPath: ${JSON.stringify(keyPath)}, testMode: false });
      const journal = new CapabilityPackagePromotionJournal({ filePath: ${JSON.stringify(filePath)}, signer: kernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }), trustKernel: kernel });
      armed = true;
      journal.append('promotion_started', { stageId: 'partial-write-stage', packageDigest: 'a'.repeat(64) });
      process.exit(9);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const [exitCode, signal] = await once(child, 'exit');
    assert.ok(signal === 'SIGKILL' || (signal === null && exitCode !== 0), 'writer child must terminate during the record write');

    const damagedBytes = await readFile(filePath, 'utf8');
    assert.ok(damagedBytes.length > 0 && !damagedBytes.endsWith('\\n'), 'partial record must be observable as an unterminated JSONL tail');
    const recoveredKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    assert.deepEqual(recoveredKernel.verifyLocalJournalHead('capability-package-promotions', { sequence: 0, headHash: 'GENESIS' }),
      { valid: true, needsAnchor: false, storedSequence: 0 });
    assert.throws(() => new CapabilityPackagePromotionJournal({ filePath,
      signer: recoveredKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }), trustKernel: recoveredKernel }), {
      code: 'A_CAPABILITY_PACKAGE_JOURNAL_TORN_TAIL'
    });
    assert.equal(await readFile(filePath, 'utf8'), damagedBytes, 'restart must preserve partial bytes for operator review');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('promotion journal survives a fresh trust-kernel reconstruction with a protected persistent key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-promotion-journal-restart-'));
  const filePath = join(dir, 'promotion.jsonl');
  const statePath = join(dir, 'trust-state.json');
  const keyPath = join(dir, 'trust-key.json');
  try {
    const firstKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    if (firstKernel.keyProvider.persistent !== true || firstKernel.keyProvider.fallback === true) {
      t.skip('Protected persistent runtime trust key is unavailable on this host.');
      return;
    }
    const first = new CapabilityPackagePromotionJournal({
      filePath, signer: firstKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }), trustKernel: firstKernel
    });
    first.append('stage_created', { stageId: 'restart-stage', packageDigest: 'd'.repeat(64) });

    const restartedKernel = new RuntimeTrustKernel({ statePath, keyPath, testMode: false });
    const restarted = new CapabilityPackagePromotionJournal({
      filePath, signer: restartedKernel.createPurposeBoundSigner({ purpose: 'capability-package-promotion-journal-v1' }), trustKernel: restartedKernel
    });
    assert.equal(restarted.status().integrity, 'verified');
    assert.equal(restarted.status().sequence, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

