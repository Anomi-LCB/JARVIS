import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Windows OAuth broker scripts report missing handoff setup before any Core request', {skip:process.platform!=='win32'}, t=>{
  const shell=process.env.SystemRoot?join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe';
  const root=mkdtempSync(join(tmpdir(),'jarvis-handoff-preflight-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const clientPath=join(root,'oauth-client.json');
  writeFileSync(clientPath,JSON.stringify({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture-only'}}));
  const env={...process.env,LOCALAPPDATA:root,OS:'Windows_NT'};
  const cases=[
    {script:'personal-google-connect-service.ps1',args:['-ClientPath',clientPath],code:'A_GOOGLE_HANDOFF_TOKEN_NOT_CONFIGURED'},
    {script:'personal-model-provider-connect.ps1',args:['-Provider','xai'],code:'A_MODEL_HANDOFF_TOKEN_NOT_CONFIGURED'}
  ];
  for(const scenario of cases){
    const result=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',resolve('scripts',scenario.script),...scenario.args],{cwd:process.cwd(),env,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.error,undefined,`${scenario.script}: ${result.error?.message}`);
    assert.notEqual(result.status,0,`${scenario.script} must block before network use`);
    assert.match(`${result.stdout}\n${result.stderr}`,new RegExp(scenario.code));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,/fixture-only/u);
  }
});
