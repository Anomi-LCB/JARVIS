import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PINNED_NODE_IMAGE = 'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';
const MAX_CODE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Run a small JavaScript task in a pinned, offline, read-only container.
 * Only explicit input files (read-only) and a dedicated output directory (writable)
 * are mounted. This is a local Linux-container boundary, not a VM or a claim that
 * a privileged Docker daemon is safe to expose to untrusted callers.
 */
export function runContainerExecution({
  code,
  inputs = {},
  dockerPath = process.env.JARVIS_DOCKER_PATH || 'docker',
  image = PINNED_NODE_IMAGE,
  timeoutMs = 15_000,
  maxOutputBytes = MAX_OUTPUT_BYTES
} = {}) {
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new TypeError(`code must be a string no larger than ${MAX_CODE_BYTES} bytes`);
  }
  if (image !== PINNED_NODE_IMAGE) throw new Error('unapproved sandbox image digest');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new RangeError('timeoutMs must be 100..120000');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) throw new RangeError('maxOutputBytes exceeds the fixed output cap');

  const entries = Object.entries(inputs);
  if (entries.length > 64) throw new RangeError('at most 64 input files are allowed');
  let inputBytes = 0;
  for (const [name, value] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(name) || name === '.' || name === '..') throw new TypeError(`unsafe input name: ${name}`);
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError(`input ${name} must be bytes or text`);
    inputBytes += Buffer.byteLength(value);
  }
  if (inputBytes > MAX_INPUT_BYTES) throw new RangeError(`inputs exceed ${MAX_INPUT_BYTES} bytes`);

  const root = mkdtempSync(join(tmpdir(), 'jarvis-container-task-'));
  const inputRoot = join(root, 'in');
  mkdirSync(inputRoot);
  const codePath = join(inputRoot, 'main.mjs');
  writeFileSync(codePath, code, { flag: 'wx' });
  for (const [name, value] of entries) writeFileSync(join(inputRoot, name), value, { flag: 'wx' });

  const args = [
    'create', '--name', `jarvis-task-${randomUUID()}`,
    '--network', 'none', '--read-only', '--user', '65534:65534',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534,mode=700',
    '--mount', `type=bind,source=${inputRoot},target=/task,readonly`,
    image, 'node', '/task/main.mjs'
  ];
  let containerId = null;
  let execution;
  let inspect;
  try {
    const create = spawnSync(dockerPath, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (create.error || create.status !== 0) throw dockerFailure('CONTAINER_CREATE_FAILED', create);
    containerId = create.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/iu.test(containerId)) throw new Error('Docker returned an invalid container identifier');

    const startedAt = Date.now();
    execution = spawnSync(dockerPath, ['start', '--attach', containerId], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: maxOutputBytes + 1
    });
    const durationMs = Date.now() - startedAt;
    inspect = spawnSync(dockerPath, ['inspect', '--format', '{{json .}}', containerId], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024
    });
    let metadata = null;
    try { metadata = JSON.parse(inspect.stdout.trim()); } catch { /* report missing daemon metadata below */ }
    const stdout = execution.stdout ?? '';
    if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) throw new Error('sandbox stdout exceeded the configured cap');
    const outputBytes = Buffer.from(stdout, 'utf8');
    const mounts = (metadata?.Mounts ?? []).map(mount => ({ destination: mount.Destination, readOnly: !mount.RW }));
    const restrictions = metadata ? {
      networkMode: metadata.HostConfig?.NetworkMode,
      readOnlyRootfs: metadata.HostConfig?.ReadonlyRootfs === true,
      user: metadata.Config?.User,
      memoryBytes: metadata.HostConfig?.Memory,
      cpuQuotaMicros: metadata.HostConfig?.CpuQuota,
      cpuNanoCpus: metadata.HostConfig?.NanoCpus,
      pidsLimit: metadata.HostConfig?.PidsLimit,
      scratchTmpfs: metadata.HostConfig?.Tmpfs?.['/tmp'] ?? null,
      capDrop: metadata.HostConfig?.CapDrop ?? [],
      noNewPrivileges: metadata.HostConfig?.SecurityOpt?.includes('no-new-privileges=true') === true,
      imageId: metadata.Image,
      exitCode: metadata.State?.ExitCode,
      status: metadata.State?.Status
    } : null;
    const enforcementVerified = restrictions?.networkMode === 'none'
      && restrictions.readOnlyRootfs && restrictions.user === '65534:65534'
      && restrictions.memoryBytes === 268435456 && restrictions.cpuNanoCpus === 1000000000
      && restrictions.pidsLimit === 64 && restrictions.capDrop.includes('ALL')
      && restrictions.noNewPrivileges && mounts.length === 1
      && mounts[0].destination === '/task' && mounts[0].readOnly
      && typeof restrictions.scratchTmpfs === 'string' && restrictions.scratchTmpfs.includes('size=32m')
      && restrictions.scratchTmpfs.includes('uid=65534') && restrictions.scratchTmpfs.includes('gid=65534');
    const result = {
      schemaVersion: 1, status: execution.status === 0 && restrictions?.exitCode === 0 ? 'completed' : execution.error?.code === 'ETIMEDOUT' ? 'timed_out' : 'failed',
      enforcementVerified, durationMs, exitCode: restrictions?.exitCode ?? execution.status,
      timedOut: execution.error?.code === 'ETIMEDOUT',
      stdout, stdoutSha256: createHash('sha256').update(outputBytes).digest('hex'), stderr: execution.stderr?.slice(0, 8_192) ?? '',
      outputBytes: outputBytes.length, restrictions, mounts,
      actualContainerExecution: true, networkRequests: 0, externalWrites: 0,
      limitations: ['A privileged Docker Desktop daemon remains a powerful host control surface and is not exposed to the task container.', 'This is a Linux container with the Docker Desktop VM boundary, not a separately administered hardened VM; kernel or daemon escape risk is not eliminated.']
    };
    if (!enforcementVerified) result.status = 'failed';
    return result;
  } finally {
    if (containerId) spawnSync(dockerPath, ['rm', '--force', containerId], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    rmSync(root, { recursive: true, force: true });
  }
}

function dockerFailure(code, result) {
  const error = new Error(code);
  error.code = result?.error?.code ?? code;
  error.detail = (result?.stderr ?? '').slice(0, 8_192);
  return error;
}

