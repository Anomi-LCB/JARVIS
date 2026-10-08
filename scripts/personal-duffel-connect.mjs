import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {saveDuffelTestCredential} from '../packages/core/src/personal-operations/duffel-credential-setup.js';

// Interactive, local credential helper. Key is absent from command line/env/files/logs.
export function connectDuffelTestInteractively({env=process.env}={}) {
  if(process.platform!=='win32'||!env.JARVIS_DUFFEL_SETUP_VAULT||!env.JARVIS_DUFFEL_SETUP_METADATA)
    throw new Error('A_DUFFEL_SETUP_PATHS_REQUIRED');
  const script=`$ErrorActionPreference='Stop';
if(-not [Environment]::UserInteractive){exit 3};
Add-Type -AssemblyName System.Windows.Forms;
$form=New-Object System.Windows.Forms.Form;$form.Text='JARVIS 여행 시험 계정 연결';$form.Width=600;$form.Height=300;$form.StartPosition='CenterScreen';
$label=New-Object System.Windows.Forms.Label;$label.Text='Duffel 시험 API 키를 입력하세요. 이 PC의 Windows 암호화 저장소에 저장합니다.';$label.SetBounds(20,20,550,45);$form.Controls.Add($label);
$input=New-Object System.Windows.Forms.TextBox;$input.UseSystemPasswordChar=$true;$input.MaxLength=524;$input.SetBounds(20,75,540,30);$form.Controls.Add($input);
$consent=New-Object System.Windows.Forms.CheckBox;$consent.Text='시험 견적 읽기만 허용합니다. 예약·결제 권한은 부여하지 않습니다.';$consent.SetBounds(20,120,550,35);$form.Controls.Add($consent);
$save=New-Object System.Windows.Forms.Button;$save.Text='보호 저장';$save.SetBounds(340,180,105,35);$save.Enabled=$false;$form.Controls.Add($save);
$cancel=New-Object System.Windows.Forms.Button;$cancel.Text='취소';$cancel.SetBounds(455,180,105,35);$cancel.DialogResult=[System.Windows.Forms.DialogResult]::Cancel;$form.Controls.Add($cancel);$form.CancelButton=$cancel;
$update={ $save.Enabled=$consent.Checked -and $input.Text -match '^duffel_test_[A-Za-z0-9_-]{8,512}$' };$input.Add_TextChanged($update);$consent.Add_CheckedChanged($update);
$save.Add_Click({$form.DialogResult=[System.Windows.Forms.DialogResult]::OK;$form.Close()});
try{if($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($input.Text)}else{exit 2}}finally{$input.Text='';$form.Dispose()}`;
  let bytes;
  try{
    const childEnv=Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
    bytes=execFileSync('powershell.exe',['-NoProfile','-STA','-Command',script],{env:childEnv,encoding:null,maxBuffer:4096,timeout:300000,windowsHide:true,stdio:['ignore','pipe','ignore']});
    return saveDuffelTestCredential({apiKey:bytes.toString('utf8'),vaultPath:env.JARVIS_DUFFEL_SETUP_VAULT,metadataPath:env.JARVIS_DUFFEL_SETUP_METADATA,readConsent:true});
  }catch(error){if(error?.status===2)throw new Error('A_DUFFEL_SETUP_CANCELLED');
    if(/^A_DUFFEL_SETUP_[A-Z_]+$/u.test(error?.message??''))throw error;
    throw new Error('A_DUFFEL_SETUP_FAILED');}
  finally{bytes?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(connectDuffelTestInteractively()));}
  catch(error){console.error(/^A_DUFFEL_SETUP_[A-Z_]+$/u.test(error?.message??'')?error.message:'A_DUFFEL_SETUP_FAILED');process.exitCode=1;}
}
