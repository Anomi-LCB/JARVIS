import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { verifyNewsCardOcr } from '../scripts/lib/news-card-ocr.mjs';
import {
  ArchiveCreateZipToolAdapter,
  EmailSendToolAdapter,
  UndoJournal,
  VisualCreateCardsToolAdapter
} from '../apps/pc-agent/src/pc-agent-runtime.js';

test('visual card adapter creates multiple verified PNG artifacts and reversible journal entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-visual-cards-'));
  try {
    const undoJournal = new UndoJournal({ journalPath: join(root, 'undo.jsonl') });
    const adapter = new VisualCreateCardsToolAdapter({ allowedRoots: [root], undoJournal });
    const result = await adapter.execute({
      outputDirectory: join(root, 'cards'),
      width: 1200,
      height: 675,
      cards: [
        { fileName: 'news-01.png', title: '첫 번째 뉴스', body: ['핵심 사실 하나', '핵심 사실 둘'], footer: 'example.com' },
        { fileName: 'news-02.png', title: '두 번째 뉴스', subtitle: '검증 카드', body: '짧은 설명', accent: '#16a085' }
      ]
    }, { taskId: 'task_visual' });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.cardCount, 2);
    assert.equal(result.undoJournalIds.length, 2);
    assert.equal(undoJournal.list().filter((entry) => entry.taskId === 'task_visual').length, 2);
    for (const path of result.outputPaths) {
      const bytes = await readFile(path);
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(bytes.readUInt32BE(16), 1200);
      assert.equal(bytes.readUInt32BE(20), 675);
      assert.equal(bytes.length > 10_000, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('long Korean news headline cards preserve the entire title and publisher in local OCR', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-visual-long-headline-'));
  try {
    const title = '분당서울대병원 연구팀, 담도암 발생부터 재발·전이까지, ‘암 진화 경로’ 규명 - 의사신문';
    const source = '의사신문';
    const adapter = new VisualCreateCardsToolAdapter({ allowedRoots: [root] });
    const result = await adapter.execute({ outputDirectory: join(root, 'cards'), width: 1200, height: 675, cards: [{
      fileName: 'long-headline.png', label: '오늘의 헤드라인 01', title, subtitle: `${source} · 2026-09-29 09:40 UTC`,
      body: ['본문 읽기: 미완료', 'AI 요약·사실 대조 미실행', '상세 근거는 동봉 보고서'], footer: '기사 링크는 동봉 보고서 참조'
    }] }, { taskId: 'task_long_headline' });
    assert.equal(result.status, 'success', JSON.stringify(result));
    const ocr = await verifyNewsCardOcr({ allowedRoot: root, cards: [{ id: 'long-headline.png',
      path: result.outputPaths[0], title, source }] });
    assert.equal(ocr.status, 'passed', JSON.stringify(ocr));
    assert.equal(ocr.cards[0].titleMatched, true);
    assert.equal(ocr.cards[0].sourceMatched, true);
    assert.equal(ocr.cards[0].titleMatchRatio >= 0.90, true);
    assert.equal(ocr.cards[0].rawOcrTextStored, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive adapter creates a verified zip from exact allowed inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-archive-'));
  try {
    const first = join(root, 'first.txt');
    const second = join(root, 'second.json');
    await writeFile(first, 'alpha', 'utf8');
    await writeFile(second, '{"beta":2}', 'utf8');
    const adapter = new ArchiveCreateZipToolAdapter({ allowedRoots: [root] });
    const result = await adapter.execute({ path: join(root, 'bundle.zip'), inputPaths: [first, second] }, { taskId: 'task_zip' });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.entryCount, 2);
    assert.deepEqual(result.entries.map((entry) => entry.name), ['first.txt', 'second.json']);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await access(join(root, 'bundle.zip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('email adapter sends exact multiple attachments once and reuses durable acceptance on duplicate delivery key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-email-multiple-'));
  const previous = Object.fromEntries(['JARVIS_SMTP_USER', 'JARVIS_SMTP_PASS', 'JARVIS_SMTP_SERVICE'].map((name) => [name, process.env[name]]));
  try {
    process.env.JARVIS_SMTP_USER = 'owner@example.com';
    process.env.JARVIS_SMTP_PASS = 'fixture-password';
    process.env.JARVIS_SMTP_SERVICE = 'gmail';
    const paths = [join(root, 'a.txt'), join(root, 'b.txt')];
    await writeFile(paths[0], 'alpha', 'utf8');
    await writeFile(paths[1], 'beta', 'utf8');
    const hashes = await Promise.all(paths.map(async (path) => createHash('sha256').update(await readFile(path)).digest('hex')));
    let sendCount = 0;
    const adapter = new EmailSendToolAdapter({ allowedRoots: [root], ledgerPath: join(root, 'email-ledger.jsonl') });
    adapter.loadNodemailer = async () => ({
      createTransport: () => ({
        async sendMail(message) {
          sendCount += 1;
          assert.equal(message.attachments.length, 2);
          return { accepted: ['owner@example.com'], rejected: [], pending: [], response: '250 2.0.0 OK', messageId: '<multi@example.com>' };
        }
      })
    });
    const args = {
      rawText: '내 구글 메일로 보내줘',
      recipientMode: 'self',
      subject: '[JARVIS TEST] multiple',
      body: 'verified',
      idempotencyKey: 'test:multiple:001',
      attachments: paths.map((path, index) => ({ attachmentPath: path, attachmentSha256: hashes[index] }))
    };
    const first = await adapter.execute(args);
    const second = await adapter.execute(args);
    assert.equal(first.status, 'success', JSON.stringify(first));
    assert.equal(first.attachmentCount, 2);
    assert.equal(first.verification.recipientMatched, true);
    assert.equal(second.status, 'success', JSON.stringify(second));
    assert.equal(second.deduplicated, true);
    assert.equal(sendCount, 1);
    const conflicting = await adapter.execute({ ...args, body: 'changed payload under the same key' });
    assert.equal(conflicting.status, 'blocked', JSON.stringify(conflicting));
    assert.equal(conflicting.error, 'B_EMAIL_IDEMPOTENCY_CONFLICT');
    assert.equal(sendCount, 1);
    const restored = new EmailSendToolAdapter({ allowedRoots: [root], ledgerPath: join(root, 'email-ledger.jsonl') });
    restored.loadNodemailer = adapter.loadNodemailer;
    const third = await restored.execute(args);
    assert.equal(third.deduplicated, true);
    assert.equal(third.changedItems.length, 1);
    assert.equal(third.changedItems[0].providerAccepted, true);
    assert.equal(third.changedItems[0].deduplicated, true);
    assert.equal(sendCount, 1);
    const restoredConflict = await restored.execute({ ...args, subject: '[JARVIS TEST] changed' });
    assert.equal(restoredConflict.status, 'blocked', JSON.stringify(restoredConflict));
    assert.equal(restoredConflict.error, 'B_EMAIL_IDEMPOTENCY_CONFLICT');
    assert.equal(sendCount, 1);
    const ledgerText = await readFile(join(root, 'email-ledger.jsonl'), 'utf8');
    assert.equal(ledgerText.includes('owner@example.com'), false);
    assert.equal(ledgerText.includes('fixture-password'), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted owner mission auto-authorizes a self email only after exact source-file evidence is verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-self-email-mission-'));
  const previous = Object.fromEntries(['JARVIS_SMTP_USER', 'JARVIS_SMTP_PASS', 'JARVIS_SMTP_SERVICE'].map((name) => [name, process.env[name]]));
  try {
    process.env.JARVIS_SMTP_USER = 'owner@example.com';
    process.env.JARVIS_SMTP_PASS = 'fixture-password';
    process.env.JARVIS_SMTP_SERVICE = 'gmail';
    const attachmentPath = join(root, 'bundle.txt');
    await writeFile(attachmentPath, 'verified source fixture', 'utf8');
    const attachmentSha256 = createHash('sha256').update(await readFile(attachmentPath)).digest('hex');
    const planner = {
      async planNextWave(context) {
        const [readRequirement, sendRequirement] = context.mission.goalContract.requirements;
        const delivered = context.observations.find(observation => observation.toolName === 'email.send' && observation.outcome === 'success');
        if (delivered) return {
          decision: 'complete',
          summary: 'SMTP 수락 증거로 목표를 완료합니다.',
          actions: [],
          criteriaAssessment: context.mission.successCriteria.map(criterion => ({
            criterionId: criterion.criterionId,
            status: 'satisfied',
            evidenceActionIds: [context.observations.find(observation => observation.toolName === 'filesystem.readText' && observation.outcome === 'success')?.actionId,
              delivered.actionId].filter(Boolean),
            reason: '원본 파일의 독립 내용 검증과 SMTP 수락 및 G 검증이 확인되었습니다.'
          }))
        };
        if (context.mission.waveCount === 0) return {
          decision: 'continue',
          summary: '보내기 전에 원본 파일을 먼저 읽어 검증합니다.',
          actions: [{
            id: 'read_bundle', title: '원본 묶음 읽기', command: `'${attachmentPath}'를 읽어`,
            expectedToolName: 'filesystem.readText', arguments: { path: attachmentPath },
            dependencies: [], requirementIds: [readRequirement.requirementId],
            successSignal: '원본 파일 읽기 결과 검증'
          }],
          criteriaAssessment: []
        };
        return {
          decision: 'continue',
          summary: '검증된 자기 메일 전송',
          actions: [{
            id: 'send_self',
            title: '내 Gmail 전송',
            command: `'${attachmentPath}'를 내 구글 메일로 보내줘`,
            expectedToolName: 'email.send',
            arguments: {
              to: '',
              recipientMode: 'self',
              subject: '[JARVIS TEST] owner scoped',
              body: '검증된 첨부입니다.',
              attachments: [{ attachmentRef: { rootIndex: 0, relativePath: attachmentPath.split(root + '\\')[1].replaceAll('\\', '/') }, attachmentSha256 }],
              idempotencyKey: 'test:self-owner:001'
            },
            dependencies: [], requirementIds: [sendRequirement.requirementId],
            successSignal: 'SMTP 공급자 수락'
          }],
          criteriaAssessment: []
        };
      }
    };
    const sharedEmailLedgerPath = join(root, 'shared-email-ledger.jsonl');
    const binding = { capabilityId: 'workflow.execute', providerId: 'isolated-owner-smtp', accountRef: 'synthetic-owner', deviceRef: null, scopes: ['synthetic.send'] };
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'), emailLedgerPath: sharedEmailLedgerPath, cwd: () => root, env: {}, missionPlanner: planner, workerDaemonEnabled: false,
      capabilityBindingResolver: ({toolName}) => toolName === 'email.send' ? {required:true,binding,permissionRevision:'owner-smtp-1'} : {required:false} });
    runtime.capabilityPackageRegistry.recordAvailability({ ...binding,
      codeVersion:runtime.capabilityPackageRegistry.availabilityFor(binding).codeVersion,permissionRevision:'owner-smtp-1',
      observedAt:new Date().toISOString(),accountStatus:'connected',observedAccountRef:binding.accountRef,
      deviceStatus:'not-required',grantedScopes:binding.scopes,verificationLevel:'live-probe',evidenceRef:'isolated-owner-smtp' });
    assert.equal(runtime.pcAgent.registry.get('email.send').ledgerPath, sharedEmailLedgerPath);
    let sends = 0;
    runtime.pcAgent.registry.get('email.send').loadNodemailer = async () => ({
      createTransport: () => ({ sendMail: async () => {
        sends += 1;
        return { accepted: ['owner@example.com'], rejected: [], pending: [], response: '250 OK', messageId: '<owner-scoped@example.com>' };
      } })
    });
    const owner = runtime.personalOwnerSession.activate({ durationMinutes: 5, requestedBy: 'test-user' });
    const created = runtime.missionRuntime.createMission({
      objective: `'${attachmentPath}'를 읽어; '${attachmentPath}'를 내 구글 메일로 보내줘`,
      successCriteria: [{
        statement: '원본 파일 내용이 지정된 값과 일치한다.',
        artifactRole: 'input',
        verificationSpec: { version: 1, kind: 'text.equals', path: 'bundle.txt', equals: 'verified source fixture' }
      }],
      authorization: { mode: 'trusted_session', grants: ['read_only', 'local_reversible', 'high_impact'], ownerSessionId: owner.session.sessionId }
    });
    const completed = await runtime.missionRuntime.runMission(created.missionId);
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed));
    assert.equal(completed.pendingGates?.length ?? 0, 0);
    assert.equal(sends, 1);
    const deliveryRecords = (await readFile(sharedEmailLedgerPath, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
    const accepted = deliveryRecords.find(record => record.providerAccepted === true);
    assert.equal(accepted.attachmentSha256s[0], attachmentSha256);
    assert.equal(accepted.rawRecipientStored, false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
