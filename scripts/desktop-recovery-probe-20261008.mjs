import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {WindowsDesktopControlToolAdapter} from '../apps/pc-agent/src/windows-desktop-control.js';
const root=await mkdtemp(join(tmpdir(),'jarvis-desktop-recovery-')),title='JARVIS Recovery '+Date.now(),output=join(root,'result.txt'),ready=join(root,'ready.txt');
const fixture=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',resolve('scripts/fixtures/desktop-recovery-fixture.ps1'),'-Title',title,'-OutputPath',output,'-ReadyPath',ready],{windowsHide:false,stdio:'ignore'});
const cases=[],adapter=new WindowsDesktopControlToolAdapter({allowedRoots:[root]});
const check=expected=>[{type:'elementValueEquals',selector:{automationId:'Status'},expected}];
const target=()=>({processId:fixture.pid,title});
const run=async(id,operations,verification=check('WAITING'),scope=target())=>{
 const value=await adapter.execute({target:scope,operations,verification,timeoutMs:1000});cases.push({id,...value});return value;
};
const invoke=id=>({op:'invoke',selector:{automationId:id}});
try{
 for(let i=0;i<80;i++){try{await access(ready);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 await access(ready);
 await run('duplicate-element-without-index',[invoke('Duplicate')],check('FIRST_SELECTED'));
 await run('duplicate-element-explicit-index',[{...invoke('Duplicate'),selector:{automationId:'Duplicate',index:1}}],check('SECOND_SELECTED'));
 await run('failed-save',[{op:'setValue',selector:{automationId:'Input'},value:'synthetic-recovery'},invoke('Save')],check('SAVED'));
 let outputAbsent=false;try{await access(output);}catch{outputAbsent=true;}
 await run('enable-save',[invoke('EnableSave')],check('READY'));
 await run('changed-ui',[invoke('MoveSave')],check('UI_CHANGED'));
 await run('stale-selector',[invoke('Save')],check('SAVED'));
 await run('updated-selector',[invoke('SaveV2')],check('SAVED'));
 const outputMatches=await readFile(output,'utf8')==='synthetic-recovery';
 await run('open-second',[invoke('OpenSecond')],[{type:'windowTitleContains',target:{processId:fixture.pid,title:title+' Second'},expected:title+' Second'}]);
 await run('ambiguous-process-window',[{op:'inspect'}],[{type:'windowExists'}],{processId:fixture.pid});
 await run('close-second',[invoke('CloseSecond')],check('SAVED').map(c=>({...c,target:target()})),{processId:fixture.pid,title:title+' Second'});
 await run('open-popup',[invoke('OpenPopup')],[{type:'windowTitleContains',target:{processId:fixture.pid,title:title+' Popup'},expected:title+' Popup'}]);
 await run('main-disabled-by-popup',[{op:'inspect'}],[{type:'elementEnabled',selector:{automationId:'SaveV2'},expected:false}]);
 await run('popup-handoff',[invoke('Confirm')],check('CONFIRMED').map(c=>({...c,target:target()})),{processId:fixture.pid,title:title+' Popup'});
 await run('main-after-popup',[{op:'inspect'}],check('CONFIRMED'));
 await run('main-enabled-after-popup',[{op:'inspect'}],[{type:'elementEnabled',selector:{automationId:'SaveV2'},expected:true}]);
 const find=id=>cases.find(c=>c.id===id);
 const assertions={ambiguousElementRejected:find('duplicate-element-without-index').status==='failed'&&find('duplicate-element-without-index').error==='desktop-element-ambiguous',
  explicitIndexWorks:find('duplicate-element-explicit-index').status==='success',saveFailureReported:find('failed-save').status==='failed',outputAbsentOnFailure:outputAbsent,
  staleSelectorRejected:find('stale-selector').status==='failed',changedSelectorWorks:find('updated-selector').status==='success',outputMatches,
  ambiguousWindowRejected:find('ambiguous-process-window').status==='failed'&&find('ambiguous-process-window').error==='desktop-window-ambiguous',
  secondWindowClosed:find('close-second').status==='success',popupOpened:find('open-popup').status==='success',popupHandled:find('popup-handoff').status==='success',mainRestored:find('main-after-popup').status==='success',disabledStateVerified:find('main-disabled-by-popup').status==='success',enabledStateVerified:find('main-enabled-after-popup').status==='success'};
 const report={observedAt:new Date().toISOString(),actualWindowsFixture:true,scriptedActions:true,realModel:false,actualFileReadback:true,assertions,cases,status:Object.values(assertions).every(Boolean)?'passed':'failed'};
 await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,assertions}));if(report.status!=='passed')process.exitCode=1;
}finally{
 if(fixture.exitCode===null){const ended=new Promise(r=>fixture.once('exit',r));fixture.kill();await ended;}
 if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('jarvis-desktop-recovery-'))throw Error('CLEANUP_REJECTED');await rm(root,{recursive:true,force:true});
}
