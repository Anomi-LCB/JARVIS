import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ResearchLedger } from '../packages/shared/src/research-ledger.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }

export function runResearchLedger(argv = [], { workspaceRoot = ROOT, storePath = resolve(workspaceRoot, '.runtime/research/research.sqlite') } = {}) {
  const [mode = 'status', input] = argv;
  if (!['status', 'sync', 'record'].includes(mode) || argv.length > 2 || mode === 'status' && input || mode === 'record' && !input) {
    throw new Error('Usage: npm run research:ledger -- [status | sync [catalog.json] | record attempt.json]');
  }
  const ledger = new ResearchLedger({ workspaceRoot, storePath });
  try {
    if (mode === 'sync') {
      const candidates = ledger.syncCandidates(readJson(resolve(workspaceRoot, input ?? 'config/research-candidates.json')));
      const watchPath = resolve(workspaceRoot, '.runtime/research-watch/latest.json');
      let watch;
      try { watch = ledger.importWatch(readJson(watchPath)); }
      catch (error) { if (error.code === 'ENOENT') watch = { recorded: false, reason: 'watch-not-run' }; else throw error; }
      return { candidates, watch };
    }
    if (mode === 'record') return ledger.recordAttempt(readJson(resolve(workspaceRoot, input)));
    return ledger.snapshot();
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runResearchLedger(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
