param([string]$OwnerPath,[string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Start-Sleep -Seconds 7
if(-not (Test-Path -LiteralPath $OwnerPath)){exit 0}
$owner=Get-Content -LiteralPath $OwnerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if($owner.marker -ne 'jarvis-hwp-owned-v1'){exit 0}
$process=Get-Process -Id $owner.processId -ErrorAction SilentlyContinue
if($null -eq $process -or $process.ProcessName -ne 'Hwp' -or [Math]::Abs(($process.StartTime.ToUniversalTime()-[DateTimeOffset]::Parse($owner.startedAtUtc).UtcDateTime).TotalSeconds) -gt 1){exit 0}
$condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$owner.processId)
$windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
$items=@()
foreach($window in $windows){
 $items+=@{type='Window';name=$window.Current.Name}
 $children=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
 foreach($item in $children){if($items.Count -ge 80){break};$name=[string]$item.Current.Name;if($name.Length -gt 0){$items+=@{type=$item.Current.ControlType.ProgrammaticName;name=$name.Substring(0,[Math]::Min(300,$name.Length))}}}
}
@{processId=$owner.processId;observedAt=[DateTime]::UtcNow.ToString('o');items=$items} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
