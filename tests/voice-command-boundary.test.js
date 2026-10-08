import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceCommandTurn, observeVoiceCommandTurn } from '../apps/mobile/src/voice/voice-command-turn.js';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { TaskStatus } from '../packages/shared/src/types.js';

test('the native result callback preserves strict final flags before the command boundary', async () => {
  const mobileRequire = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
  const ts = mobileRequire('typescript');
  const source = await readFile('apps/mobile/src/voice/voiceMode.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const callbacks = new Map();
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(id) {
      if (id === 'expo-speech') return {};
      if (id === 'expo-speech-recognition') return {
        ExpoSpeechRecognitionModule: {},
        useSpeechRecognitionEvent: (name, callback) => callbacks.set(name, callback)
      };
      if (id.startsWith('./')) return mobileRequire(`./src/voice/${id.slice(2)}`);
      throw new Error(`Unexpected dependency: ${id}`);
    }
  });
  let turn = createVoiceCommandTurn();
  const committed = [];
  module.exports.useVoiceEvents({ onResult(transcript, isFinal) {
    const result = observeVoiceCommandTurn(turn, { transcript, isFinal });
    turn = result.turn;
    if (result.committed) committed.push(result.transcript);
  } });
  for (const isFinal of ['false', 'true', 1, false, null]) {
    callbacks.get('result')({ isFinal, results: [{ transcript: '자료를 전부 보내줘', confidence: 0.99 }] });
  }
  callbacks.get('result')({ isFinal: true, results: [{ transcript: '자료를 보내줘. 정정할게,', confidence: 0.99 }] });
  assert.deepEqual(committed, []);
  callbacks.get('result')({ isFinal: true, results: [{ transcript: '작업 폴더 파일 목록 보여줘', confidence: 0.99 }] });
  assert.deepEqual(committed, ['작업 폴더 파일 목록 보여줘']);
});

test('an unfinished correction never commits the superseded command and can receive a replacement', () => {
  for (const suffix of ['아니', '아니.', '아니요,', '정정할게,', '정정할게。', '정정하면']) {
    const result = observeVoiceCommandTurn(createVoiceCommandTurn(), {
      transcript: `자료를 전부 보내줘. ${suffix}`, isFinal: true
    });
    assert.equal(result.committed, false, suffix);
    assert.equal(result.accepted, false, suffix);
    assert.equal(result.turn.command, null);
    assert.equal(result.turn.status, 'listening');
    const replacement = observeVoiceCommandTurn(result.turn, {
      transcript: '작업 폴더 파일 목록 보여줘', isFinal: true
    });
    assert.equal(replacement.committed, true);
    assert.equal(replacement.transcript, '작업 폴더 파일 목록 보여줘');
  }
});

test('only an actual final boolean commits a voice command', () => {
  for (const isFinal of [false, undefined, null, 'false', 'true', 1, {}]) {
    const result = observeVoiceCommandTurn(createVoiceCommandTurn(), { transcript: '자료를 보내줘', isFinal });
    assert.equal(result.committed, false, String(isFinal));
    assert.equal(result.turn.command, null);
  }
});

test('explicit turn cancellation prevents later final events from reviving the cancelled turn', () => {
  for (const transcript of ['취소해', '그만', '자료를 보내줘. 취소해', '자료를 보내줘. 아니, 취소해']) {
    const result = observeVoiceCommandTurn(createVoiceCommandTurn(), { transcript, isFinal: true });
    assert.equal(result.committed, false, transcript);
    assert.equal(result.accepted, false);
    assert.equal(result.turn.status, 'cancelled');
    assert.equal(result.turn.command, null);
    assert.equal(observeVoiceCommandTurn(result.turn, {
      transcript: '자료를 보내줘', isFinal: true
    }).committed, false);
  }
});

test('cancellation tasks, quoted speech, and Korean word prefixes remain intact', () => {
  for (const transcript of [
    '취소된 일정만 찾아줘', '예약 취소해줘', '문서에서 아니오 항목을 찾아줘',
    '보고서가 아니라 표로 만들어줘', '문서에서 "그만"이라는 단어를 찾아줘'
  ]) {
    const result = observeVoiceCommandTurn(createVoiceCommandTurn(), { transcript, isFinal: true });
    assert.equal(result.committed, true, transcript);
    assert.equal(result.transcript, transcript);
  }
});

test('voice boundary dispatch reaches real Core/B/G only for a completed replacement command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-voice-boundary-'));
  try {
    await writeFile(join(root, 'note.txt'), 'synthetic local evidence', 'utf8');
    const runtime = createAgRuntime({ allowedRoots: [root], auditRoot: join(root, 'audit'),
      cwd: () => root, env: {}, bridgeRealExecution: true, workerDaemonEnabled: false });
    let turn = createVoiceCommandTurn();
    const dispatched = [];
    const submit = event => {
      const result = observeVoiceCommandTurn(turn, event);
      turn = result.turn;
      if (!result.accepted || !result.committed) return null;
      const task = runtime.coreFacade.createTask(result.transcript, {
        source: 'mobile', sourceModule: 'C_MOBILE', inputMode: 'voice'
      });
      dispatched.push(task);
      return task;
    };
    assert.equal(submit({ transcript: '자료를 전부 보내줘. 아니', isFinal: true }), null);
    assert.equal(submit({ transcript: '자료를 전부 보내줘', isFinal: 'false' }), null);
    assert.equal(dispatched.length, 0);
    const task = submit({ transcript: '작업 폴더 파일 목록 보여줘', isFinal: true });
    assert.equal(dispatched.length, 1);
    const run = await runtime.orchestrationWorker.runTask(task.taskId, {
      deviceId: 'voice_boundary_fixture', userConfirmation: { confirmed: true }
    });
    assert.equal(run.success, true, JSON.stringify(run));
    assert.equal(run.executionVerification.status, 'passed');
    assert.equal(runtime.coreFacade.getTask(task.taskId).status, TaskStatus.COMPLETED);
    assert.equal(submit({ transcript: '자료를 전부 보내줘', isFinal: true }), null);
    assert.equal(dispatched.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
