import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, copyFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {TaskPlanner} from '../packages/core/src/planning/task-planner.js';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';

test('document source paths preserve absolute, relative traversal and ambiguity for E/B checks',()=>{
  const root=resolve('workspace'), planner=new TaskPlanner({workspaceRoot:root});
  for(const ext of ['txt','xlsx','pdf']) {
    const source=resolve('outside',`report.${ext}`);
    assert.equal(planner.readTextPathFor(`"${source}" 내용을 읽어줘`,`report.${ext}`),source);
    assert.equal(planner.readTextPathFor(`${source} 내용을 읽어줘`,source),source);
    assert.equal(planner.readTextPathFor(`'../outside/report.${ext}' 내용을 읽어줘`,`report.${ext}`),source);
    assert.equal(planner.readTextPathFor('내용을 읽어줘',`../outside/report.${ext}`),source);
    assert.equal(planner.readTextPathFor(`'a.${ext}'와 'b.${ext}' 내용을 읽어줘`,`a.${ext}`),null);
    assert.equal(planner.readTextPathFor(`'workspace/report.${ext}' 내용을 읽어줘`,`report.${ext}`),join(root,`report.${ext}`));
  }
});

for(const ext of ['xlsx','pdf']) for(const allowed of [true,false]) {
  test(`natural ${ext} read uses the requested sibling source, permitted=${allowed}`,async t=>{
    const root=await mkdtemp(join(tmpdir(),'jarvis-document-source-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const workspace=join(root,'workspace'), outside=join(root,'outside');
    await mkdir(workspace);await mkdir(outside);
    const source=join(outside,`report.${ext}`), decoy=join(workspace,`report.${ext}`);
    if(ext==='xlsx') {
      const writer=new ExcelWorkbookWorker();
      await writer.writeWorkbook({outputPath:source,columns:['Source'],rows:[['requested']]});
      await writer.writeWorkbook({outputPath:decoy,columns:['Source'],rows:[['wrong-decoy']]});
    } else {
      const fixture=resolve('artifacts/workbook-native-pdf-20261003-mission-fenced/report.pdf');
      await copyFile(fixture,source);await copyFile(fixture,decoy);
    }
    const runtime=createAgRuntime({env:{},allowedRoots:allowed?[workspace,outside]:[workspace],auditRoot:join(root,'audit'),workerDaemonEnabled:false});
    t.after(()=>runtime.coreFacade.cognition.close());
    const task=runtime.coreFacade.createTask(`"${source}" 내용을 읽어줘`);
    assert.equal(task.plan.action.arguments.path,source,'must not substitute same-named workspace file');
    const result=await runtime.orchestrationWorker.runTask(task.taskId);
    assert.equal(result.success,allowed,JSON.stringify(result));
    if(allowed && ext==='xlsx')assert.equal(task.executionResult.executionResult.xlsxRead.cells.A2,'requested');
    console.log(JSON.stringify({documentSourcePath:{ext,allowed,sourcePreserved:true,success:result.success,syntheticSource:true,externalModelUsed:false}}));
  });
}
