import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  analyzeWearableAudioFrames,
  decodeWearablePcm16Wav
} from '../apps/wearable-hud/src/field-lab.js';

const defaultEndpoint = 'http://127.0.0.1:4186/audio/capture';
const defaultUtterance = '자비스 상태 보여줘';

export async function runWearableAcousticInputAudit({
  endpoint = defaultEndpoint,
  durationMs = 6000,
  utterance = defaultUtterance,
  reportPath = 'dist/wearable-acoustic-input-audit.json',
  fetchImpl = globalThis.fetch,
  spawnProcess = spawn
} = {}) {
  const captureUrl = new URL(endpoint);
  if (captureUrl.protocol !== 'http:' || captureUrl.hostname !== '127.0.0.1'
    || Number(captureUrl.port) !== 4186 || captureUrl.pathname !== '/audio/capture') {
    throw new Error('wearable-acoustic-endpoint-not-allowed');
  }
  const captureMs = Math.max(2000, Math.min(8000, Math.round(Number(durationMs) || 6000)));
  captureUrl.searchParams.set('durationMs', String(captureMs));
  const capturePromise = fetchImpl(captureUrl, { method: 'POST', cache: 'no-store' });
  await delay(700);
  const speech = createSpeechScript(utterance);
  const encoded = Buffer.from(speech, 'utf16le').toString('base64');
  const speaker = spawnProcess('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const [response] = await Promise.all([capturePromise, waitForProcess(speaker)]);
  const audio = await response.arrayBuffer();
  try {
    if (!response.ok) throw new Error(`wearable-native-capture-http-${response.status}`);
    const decoded = decodeWearablePcm16Wav(audio);
    const microphone = analyzeWearableAudioFrames(decoded.frames);
    for (const frame of decoded.frames) frame.fill(0);
    const report = {
      reportVersion: 'c-d-wearable-acoustic-input-audit-v1',
      generatedAt: new Date().toISOString(),
      status: microphone.status === 'passed' ? 'passed' : 'blocked',
      source: String(response.headers?.get?.('x-jarvis-audio-source') ?? 'unknown').slice(0, 32),
      sampleRateHz: decoded.sampleRateHz,
      captureDurationMs: captureMs,
      utteranceFingerprint: createHash('sha256').update(String(utterance)).digest('hex').slice(0, 16),
      microphone: {
        status: microphone.status,
        frameCount: microphone.frameCount,
        noiseFloorDbfs: microphone.noiseFloorDbfs,
        speechLevelDbfs: microphone.speechLevelDbfs,
        snrDb: microphone.snrDb,
        clippingRatio: microphone.clippingRatio,
        peak: microphone.peak,
        thresholds: microphone.thresholds
      },
      privacy: {
        rawAudioStored: false,
        rawTranscriptStored: false,
        audioContentLogged: false
      }
    };
    const target = resolve(reportPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    new Uint8Array(audio).fill(0);
  }
}

function createSpeechScript(utterance) {
  const safeUtterance = String(utterance).replaceAll("'", "''");
  return [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$voice = $speaker.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq 'ko-KR' } | Select-Object -First 1",
    'if ($voice) { $speaker.SelectVoice($voice.Name) }',
    '$speaker.Volume = 100',
    '$speaker.Rate = -2',
    `$speaker.Speak('${safeUtterance}')`,
    'Start-Sleep -Milliseconds 300',
    `$speaker.Speak('${safeUtterance}')`,
    '$speaker.Dispose()'
  ].join('; ');
}

function waitForProcess(process) {
  return new Promise((resolveProcess, rejectProcess) => {
    const stderr = [];
    process.stderr?.on('data', (chunk) => stderr.push(chunk));
    process.once('error', rejectProcess);
    process.once('exit', (code) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`wearable-acoustic-speaker-failed-${code}-${createHash('sha256').update(Buffer.concat(stderr)).digest('hex').slice(0, 12)}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runWearableAcousticInputAudit();
  console.log('# JARVIS Wearable Acoustic Input Audit');
  console.log(`Status: ${report.status}`);
  console.log(`Source: ${report.source}`);
  console.log(`Speech: ${report.microphone.speechLevelDbfs} dBFS`);
  console.log(`SNR: ${report.microphone.snrDb} dB`);
  console.log('Report: dist/wearable-acoustic-input-audit.json');
  if (report.status !== 'passed') process.exitCode = 1;
}
