import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const attempts = [
  {
    id: 'windows-core-service-admin-install',
    title: 'A Core Windows Service administrator install',
    script: 'dist/core-service-package/install-all.ps1'
  },
  {
    id: 'windows-pc-agent-admin-install',
    title: 'B PC Agent Windows Service administrator install',
    script: 'dist/pc-agent-installer/install-all.ps1'
  }
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        startedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        exitCode: error.code ?? 1,
        timedOut,
        stdout,
        stderr: [stderr, error.message].filter(Boolean).join('\n')
      });
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({
        startedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        exitCode: exitCode ?? 1,
        timedOut,
        stdout,
        stderr
      });
    });
  });
}

async function isAdministrator() {
  if (process.platform !== 'win32') return false;
  const command = '[Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent() | ForEach-Object { $_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }';
  const result = await run('powershell', ['-NoProfile', '-Command', command], { timeoutMs: 20_000 });
  return String(result.stdout).trim().toLowerCase() === 'true';
}

function classifyAttempt({ exitCode, stdout, stderr, elevated }) {
  const output = `${stdout}\n${stderr}`;
  if (exitCode === 0) return 'verified';
  if (!elevated && /administrator|관리자|elevated/i.test(output)) return 'blocked-non-admin';
  if (!elevated) return 'blocked-non-admin';
  return 'failed';
}

export async function runWindowsAdminInstallAttempts({
  jsonPath = 'dist/windows-admin-install-attempts.json',
  markdownPath = 'dist/windows-admin-install-attempts.md'
} = {}) {
  if (process.platform !== 'win32') {
    const report = {
      reportVersion: 'windows-admin-install-attempts-v1',
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      elevated: false,
      status: 'not-applicable',
      attempts: attempts.map((item) => ({
        ...item,
        scriptPath: resolve(item.script),
        status: 'not-applicable',
        exitCode: null,
        stdout: '',
        stderr: 'Windows service installation is only applicable on Windows.',
        timedOut: false,
        durationMs: 0
      }))
    };
    await mkdir(dirname(jsonPath), { recursive: true });
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderMarkdown(report), 'utf8');
    return report;
  }

  const elevated = await isAdministrator();
  const results = [];
  for (const item of attempts) {
    const scriptExists = await exists(item.script);
    if (!scriptExists) {
      results.push({
        ...item,
        scriptPath: resolve(item.script),
        status: 'missing-script',
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0
      });
      continue;
    }
    const result = await run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      item.script
    ]);
    results.push({
      ...item,
      scriptPath: resolve(item.script),
      status: classifyAttempt({ ...result, elevated }),
      ...result
    });
  }

  const report = {
    reportVersion: 'windows-admin-install-attempts-v1',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    elevated,
    status: results.every((item) => item.status === 'verified')
      ? 'verified'
      : results.some((item) => item.status === 'blocked-non-admin')
        ? 'blocked-non-admin'
        : 'failed',
    attempts: results
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

function renderMarkdown(report) {
  return [
    '# JARVIS Windows Admin Install Attempts',
    '',
    `Status: **${report.status}**`,
    `Administrator shell: ${report.elevated ? 'yes' : 'no'}`,
    '',
    '| Item | Status | Exit | Script |',
    '| --- | --- | --- | --- |',
    ...report.attempts.map((item) => `| ${item.id} | ${item.status} | ${item.exitCode ?? 'n/a'} | \`${item.script}\` |`),
    '',
    '## Notes',
    '',
    ...report.attempts.map((item) => {
      const text = [item.stderr, item.stdout].filter(Boolean).join('\n').trim();
      const firstLine = text.split(/\r?\n/).find(Boolean) ?? 'No output captured.';
      return `- ${item.id}: ${firstLine}`;
    }),
    ''
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runWindowsAdminInstallAttempts();
  console.log('# JARVIS Windows Admin Install Attempts');
  console.log(`Status: ${report.status}`);
  console.log(`Administrator shell: ${report.elevated ? 'yes' : 'no'}`);
  for (const item of report.attempts) {
    console.log(`${item.id}: ${item.status} (exit ${item.exitCode ?? 'n/a'})`);
  }
  console.log('Reports: dist/windows-admin-install-attempts.json, dist/windows-admin-install-attempts.md');
  if (report.status === 'failed') process.exitCode = 1;
}
