import {lstatSync,realpathSync,statfsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const code='A_CORE_LEDGER_LOCAL_STORAGE_REQUIRED';
const fail=()=>{throw Object.assign(new Error(code),{code});};

/** Reject network/URI/device namespaces before any filesystem or network lookup. */
export function assertLedgerPathSyntax(path){
 if(typeof path!=='string'||!path.trim()||/[\u0000-\u001f]/u.test(path)||/^[\\/]{2}|^[a-z][a-z\d+.-]*:\/\//iu.test(path)||/^file:/iu.test(path))fail();
 return path;
}
export function localLedgerVolumeAllowed(platform,value){
 if(platform==='win32')return value&&[2,3,6].includes(value.driveType)&&!['CSVFS','SMB','CIFS','NFS'].includes(String(value.format).toUpperCase());
 if(platform==='linux')return [0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630,0x2fc12fc1].includes(Number(value?.type));
 return false;
}
const windowsProbe=String.raw`$ErrorActionPreference='Stop';
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class JarvisLedgerVolume { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumePathName(string path, StringBuilder volume, uint length); }';
$paths=ConvertFrom-Json $env:JARVIS_LEDGER_VOLUME_PATHS;
$rows=@(foreach($path in $paths){$volume=New-Object Text.StringBuilder 1024; if(-not [JarvisLedgerVolume]::GetVolumePathName($path,$volume,1024)){throw 'VOLUME_UNKNOWN'}; $drive=New-Object IO.DriveInfo ($volume.ToString()); if(-not $drive.IsReady){throw 'VOLUME_UNREADY'}; @{driveType=[int]$drive.DriveType;format=$drive.DriveFormat}});
ConvertTo-Json -InputObject $rows -Compress;`;

/** Startup guard only. Never cached as an execution grant or filesystem-race proof. */
export function assertLocalLedgerStorage(paths){
 try{
  if(!Array.isArray(paths)||paths.length===0)fail();
  const ancestors=paths.map(path=>{
   assertLedgerPathSyntax(path);let current=resolve(path);
   while(true){try{lstatSync(current);break;}catch(e){if(e.code!=='ENOENT')throw e;const parent=dirname(current);if(parent===current)throw e;current=parent;}}
   const physical=realpathSync.native(current);assertLedgerPathSyntax(physical);return physical;
  });
  let volumes;
  if(process.platform==='win32'){
   const executable=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
   const result=execFileSync(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsProbe,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384,stdio:['ignore','pipe','pipe'],env:{...process.env,JARVIS_LEDGER_VOLUME_PATHS:JSON.stringify(ancestors)}});
   volumes=JSON.parse(result);
  }else if(process.platform==='linux')volumes=ancestors.map(path=>({type:statfsSync(path).type}));
  else fail();
  if(!Array.isArray(volumes)||volumes.length!==paths.length||volumes.some(volume=>!localLedgerVolumeAllowed(process.platform,volume)))fail();
  return {version:'local-ledger-storage-v1',checkedPaths:paths.length,platform:process.platform,localVolumeObserved:true,exclusiveHostOwnershipVerified:false};
 }catch{fail();}
}
