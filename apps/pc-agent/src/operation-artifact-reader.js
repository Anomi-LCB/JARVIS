import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { executionPacketFingerprint } from '../../../packages/shared/src/execution-packet-fingerprint.js';
import {PcLocalTaskScope} from './pc-local-task-scope.js';

const fail = suffix => { throw Object.assign(new Error(`A_PC_ARTIFACT_${suffix}`), { code: `A_PC_ARTIFACT_${suffix}` }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => {
  const tail = relative(root, path);
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
};
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

/** Read-only, opt-in building block. No HTTP route or execution authority is granted. */
export function createOperationArtifactReader({ readOperation, allowedRoots, allowedTaskIds, taskCatalog=null, expectedRootScopeSha256 = null, onRead = null } = {}) {
  if (typeof readOperation !== 'function' || !Array.isArray(allowedRoots) || !allowedRoots.length
    || allowedRoots.some(root => typeof root !== 'string' || !isAbsolute(root))
    || !Array.isArray(allowedTaskIds) || (onRead !== null && typeof onRead !== 'function')
    ||taskCatalog!==null&&(!(taskCatalog instanceof PcLocalTaskScope)||!taskCatalog.catalogEnabled||allowedTaskIds.length)) fail('CONFIG_INVALID');
  const roots = allowedRoots.map(root => resolve(root)), tasks = new Set(allowedTaskIds);
  // Directory content/timestamps can change normally. Pin only the physical
  // directory identity, not its mtime or ctime, for this provisioned reader.
  const identities = roots.map(path => {
    const physical = realpathSync(path), info = statSync(physical,{bigint:true});
    if(!info.isDirectory())fail('CONFIG_INVALID');
    return {path,physical,dev:info.dev.toString(),ino:info.ino.toString()};
  });
  const rootScopeSha256 = digest(JSON.stringify(identities));
  if(expectedRootScopeSha256!==null&&(!/^[a-f0-9]{64}$/u.test(expectedRootScopeSha256)
    ||expectedRootScopeSha256!==rootScopeSha256))fail('ROOT_SCOPE_MISMATCH');
  const assertRoots = async () => {
    for(const identity of identities) {
      let physical,info;
      try { physical=await realpath(identity.path);info=await stat(physical,{bigint:true}); }
      catch { fail('ROOT_CHANGED'); }
      if(physical!==identity.physical||!info.isDirectory()||info.dev.toString()!==identity.dev||info.ino.toString()!==identity.ino)fail('ROOT_CHANGED');
    }
  };
  return async ({ operationId, taskId, action } = {}) => {
    action = structuredClone(action);
    const lease=taskCatalog?.captureCatalog(taskId,'artifact');
    if (!(taskCatalog?true:tasks.has(taskId)) || !/^mission_op_[a-f0-9]{32}$/u.test(operationId ?? '')
      || action?.toolName !== 'filesystem.createTextFile' || typeof action.arguments?.path !== 'string'
      || !action.arguments.path.trim() || action.arguments.path.includes('\0')
      || typeof (action.arguments.content ?? '') !== 'string') fail('SCOPE_DENIED');
    if (Buffer.byteLength(action.arguments.content ?? '', 'utf8') > 64 * 1024) fail('BUDGET_EXCEEDED');
    await assertRoots();
    const expected = Buffer.from(action.arguments.content ?? '', 'utf8');
    const fingerprint = executionPacketFingerprint({ taskId, action, requestedMode: 'execute' });
    const record = await readOperation({ operationId, taskId, action: structuredClone(action) });
    if(lease)taskCatalog.assertCatalogCurrent(taskId,'artifact',lease);
    const receipt = record?.receipt, result = receipt?.executionResult;
    const target = resolve(roots[0], action.arguments.path);
    if (record?.operationId !== operationId || record?.taskId !== taskId || record?.fingerprint !== fingerprint
      || record?.state !== 'succeeded' || record?.executionAuthority !== false
      || receipt?.status !== 'COMPLETED' || receipt?.taskId !== taskId || result?.taskId !== taskId
      || result?.executedBy?.toolName !== action.toolName
      || !(result?.success === true || (result?.success !== false && result?.status === 'success')) || result?.dryRun === true
      || receipt?.shadow?.dryRun === true || !result?.packetId || !receipt?.evidence?.evidenceId
      || !Array.isArray(result.outputPaths) || result.outputPaths.length !== 1
      || typeof result.outputPaths[0] !== 'string' || resolve(result.outputPaths[0]) !== target) fail('RECEIPT_MISMATCH');
    if (!roots.some(root => within(root, target))) fail('OUTSIDE_ROOT');
    const physical = await realpath(target);
    let allowed = false;
    for (const root of roots) if (within(root, target) && within(await realpath(root), physical)) allowed = true;
    if (!allowed) fail('OUTSIDE_ROOT');
    await assertRoots();
    const handle = await open(physical, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > 65536n) fail('BUDGET_EXCEEDED');
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (onRead) await onRead({ bytesRead, offset });
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true }), published = await stat(target, { bigint: true });
      await assertRoots();
      if (offset !== Number(before.size) || !unchanged(before, after) || !unchanged(after, published)
        || !published.isFile() || await realpath(target) !== physical) fail('CHANGED');
      const content = bytes.subarray(0, offset);
      if (!content.equals(expected)) fail('CONTENT_MISMATCH');
      if(lease)taskCatalog.assertCatalogCurrent(taskId,'artifact',lease);
      return { operationId, taskId, fingerprint, packetId: result.packetId, evidenceId: receipt.evidence.evidenceId,
        encoding: 'base64', bytes: content.toString('base64'), size: content.length, sha256: digest(content), rootScopeSha256,
        executionAuthority: false, verifiedCompletion: false };
    } finally { await handle.close(); }
  };
}
