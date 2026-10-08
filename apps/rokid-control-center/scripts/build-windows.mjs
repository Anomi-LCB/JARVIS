import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveAdbPath } from '../src/adb-client.js';

const execFileAsync = promisify(execFile);
const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(appRoot, '..', '..');
const distRoot = resolve(repoRoot, 'dist');
const outputRoot = resolve(distRoot, 'rokid-control-center');
const singleExePath = resolve(distRoot, 'RokidControlCenter.exe');
const payloadPath = resolve(distRoot, 'rokid-control-center-payload.zip');
const payloadHashPath = resolve(distRoot, 'rokid-control-center-payload.sha256');
assertWithin(distRoot, outputRoot);
assertWithin(distRoot, singleExePath);
assertWithin(distRoot, payloadPath);
assertWithin(distRoot, payloadHashPath);

await mkdir(outputRoot, { recursive: true });
await Promise.all([
  rm(singleExePath, { force: true }),
  rm(payloadPath, { force: true }),
  rm(payloadHashPath, { force: true })
]);
// Preserve outputRoot/data: it contains user backups and the append-only audit log.
for (const generatedPath of [
  join(outputRoot, 'app'),
  join(outputRoot, 'runtime'),
  join(outputRoot, 'tools'),
  join(outputRoot, 'RokidControlCenter.exe'),
  join(outputRoot, 'BUILD-INFO.json'),
  join(outputRoot, 'START-HERE.txt')
]) {
  assertWithin(outputRoot, generatedPath);
  await rm(generatedPath, { recursive: true, force: true });
}
await Promise.all([
  mkdir(join(outputRoot, 'app'), { recursive: true }),
  mkdir(join(outputRoot, 'runtime'), { recursive: true }),
  mkdir(join(outputRoot, 'tools', 'adb'), { recursive: true })
]);

await cp(join(appRoot, 'src'), join(outputRoot, 'app', 'src'), { recursive: true });
await cp(process.execPath, join(outputRoot, 'runtime', 'node.exe'));

const adbPath = await resolveAdbPath();
const adbDir = dirname(adbPath);
for (const file of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
  const source = join(adbDir, file);
  await access(source);
  await cp(source, join(outputRoot, 'tools', 'adb', file));
}

const launcherSource = join(appRoot, 'windows', 'Launcher.cs');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const compressionAssembly = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.IO.Compression.dll';
const compressionFileSystemAssembly = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.IO.Compression.FileSystem.dll';
await access(compiler);
await access(compressionAssembly);
await access(compressionFileSystemAssembly);
const compilerReferences = [
  '/reference:System.dll',
  '/reference:System.Windows.Forms.dll',
  `/reference:${compressionAssembly}`,
  `/reference:${compressionFileSystemAssembly}`
];
await execFileAsync(compiler, [
  '/nologo',
  '/target:winexe',
  `/out:${join(outputRoot, 'RokidControlCenter.exe')}`,
  ...compilerReferences,
  launcherSource
], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });

await execFileAsync('tar.exe', [
  '-a',
  '-c',
  '-f',
  payloadPath,
  'app',
  'runtime',
  'tools'
], { cwd: outputRoot, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const payloadHash = createHash('sha256').update(await readFile(payloadPath)).digest('hex');
await writeFile(payloadHashPath, `${payloadHash}\n`, 'utf8');
await execFileAsync(compiler, [
  '/nologo',
  '/target:winexe',
  `/out:${singleExePath}`,
  ...compilerReferences,
  `/resource:${payloadPath},RokidControlCenter.Payload.zip`,
  `/resource:${payloadHashPath},RokidControlCenter.Payload.sha256`,
  launcherSource
], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });

const buildInfo = {
  packageVersion: 'rokid-control-center-v0.2.2',
  builtAt: new Date().toISOString(),
  runtime: process.version,
  architecture: process.arch,
  includes: ['RokidControlCenter.exe', 'Node runtime', 'Android Platform Tools', 'local control server', 'Windows GUI'],
  security: ['localhost-only server', 'same-origin mutation guard', 'allowlisted ADB actions', 'setting snapshots and undo', 'append-only audit log']
};
await writeFile(join(outputRoot, 'BUILD-INFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
await writeFile(join(outputRoot, 'START-HERE.txt'), [
  'ROKID CONTROL CENTER',
  '',
  '단일 파일 버전: 상위 dist 폴더의 RokidControlCenter.exe 하나만 이동하면 됩니다.',
  '이 폴더의 RokidControlCenter.exe는 폴더형 휴대용 버전입니다.',
  '',
  '1. Rokid 안경을 USB로 연결하고 기기에서 USB 디버깅을 승인합니다.',
  '2. 원하는 버전의 RokidControlCenter.exe를 실행합니다.',
  '3. 첫 변경 전에 백업 센터에서 핵심 논리 백업을 실행합니다.',
  '',
  '단일 파일 버전 데이터: %LOCALAPPDATA%\\RokidControlCenter\\data',
  '폴더형 버전 데이터: 이 폴더의 data'
].join('\r\n'), 'utf8');

await Promise.all([
  rm(payloadPath, { force: true }),
  rm(payloadHashPath, { force: true })
]);

console.log(JSON.stringify({ singleExePath, portableRoot: outputRoot, payloadHash }, null, 2));

function assertWithin(root, candidate) {
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error('빌드 출력 경로가 dist 루트를 벗어났습니다.');
}
