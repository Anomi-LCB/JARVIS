import { validateWorkflowSpec } from './workflow-ir.js';
import { isLocalOnlyWorkflowSpec } from './mission-local-workflow-constraints.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keysOnly = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const structuredLocalTools = new Set(['filesystem.createTextFile', 'filesystem.moveFiles', 'filesystem.previewMoveFiles',
  'word.create', 'hwp.create', 'powerpoint.create', 'excel.createWorkbook','excel.exportPdf', 'document.edit', 'visual.createCards',
  'archive.createZip', 'macro.save', 'weather.createHwpReport']);
const desktopChecks = new Set(['windowExists', 'windowTitleContains', 'elementExists', 'elementValueEquals',
  'elementNameEquals', 'elementNameContains', 'elementEnabled']);

function onlyDesktopObservation(args) {
  if (!keysOnly(args, ['target', 'operations', 'verification', 'timeoutMs', 'rawText'])
    || !Array.isArray(args.operations) || !args.operations.length || args.operations.length > 16) return false;
  if (!args.operations.every(operation => keysOnly(operation, ['op', 'timeoutMs'])
    && ['inspect', 'wait'].includes(operation.op)
    && (operation.timeoutMs === undefined || (Number.isFinite(operation.timeoutMs) && operation.timeoutMs >= 0 && operation.timeoutMs <= 15000)))) return false;
  if (args.verification !== undefined && (!Array.isArray(args.verification) || args.verification.length > 12
    || !args.verification.every(check => keysOnly(check, ['type', 'target', 'selector', 'expected', 'timeoutMs'])
      && desktopChecks.has(check.type)))) return false;
  return true;
}

/** Mission-only effect classification. Planner flags and E approval do not
 * prove which effects an arbitrary shell command or UI mutation will produce.
 * No command text is inspected for a permissive "safe-looking" prefix. */
export function classifyMissionEffectScope({ action, profile, dispatchToolName, arguments: args, allowedRoots = [] }) {
  const toolName = dispatchToolName ?? action.actualToolName ?? profile.toolName ?? action.expectedToolName;
  const result = (scope, reason) => ({ scope, reason, toolName });
  if ([dispatchToolName, action.actualToolName, profile.toolName].filter(Boolean).some(name => name !== toolName)) {
    return result('opaque', 'tool-profile-mismatch');
  }
  if (!toolName || profile.effectScope === 'opaque') return result('opaque', 'effect-contract-unavailable');
  if (toolName === 'desktop.control') return onlyDesktopObservation(args)
    ? result('structured-read', 'desktop-inspect-wait-only') : result('opaque', 'desktop-mutation-effects-unresolved');
  if (toolName === 'workflow.execute') {
    try {
      let spec;
      if (args?.spec !== undefined) spec = validateWorkflowSpec(args.spec);
      else if (typeof args?.specPath === 'string' && /^[a-f0-9]{64}$/iu.test(args.expectedSha256 ?? '') && allowedRoots.length) {
        const file = resolve(args.specPath), realFile = realpathSync.native(file);
        const inside = allowedRoots.some(root => {
          const base = realpathSync.native(resolve(root)), suffix = relative(base, realFile);
          return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
        });
        if (!inside || !lstatSync(file).isFile()) return result('opaque', 'workflow-spec-path-untrusted');
        const bytes = readFileSync(file);
        if (bytes.length > 8 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== args.expectedSha256.toLowerCase()) {
          return result('opaque', 'workflow-spec-integrity-unverified');
        }
        spec = validateWorkflowSpec(JSON.parse(bytes.toString('utf8')));
      } else return result('opaque', 'workflow-effect-spec-unavailable');
      // External, mutating SQL, process and unknown operations stay behind E.
      if (!isLocalOnlyWorkflowSpec(spec)) return result('opaque', 'workflow-nonlocal-operation-unresolved');
      return result('structured-local', 'validated-inline-workflow-operations');
    } catch { return result('opaque', 'workflow-effect-spec-unavailable'); }
  }
  if (/^mcp\.[a-f0-9-]{36}\.[^.]+$/u.test(toolName) && profile.contractEffectScope === 'external') {
    return result('external', 'registered-mcp-external-contract');
  }
  if (toolName === 'email.send') return result('external', 'registered-external-transfer');
  if (toolName === 'shell.execute' || /(?:^|\.)(?:execute|evaluate|invoke|dispatch|run|control)$/u.test(toolName)) {
    return result('opaque', 'general-execution-effects-unresolved');
  }
  if (structuredLocalTools.has(toolName)) return result('structured-local', 'known-structured-local-adapter');
  // readOnly alone can be inferred from planner capability metadata. Only the
  // installed adapter's explicit contract provides a read-only effect boundary.
  if (profile.contractReadOnly === true && profile.readOnly === true && profile.mutatesSystem !== true) {
    return result('structured-read', 'registered-read-contract');
  }
  return result('opaque', 'effect-contract-unavailable');
}
