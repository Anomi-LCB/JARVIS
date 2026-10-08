import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const uiRoots = ['src/ui', 'apps/mobile/src', 'apps/wearable-hud/src'];
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.html']);
const bannedSparklePatterns = [
  /\b(?:Sparkle|Sparkles|WandSparkles|BadgeSparkles|Stars)\b/,
  /[✨✦✧]/u
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

test('JARVIS UI surfaces do not use the prohibited sparkle AI icon family', async () => {
  const files = (await Promise.all(uiRoots.map(sourceFiles))).flat();
  const violations = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of bannedSparklePatterns) {
      const match = source.match(pattern);
      if (match) violations.push(`${relative('.', file)}: ${match[0]}`);
    }
  }

  assert.deepEqual(violations, [], `Prohibited sparkle icon found:\n${violations.join('\n')}`);
});
