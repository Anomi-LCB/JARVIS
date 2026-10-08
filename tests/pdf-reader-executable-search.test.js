import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('isolated PDF extraction disables unused executable discovery before parser import and preserves parent environment',t=>{
 const root=mkdtempSync(join(tmpdir(),'jarvis-pdf-import-boundary-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const wrapper=join(root,'observe.py');
 writeFileSync(wrapper,`import os,sys,shutil,runpy,json
calls=[]
original=shutil.which
def observed(cmd,*args,**kwargs):
    if cmd=='jbig2dec':
        if os.environ.get('PATH')!='' or os.environ.get('NoDefaultCurrentDirectoryInExePath')!='1':
            raise RuntimeError('UNWANTED_EXECUTABLE_SEARCH')
        calls.append(cmd)
    return original(cmd,*args,**kwargs)
shutil.which=observed
target=sys.argv[1]
sys.argv=sys.argv[1:]
runpy.run_path(target,run_name='__main__')
print(json.dumps({'jbig2DiscoveryCalls':len(calls),'childPathEmpty':os.environ.get('PATH')==''}),file=sys.stderr)
`);
 const extractor=resolve('apps/pc-agent/src/adapters/pdf/extract-text.py');
 const legacy=join(root,'legacy.py');
 writeFileSync(legacy,readFileSync(extractor,'utf8').replace("os.environ['PATH']=''",'').replace("os.environ['NoDefaultCurrentDirectoryInExePath']='1'",''));
 const parentPath=process.env.PATH;
 const run=target=>spawnSync(process.env.JARVIS_PDF_PYTHON??'python',['-I','-B',wrapper,target,resolve('apps/pc-agent/vendor/pypdf/pypdf-6.19.0-py3-none-any.whl'),'1','10'],{encoding:'utf8',input:readFileSync('artifacts/workbook-native-pdf-20261003-mission-fenced/report.pdf'),windowsHide:true,timeout:60000,env:{...process.env,PATH:parentPath,NoDefaultCurrentDirectoryInExePath:''}});
 const before=run(legacy);assert.notEqual(before.status,0);assert.match(before.stderr,/UNWANTED_EXECUTABLE_SEARCH/);
 const after=run(extractor);assert.equal(after.status,0,after.stderr);const receipt=JSON.parse(after.stdout);assert.equal(receipt.status,'success');assert.equal(receipt.parserVersion,'6.19.0');assert.equal(receipt.ocrPerformed,false);assert.match(receipt.pages[0].text,/월 매출/);
 const boundary=JSON.parse(after.stderr.trim().split('\n').at(-1));assert.ok(boundary.jbig2DiscoveryCalls>=1);assert.equal(boundary.childPathEmpty,true);assert.equal(process.env.PATH,parentPath);
});
