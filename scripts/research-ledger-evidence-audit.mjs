import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, lstat, readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ResearchLedger } from '../packages/shared/src/research-ledger.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_BYTES = 4 * 1024 * 1024;
const SCAN_ROOTS = ['artifacts', 'docs', 'dist/verification'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function scanEvidenceHashes(workspaceRoot = ROOT) {
  const hashes = new Map();
  const stats = { filesHashed: 0, oversizedSkipped: 0, unreadableSkipped: 0, symlinksSkipped: 0, missingRoots: [] };
  async function walk(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') { if (path === resolve(workspaceRoot, 'artifacts') || path === resolve(workspaceRoot, 'docs') || path === resolve(workspaceRoot, 'dist/verification')) stats.missingRoots.push(relative(workspaceRoot, path).split(sep).join('/')); else stats.unreadableSkipped++; return; }
      stats.unreadableSkipped++; return;
    }
    for (const entry of entries) {
      const target = resolve(path, entry.name);
      if (entry.isSymbolicLink()) { stats.symlinksSkipped++; continue; }
      if (entry.isDirectory()) { await walk(target); continue; }
      if (!entry.isFile()) continue;
      try {
        const info = await lstat(target);
        if (info.size > MAX_BYTES) { stats.oversizedSkipped++; continue; }
        const bytes = await readFile(target);
        if (bytes.length > MAX_BYTES) { stats.oversizedSkipped++; continue; }
        const digest = sha256(bytes);
        const rel = relative(workspaceRoot, target).split(sep).join('/');
        const paths = hashes.get(digest) ?? [];
        paths.push(rel);
        hashes.set(digest, paths);
        stats.filesHashed++;
      } catch { stats.unreadableSkipped++; }
    }
  }
  for (const root of SCAN_ROOTS) await walk(resolve(workspaceRoot, root));
  for (const paths of hashes.values()) paths.sort();
  return { hashes, stats };
}

export function classifyChangedEvidence(snapshot, hashIndex) {
  const rows = [];
  for (const candidate of snapshot.candidates ?? []) for (const attempt of candidate.attempts ?? []) {
    for (const evidence of attempt.evidence ?? []) {
      if (evidence.integrity !== 'changed') continue;
      const matches = (hashIndex.get(evidence.sha256) ?? []).filter(path => path !== evidence.path);
      rows.push({ candidateId: candidate.id, attemptId: attempt.id, integrity: evidence.integrity,
        historicalPath: evidence.path, historicalSha256: evidence.sha256,
        classification: matches.length ? 'exact-copy-found' : 'no-exact-copy-found-in-scanned-roots', matches });
    }
  }
  return rows.sort((a, b) => a.candidateId.localeCompare(b.candidateId) || a.attemptId.localeCompare(b.attemptId) || a.historicalPath.localeCompare(b.historicalPath));
}

function markdown(report) {
  const exact = report.records.filter(row => row.classification === 'exact-copy-found');
  const unmatched = report.records.length - exact.length;
  const lines = [
    '# Research ledger evidence path audit', '',
    `- Observed at: ${report.observedAt}`,
    `- Changed evidence records in latest 20 attempts per candidate: ${report.records.length}`,
    `- Exact byte copies at alternate paths: ${exact.length}`,
    `- No exact copy found in scanned roots: ${unmatched}`,
    `- Hashed files: ${report.scan.filesHashed}; oversized skipped: ${report.scan.oversizedSkipped}; unreadable skipped: ${report.scan.unreadableSkipped}; symlinks skipped: ${report.scan.symlinksSkipped}`,
    `- Scanned roots: ${report.scannedRoots.join(', ')}`, '',
    'This is a read-only path-recovery audit. “No exact copy found” is limited to the listed roots and files up to 4 MiB; it does not prove permanent loss. Exact hashes establish byte identity only, not the validity of the experiment conclusions. Historical ledger entries are not rewritten.', '',
    '## Exact copies found', ''
  ];
  for (const row of exact) lines.push(`- ${row.attemptId} · ${row.historicalPath} → ${row.matches.join(', ')}`);
  if (!exact.length) lines.push('- None.');
  lines.push('', '## No exact copy found in scanned roots', '');
  for (const row of report.records.filter(item => item.classification !== 'exact-copy-found')) lines.push(`- ${row.attemptId} · ${row.historicalPath} · SHA-256 ${row.historicalSha256}`);
  if (unmatched === 0) lines.push('- None.');
  lines.push('');
  return lines.join('\n');
}

async function writeExclusive(path, contents) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function runEvidenceAudit({ workspaceRoot = ROOT, storePath = resolve(workspaceRoot, '.runtime/research/research.sqlite'), observedAt = new Date().toISOString() } = {}) {
  const ledger = new ResearchLedger({ workspaceRoot, storePath, clock: () => observedAt });
  let snapshot;
  try { snapshot = ledger.snapshot(); } finally { ledger.close(); }
  const { hashes, stats } = await scanEvidenceHashes(workspaceRoot);
  const report = { version: 1, observedAt, purpose: 'read-only-exact-content-search-for-changed-ledger-evidence',
    scannedRoots: SCAN_ROOTS, scope: 'latest-20-attempts-per-candidate', scan: stats,
    totals: { changedEvidenceRecords: 0, exactCopyFound: 0, noExactCopyFoundInScannedRoots: 0 }, records: classifyChangedEvidence(snapshot, hashes) };
  report.totals.changedEvidenceRecords = report.records.length;
  report.totals.exactCopyFound = report.records.filter(row => row.classification === 'exact-copy-found').length;
  report.totals.noExactCopyFoundInScannedRoots = report.records.length - report.totals.exactCopyFound;
  const dir = resolve(workspaceRoot, 'artifacts/research-evidence-audits');
  await mkdir(dir, { recursive: true });
  const stamp = observedAt.replace(/[^0-9TZ]/g, '').replace(/Z$/, 'Z');
  const runDir = resolve(dir, `${stamp}-${randomUUID()}`);
  await mkdir(runDir, { recursive: false });
  const jsonPath = resolve(runDir, 'report.json');
  const markdownPath = resolve(runDir, 'report.md');
  await writeExclusive(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeExclusive(markdownPath, markdown(report));
  return { report, jsonPath: relative(workspaceRoot, jsonPath).split(sep).join('/'), markdownPath: relative(workspaceRoot, markdownPath).split(sep).join('/') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runEvidenceAudit();
    console.log(JSON.stringify({ observedAt: result.report.observedAt, scan: result.report.scan, totals: result.report.totals,
      jsonPath: result.jsonPath, markdownPath: result.markdownPath }, null, 2));
  }
  catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
