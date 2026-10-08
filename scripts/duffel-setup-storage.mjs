import {mkdirSync,lstatSync,existsSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readPrivateFile} from '../packages/core/src/personal-operations/private-file.js';

const markerName='setup-owner.json';
const marker=JSON.stringify({schemaVersion:1,kind:'jarvis-duffel-test-user-storage'});
export function planDuffelUserStorage(env={}){
  if(typeof env.LOCALAPPDATA!=='string'||!isAbsolute(env.LOCALAPPDATA))return null;
  const directory=join(resolve(env.LOCALAPPDATA),'JARVIS','connections','duffel-test');
  return {directory,vaultPath:join(directory,'credentials.dpapi.json'),metadataPath:join(directory,'connection.json')};
}
/** Called only after a user clicks setup. No existing unmanaged folder is adopted. */
export function prepareDuffelUserStorage(plan){
  const directory=plan?.directory;
  if(process.platform!=='win32'||typeof directory!=='string'||!isAbsolute(directory)
    ||plan.vaultPath!==join(directory,'credentials.dpapi.json')||plan.metadataPath!==join(directory,'connection.json'))throw new Error('JARVIS_DUFFEL_SETUP_DIRECTORY_INVALID');
  try{
    for(let path=directory;;path=dirname(path)){
      if(existsSync(path)&&(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()))throw new Error();
      if(path===dirname(path))break;
    }
    if(!existsSync(directory)){
      mkdirSync(dirname(directory),{recursive:true});mkdirSync(directory);
      const script=`$ErrorActionPreference='Stop';
$path=$env:JARVIS_DUFFEL_PRIVATE_DIRECTORY;
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();
$acl=[IO.Directory]::GetAccessControl($path);$acl.SetAccessRuleProtection($true,$false);
foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)};
$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
$acl.AddAccessRule($rule);$acl.SetOwner($identity.User);[IO.Directory]::SetAccessControl($path,$acl);`;
      const childEnv=Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','USERPROFILE'].filter(n=>process.env[n]).map(n=>[n,process.env[n]]));
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,stdio:['ignore','ignore','ignore'],env:{...childEnv,JARVIS_DUFFEL_PRIVATE_DIRECTORY:directory}});
      writeFileSync(join(directory,markerName),marker,{mode:0o600,flag:'wx'});
    }
    if(readPrivateFile(join(directory,markerName)).toString('utf8')!==marker)throw new Error();
    const allowed=new Set([markerName,'credentials.dpapi.json','connection.json']);
    for(const name of readdirSync(directory)){
      const file=join(directory,name),stat=lstatSync(file);
      if(!allowed.has(name)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error();
      if(name!==markerName)readPrivateFile(file,{maxBytes:1048576});
    }
    return plan;
  }catch{throw new Error('JARVIS_DUFFEL_SETUP_DIRECTORY_INVALID');}
}
