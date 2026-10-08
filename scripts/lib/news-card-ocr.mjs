import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-news-card-ocr.ps1');

export async function verifyNewsCardOcr({ allowedRoot, cards,verificationScale=1 } = {}) {
  if (process.platform !== 'win32') return { status: 'blocked', reason: 'windows-local-ocr-requires-windows', rawOcrTextStored: false, cards: [] };
  if (![1,2].includes(verificationScale)||typeof allowedRoot !== 'string' || !Array.isArray(cards) || cards.length < 1 || cards.length > 10
    || cards.some(card => !card || typeof card.path !== 'string' || typeof card.title !== 'string' || typeof card.source !== 'string')) {
    throw new TypeError('news-card-ocr-input-invalid');
  }
  const request = Buffer.from(JSON.stringify({ allowedRoot: resolve(allowedRoot), cards,verificationScale }), 'utf8').toString('base64');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].flatMap(key =>
    process.env[key] ? [[key, process.env[key]]] : []));
  env.JARVIS_NEWS_CARD_OCR_REQUEST_B64 = request;
  let stdout;
  try {
    ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helperPath], {
      windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024, env
    }));
  } catch (error) {
    return { status: 'blocked', reason: 'windows-local-ocr-unavailable', errorCode: error?.code ?? 'process-failed', rawOcrTextStored: false, cards: [] };
  }
  const line = String(stdout).trim().split(/\r?\n/u).at(-1) ?? '';
  let result;
  try { result = JSON.parse(line); } catch { return { status: 'failed', reason: 'windows-local-ocr-response-invalid', rawOcrTextStored: false, cards: [] }; }
  if (result.rawOcrTextStored !== false || !['passed', 'failed', 'blocked'].includes(result.status)) {
    return { status: 'failed', reason: 'windows-local-ocr-evidence-invalid', rawOcrTextStored: false, cards: [] };
  }
  if (result.status === 'passed' && (!Array.isArray(result.cards) || result.cards.length !== cards.length
    || result.cards.some((card, index) => card.id !== cards[index].id || card.status !== 'verified'
      || card.rawOcrTextStored !== false || !/^[a-f\d]{64}$/iu.test(card.sha256)
      || !Number.isFinite(card.titleMatchRatio) || card.titleMatchRatio < 0.90
      || card.titleMatched !== true || card.sourceMatched !== true))) {
    return { status: 'failed', reason: 'windows-local-ocr-card-evidence-invalid', rawOcrTextStored: false, cards: [] };
  }
  return result;
}
