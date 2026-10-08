import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const verifierPath = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-docx-facts.py');

export function verifyNewsFactsDocx(path, expectedFacts, { python = 'python' } = {}) {
  const expected = [...expectedFacts];
  const stdout = execFileSync(python, [verifierPath, path], {
    input: JSON.stringify(expected), encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024
  });
  return JSON.parse(stdout.trim());
}
