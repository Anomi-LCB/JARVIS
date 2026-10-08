import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {platform,release,arch} from 'node:os';
import {randomUUID} from 'node:crypto';
const execute=promisify(execFile);
const script="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $d=Get-CimInstance -ClassName Win32_ComputerSystem -Property Manufacturer,Model; $i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=New-Object Security.Principal.WindowsPrincipal($i); [ordered]@{manufacturer=$d.Manufacturer;model=$d.Model;elevatedToken=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress";
const label=value=>typeof value==='string'&&value.trim()&&value.length<=256&&!/[\u0000-\u001f]/u.test(value);

/** Current host diagnostics only. No serial, hostname, account, MAC or credential collection. */
export async function observePcDevice({clock=()=>new Date(),run=execute,hostPlatform=platform()}={}){
  const startedAt=clock().toISOString();let hardware=null,elevatedToken=null,probeStatus='unsupported-platform';
  if(hostPlatform==='win32'){
    try{
      const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:16384,encoding:'utf8'});
      const value=JSON.parse(result.stdout.replace(/^\uFEFF/u,''));
      if(!value||Object.keys(value).some(k=>!['manufacturer','model','elevatedToken'].includes(k))||!label(value.manufacturer)||!label(value.model)||typeof value.elevatedToken!=='boolean')throw Error();
      hardware={manufacturer:value.manufacturer.trim(),model:value.model.trim(),source:'windows-cim'};elevatedToken=value.elevatedToken;probeStatus='observed';
    }catch{probeStatus='unavailable';}
  }
  return {observationId:randomUUID(),startedAt,observedAt:clock().toISOString(),
    deviceType:'pc',os:{platform:platform(),release:release(),architecture:arch(),source:'node-os'},hardware,
    permissions:{elevatedToken,source:elevatedToken===null?'not-observed':'windows-token'},probeStatus,
    nodeIdentityVerified:false,accountIdentityVerified:false,executionAuthority:false,
    connection:{status:'not-evaluated',reason:'host-observation-does-not-prove-execution-channel'},
    excluded:['serial-number','hostname','user-account','mac-address','credentials']};
}
