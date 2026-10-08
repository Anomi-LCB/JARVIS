import { createHash } from 'node:crypto';
import { win32, posix } from 'node:path';

const fail = code => { throw Object.assign(new Error(`A_REMOTE_ARTIFACT_${code}`), { code: `A_REMOTE_ARTIFACT_${code}` }); };
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
export const remoteArtifactDigest = value => createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
const keys = (value, required) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value,key));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/u.test(value);

function normalized(path, platform, base = null) {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f]/u.test(path)) fail('PATH_INVALID');
  const api = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    // Drive-relative, UNC/device names, ADS and DOS aliases need separate
    // physical resource contracts; do not silently reinterpret them on Linux.
    if (/^[a-z]:(?![\\/])/iu.test(path) || /^[\\/]/u.test(path) || /[:<>"|?*]/u.test(path.replace(/^[a-z]:/iu,''))) fail('PATH_INVALID');
    for (const part of path.replace(/^[a-z]:/iu,'').split(/[\\/]/u).filter(Boolean)) {
      if (/[ .]$/u.test(part) && !['.','..'].includes(part)
        || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) fail('PATH_INVALID');
    }
  } else if (path.includes('\\')) fail('PATH_INVALID');
  if (!api.isAbsolute(path) && !base) fail('PATH_INVALID');
  const result = api.resolve(...(base ? [base,path] : [path]));
  return platform === 'win32' ? result.toLowerCase() : result;
}

/** A serialized logical scope contract, not execution permission or OS attestation. */
export function createRemoteArtifactBinding(input) {
  const physical=Object.hasOwn(input??{},'rootScopeSha256');
  if (!keys(input,['deviceId','deviceGeneration','certificateFingerprint','pathPlatform','allowedRoots',...(physical?['rootScopeSha256']:[])])
    || !id(input.deviceId) || !Number.isSafeInteger(input.deviceGeneration) || input.deviceGeneration<1
    || !['win32','posix'].includes(input.pathPlatform) || typeof input.certificateFingerprint!=='string'
    || !Array.isArray(input.allowedRoots) || !input.allowedRoots.length || input.allowedRoots.length>64) fail('BINDING_INVALID');
  if(physical&&!/^[a-f0-9]{64}$/u.test(input.rootScopeSha256))fail('BINDING_INVALID');
  const certificateFingerprint=input.certificateFingerprint.replaceAll(':','').toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(certificateFingerprint)) fail('BINDING_INVALID');
  const allowedRoots=input.allowedRoots.map(root=>normalized(root,input.pathPlatform));
  if (new Set(allowedRoots).size!==allowedRoots.length) fail('BINDING_INVALID');
  return { version:physical?'remote-artifact-binding-v2':'remote-artifact-binding-v1',deviceId:input.deviceId,deviceGeneration:input.deviceGeneration,
    certificateFingerprint,pathPlatform:input.pathPlatform,allowedRoots,...(physical?{rootScopeSha256:input.rootScopeSha256}:{}) };
}

function validateBinding(binding) {
  const physical=binding?.version==='remote-artifact-binding-v2';
  if (!keys(binding,['version','deviceId','deviceGeneration','certificateFingerprint','pathPlatform','allowedRoots',...(physical?['rootScopeSha256']:[])])
    || !['remote-artifact-binding-v1','remote-artifact-binding-v2'].includes(binding.version)) fail('BINDING_INVALID');
  const {version,...input}=binding;
  const canonical=createRemoteArtifactBinding(input);
  if (remoteArtifactDigest(canonical)!==remoteArtifactDigest(binding)) fail('BINDING_INVALID');
  return canonical;
}

export function createRemoteArtifactIntent({ binding, taskId, operationId, action }={}) {
  binding=validateBinding(binding);
  if (typeof taskId!=='string'|| !/^[\p{L}\p{N}._-]{1,128}$/u.test(taskId)
    || !/^mission_op_[a-f0-9]{32}$/u.test(operationId??'') || action?.toolName!=='filesystem.createTextFile'
    || typeof (action.arguments?.content??'')!=='string'||Buffer.byteLength(action.arguments?.content??'','utf8')>65536) fail('INTENT_INVALID');
  const target=normalized(action.arguments?.path,binding.pathPlatform,binding.allowedRoots[0]);
  const api=binding.pathPlatform==='win32'?win32:posix;
  if (!binding.allowedRoots.some(root=>{
    const tail=api.relative(root,target);
    return tail===''||tail!=='..'&&!tail.startsWith(`..${api.sep}`)&&!api.isAbsolute(tail);
  })) fail('OUTSIDE_ROOT');
  return { version:'remote-artifact-intent-v1',binding,taskId,operationId,actionSha256:remoteArtifactDigest(action),target,
    // A certificate or generation rotation must not create a second lock for
    // the same logical device/file while an older effect remains unresolved.
    resourceKey:`remote-file:${remoteArtifactDigest({deviceId:binding.deviceId,pathPlatform:binding.pathPlatform,target})}` };
}

export function validateRemoteArtifactIntent(intent,{binding,taskId,operationId,action}={}) {
  const expected=createRemoteArtifactIntent({binding,taskId,operationId,action});
  if (remoteArtifactDigest(intent)!==remoteArtifactDigest(expected)) fail('INTENT_MISMATCH');
  return expected;
}
