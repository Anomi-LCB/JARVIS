import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';

// Explicit pins are supplied by the reviewed package. Never discover an arbitrary executable.
export function validateCoreInstalledRuntimeBinding(input){
 if(!input||Object.keys(input).sort().join(',')!=='launcherSha256,nodeSha256,packageRoot,stateRoot')throw new Error('CORE_INSTALLED_BINDING_INVALID');
 for(const key of ['packageRoot','stateRoot'])if(typeof input[key]!=='string'||!isAbsolute(input[key])||/[\x00-\x1f]/u.test(input[key]))throw new Error('CORE_INSTALLED_BINDING_PATH_INVALID');
 for(const key of ['launcherSha256','nodeSha256'])if(!/^[a-f0-9]{64}$/u.test(input[key]??''))throw new Error('CORE_INSTALLED_BINDING_PIN_REQUIRED');
 const packageRoot=resolve(input.packageRoot),stateRoot=resolve(input.stateRoot);
 const canonicalPackage=realpathSync(packageRoot);
 if(!samePath(packageRoot,canonicalPackage))throw new Error('CORE_INSTALLED_BINDING_LINK_DENIED');
 assertCoreWritablePathOutsidePackage({packageRoot:canonicalPackage},stateRoot);
 const launcherPath=resolve(packageRoot,'pc-agent-runtime/core-launch.mjs'),nodePath=resolve(packageRoot,'runtime/node.exe');
 checkFile(launcherPath,input.launcherSha256,2*1024*1024);
 checkFile(nodePath,input.nodeSha256,128*1024*1024);
 const manifestPath=resolve(packageRoot,'package-manifest.json');
 const info=lstatSync(manifestPath);if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024||!samePath(realpathSync(manifestPath),manifestPath))throw new Error('CORE_INSTALLED_BINDING_MANIFEST_INVALID');
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(manifest.packageId!=='jarvis-pc-agent-windows-service'||manifest.fileIntegrity?.['pc-agent-runtime/core-launch.mjs']?.sha256!==input.launcherSha256||manifest.fileIntegrity?.['runtime/node.exe']?.sha256!==input.nodeSha256)throw new Error('CORE_INSTALLED_BINDING_MANIFEST_INVALID');
 return {...input,packageRoot,stateRoot,launcherPath,nodePath};
}
function samePath(a,b){return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
function assertOutside(root,path){const rel=relative(root,path);if(!rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new Error('CORE_INSTALLED_BINDING_STATE_IS_CODE');}
export function assertCoreWritablePathOutsidePackage(binding,path){
 const target=resolve(path);let ancestor=target;
 while(true){try{const canonical=realpathSync(ancestor);assertOutside(binding.packageRoot,resolve(canonical,relative(ancestor,target)));return;}
  catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
}
function checkFile(path,sha,limit){const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>limit||!samePath(realpathSync(path),path))throw new Error('CORE_INSTALLED_BINDING_LINK_DENIED');
 if(createHash('sha256').update(readFileSync(path)).digest('hex')!==sha)throw new Error('CORE_INSTALLED_BINDING_INTEGRITY_FAILED');}

export function installedBindingPreflightLines(binding){
 if(!binding)return [];
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 return ['$ErrorActionPreference = "Stop"','function Assert-CoreRuntimePinnedFile([string]$Path,[string]$Expected) {',
  '  $item = Get-Item -LiteralPath $Path -ErrorAction Stop',
  '  if ($item.PSIsContainer) { throw "Core runtime is not a file." }',
  '  $cursor = $item.FullName',
  '  while (-not [string]::IsNullOrEmpty($cursor)) { if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Core runtime link denied." }; $cursor = [IO.Path]::GetDirectoryName($cursor) }',
  '  $stream = [IO.File]::OpenRead($Path); $sha = [Security.Cryptography.SHA256]::Create()',
  '  try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-","").ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }',
  '  if ($actual -ne $Expected) { throw "Core runtime integrity failed." }',
  '}',`Assert-CoreRuntimePinnedFile ${quote(binding.launcherPath)} ${quote(binding.launcherSha256)}`,
  `Assert-CoreRuntimePinnedFile ${quote(binding.nodePath)} ${quote(binding.nodeSha256)}`];
}

export function installedBindingCsharp(binding,csharpString){
 if(!binding)return ['  private static void VerifyRuntimeBinding() {}'];
 return ['  private static void VerifyRuntimeBinding() {',
  `    VerifyPinnedFile(${csharpString(binding.launcherPath)},${csharpString(binding.launcherSha256)});`,
  `    VerifyPinnedFile(${csharpString(binding.nodePath)},${csharpString(binding.nodeSha256)});`,
  '  }','  private static void VerifyPinnedFile(string path,string expected) {',
  '    if(!File.Exists(path))throw new InvalidOperationException("CORE_INSTALLED_RUNTIME_MISSING");',
  '    for(string current=path;!String.IsNullOrEmpty(current);current=Path.GetDirectoryName(current)) {',
  '      if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("CORE_INSTALLED_RUNTIME_LINK_DENIED");',
  '    }',
  '    using(var stream=File.OpenRead(path))using(var sha=System.Security.Cryptography.SHA256.Create()) {',
  '      var actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();',
  '      if(actual!=expected)throw new InvalidOperationException("CORE_INSTALLED_RUNTIME_INTEGRITY_FAILED");',
  '    }','  }'];
}
