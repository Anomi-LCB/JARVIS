/** Read-only Windows inventory. Metadata checks never replace install/signing evidence. */
export function renderInstallationPreflightScript() {
 return String.raw`$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$checks=New-Object 'Collections.Generic.List[object]'
function Add-Check($Id,$Status,$Message,$Next) {$checks.Add([pscustomobject]@{id=$Id;status=$Status;message=$Message;nextAction=$Next})}
function Import-OsModule([string]$Name) {
 $path=Join-Path ([Environment]::GetFolderPath('System')) ('WindowsPowerShell\v1.0\Modules\'+$Name+'\'+$Name+'.psd1')
 Import-Module -Name $path -ErrorAction Stop
}
try {Import-OsModule 'Microsoft.PowerShell.Security'} catch {Add-Check 'windows-security-module' 'unknown' 'Windows 서명·권한 모듈을 읽지 못했습니다.' 'Windows PowerShell 구성 점검'}
try {Import-OsModule 'CimCmdlets'} catch {Add-Check 'windows-service-module' 'unknown' 'Windows 서비스 정보를 읽을 준비가 없습니다.' 'Windows CIM 구성 점검'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Check 'administrator' $(if($admin){'pass'}else{'blocked'}) $(if($admin){'관리자 권한으로 점검 중입니다.'}else{'현재 점검은 일반 사용자 권한입니다.'}) '실제 설치 시 Windows 권한 확인 필요'
$manifest=$null
try {
 $manifest=Get-Content -LiteralPath (Join-Path $root 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($manifest.packageId -ne 'jarvis-pc-agent-windows-service' -or $manifest.serviceName -notmatch '^[A-Za-z0-9_.-]{1,100}$'){throw 'invalid'}
 Add-Check 'manifest' 'pass' 'PC 패키지 종류를 확인했습니다.' ''
}catch {Add-Check 'manifest' 'blocked' '설치 패키지 정보를 확인하지 못했습니다.' '검증된 새 설치본 준비'}
foreach($name in @('JarvisPcAgentTray.exe','JarvisPcAgentServiceHost.exe','runtime-integrity.psd1','JARVIS-PC-Agent-Setup.exe')){
 $path=Join-Path $root $name
 if(-not(Test-Path -LiteralPath $path -PathType Leaf)){Add-Check ('signature:'+ $name) 'blocked' ($name+' 파일이 없습니다.') '릴리스 빌드와 서명 자료 준비';continue}
 try {
  $signature=Get-AuthenticodeSignature -LiteralPath $path
  Add-Check ('signature:'+ $name) $(if($signature.Status -eq 'Valid'){'pass'}else{'blocked'}) ($name+' 서명 상태: '+$signature.Status) '유효한 배포 서명 필요; 별도 설치 검증 유지'
 }catch {Add-Check ('signature:'+ $name) 'unknown' ($name+' 서명을 확인하지 못했습니다.') 'Windows 서명 검사 구성 점검'}
}
$certificateStats=@{observed=$false;codeSigningCount=0;privateKeyCount=0;notSelfSignedCount=0;metadataCandidateCount=0;chainAndRevocationVerified=$false}
try {
 foreach($store in @('Cert:\CurrentUser\My','Cert:\LocalMachine\My')) {
  foreach($cert in @(Get-ChildItem -Path $store -CodeSigningCert -ErrorAction Stop)) {
   $certificateStats.codeSigningCount++
   if($cert.HasPrivateKey){$certificateStats.privateKeyCount++}
   if($cert.Issuer -ne $cert.Subject){$certificateStats.notSelfSignedCount++}
   if($cert.HasPrivateKey -and $cert.Issuer -ne $cert.Subject -and $cert.NotBefore -le [DateTime]::Now -and $cert.NotAfter -ge [DateTime]::Now.AddDays(30)) {$certificateStats.metadataCandidateCount++}
  }
 }
 $certificateStats.observed=$true
 Add-Check 'production-certificate' $(if($certificateStats.metadataCandidateCount -gt 0){'needs-validation'}else{'blocked'}) $(if($certificateStats.metadataCandidateCount -gt 0){'조건에 맞는 인증서 후보가 있습니다. 체인·폐기·키 규격 검증은 남았습니다.'}else{'정식 배포 서명 인증서 후보가 확인되지 않았습니다.'}) '인증서 선택은 보안 저장소에서; 개인 키를 대화에 입력하지 않기'
}catch {Add-Check 'production-certificate' 'unknown' '인증서 저장소를 확인하지 못했습니다.' '보안 저장소 접근 점검'}
$aclSummary=@{untrustedWriteRuleCount=0;completeAclAudit=$false}
try {
 $acl=Get-Acl -LiteralPath $root
 $writeMask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
 foreach($rule in $acl.Access){
  if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writeMask)) {
   $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
   if($sid -notin @('S-1-5-18','S-1-5-32-544')){$aclSummary.untrustedWriteRuleCount++}
  }
 }
 Add-Check 'code-write-boundary' $(if($aclSummary.untrustedWriteRuleCount -gt 0){'blocked'}else{'needs-validation'}) $(if($aclSummary.untrustedWriteRuleCount -gt 0){'관리자·SYSTEM 외 코드 쓰기 허용 규칙이 있습니다.'}else{'직접 확인한 ACL에 넓은 쓰기 허용은 없지만 전체 경계 검증은 남았습니다.'}) '신뢰된 설치 폴더의 소유권·상위 경로·유효 권한 감사'
}catch {Add-Check 'code-write-boundary' 'unknown' '설치 코드 폴더 권한을 확인하지 못했습니다.' '설치 폴더 ACL 점검'}
$serviceSummary=@{observed=$false;registered=$false;state='unknown';accountKind='unknown'}
if($manifest){
 try {
  $service=Get-CimInstance Win32_Service -Filter ("Name='"+$manifest.serviceName+"'") -ErrorAction Stop
  $serviceSummary.observed=$true;$serviceSummary.registered=$null -ne $service
  if($service){$serviceSummary.state=$service.State;$serviceSummary.accountKind=switch($service.StartName){'LocalSystem'{'system'};'NT AUTHORITY\LocalService'{'local-service'};'NT AUTHORITY\NetworkService'{'network-service'};default{'user-account'}}}
  if($service -and $serviceSummary.accountKind -ne 'user-account'){Add-Check 'credential-account-boundary' 'needs-validation' '서비스와 로그인 사용자의 보관함 연결 중개를 검증해야 합니다.' '같은 사용자 DPAPI 시험을 서비스 계정 성공으로 사용하지 않기'}
  Add-Check 'service-account' 'needs-validation' $(if($service){'기존 서비스의 등록·계정 종류를 확인했습니다.'}else{'기존 서비스가 등록되지 않았습니다.'}) '실제 서비스 계정의 상태 접근·DPAPI 및 설치/복원 검증'
 }catch {Add-Check 'service-account' 'unknown' '서비스 상태를 확인하지 못했습니다.' 'Windows 서비스 조회 권한 점검'}
}
$blocked=@($checks | Where-Object {$_.status -eq 'blocked' -or $_.status -eq 'unknown'}).Count
$report=[pscustomobject]@{module='PC_INSTALLATION_PREFLIGHT';version=1;observedAt=[DateTime]::UtcNow.ToString('o');status=$(if($blocked -gt 0){'blocked'}else{'needs-validation'});readOnly=$true;installationPerformed=$false;checks=@($checks.ToArray());certificates=$certificateStats;codeAcl=$aclSummary;service=$serviceSummary}
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::Out.Write(($report | ConvertTo-Json -Depth 8 -Compress))
`;
}
