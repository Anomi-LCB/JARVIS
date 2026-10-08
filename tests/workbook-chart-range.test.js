import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ExcelWorkbookWorker} from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
const inspect=async path=>JSON.parse((await promisify(execFile)('python',['tests/fixtures/inspect-workbook-chart.py',path],{windowsHide:true})).stdout);
const data={sheetName:"성과 O'Brien",columns:['무시','월','매출','이익'],rows:[['x','1월',100,10],['y','2월',120,-5],['z','3월',90,12]]};
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'jarvis-chart-range-'));try{await run(root);}finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}}
test('selected columns and row bounds become all requested series with matching numeric caches',()=>fixture(async root=>{
 const path=join(root,'selected.xlsx');await new ExcelWorkbookWorker().writeWorkbook({...data,outputPath:path,charts:[{type:'bar',title:'선택 범위',range:'$B$1:$D$3'}]});
 const result=await inspect(path),series=result.charts[0].series;
 assert.equal(series.length,2);assert.equal(result.zipCrcValid,true);assert.equal(result.actualRenderingVerified,false);
 assert.deepEqual(series.map(s=>s.name),['매출','이익']);
 assert.deepEqual(series.map(s=>s.values),[[100,120],[10,-5]]);assert.deepEqual(series.map(s=>s.numericCache),[[100,120],[10,-5]]);
 assert.deepEqual(series[0].categories,['1월','2월']);assert.deepEqual(series[0].categoryCache,['1월','2월']);
 assert.equal(series[0].categoryFormula,"'성과 O''Brien'!$B$2:$B$3");assert.equal(series[1].valueFormula,"'성과 O''Brien'!$D$2:$D$3");
}));
test('invalid and unfulfillable chart requirements fail before any file is written',()=>fixture(async root=>{
 const path=join(root,'invalid.xlsx'),worker=new ExcelWorkbookWorker();
 const invalid=[{range:'D1:B3'},{range:'B1:E3'},{range:'B1:C99'},{range:'B1:B3'},{range:'B1:C1'},{range:'Other!B1:C3'},{range:'[remote.xlsx]Sheet1!B1:C3'},{range:'B1:C3,D1:E3'},{range:'B1:C3',unhandledAxis:'logarithmic'},{type:'pie',range:'B1:D3'}];
 for(const chart of invalid){await assert.rejects(worker.writeWorkbook({...data,outputPath:path,charts:[{type:'bar',title:'시험',...chart}]}));await assert.rejects(stat(path),{code:'ENOENT'});}
 await assert.rejects(worker.writeWorkbook({...data,outputPath:path,charts:Array.from({length:4},()=>({type:'bar',range:'B1:C3'}))}));
 await assert.rejects(worker.writeWorkbook({...data,outputPath:path,rows:[['x','1월','100',10]],charts:[{type:'bar',range:'B1:C2'}]}));
}));
test('offset header ranges are preserved and XML-invalid source characters cannot create a broken workbook',()=>fixture(async root=>{
 const path=join(root,'offset.xlsx');await new ExcelWorkbookWorker().writeWorkbook({...data,outputPath:path,charts:[{range:'B2:D4'}]});
 const result=await inspect(path);assert.deepEqual(result.charts[0].series.map(s=>s.name),['100','10']);assert.deepEqual(result.charts[0].series.map(s=>s.values),[[120,90],[-5,12]]);
 const invalidPath=join(root,'invalid-xml.xlsx');await assert.rejects(new ExcelWorkbookWorker().writeWorkbook({...data,outputPath:invalidPath,rows:[['x','bad\u0000',1,1]],charts:[{range:'B1:C2'}]}),{code:'B_WORKBOOK_XML_CHARACTER_INVALID'});await assert.rejects(stat(invalidPath),{code:'ENOENT'});
}));
test('reviewed status-count template retains the original table and references real aggregated cells',()=>fixture(async root=>{
 const path=join(root,'status.xlsx'),input={outputPath:path,sheetName:'보고서',columns:['이름','상태'],rows:[['A','완료'],['B','대기'],['C','완료']],template:{templateFile:'apps/pc-agent/templates/excel/ministry-report.json'}};
 const before=JSON.stringify(input);const output=await new ExcelWorkbookWorker().writeWorkbook(input);assert.equal(JSON.stringify(input),before);
 const result=await inspect(path),series=result.charts[0].series[0];
 assert.equal(result.worksheets['보고서'].B2,'완료');assert.equal(result.worksheets['보고서'].B3,'대기');assert.equal(result.worksheets['보고서'].B4,'완료');
 assert.deepEqual(series.categories,['완료','대기']);assert.deepEqual(series.values,[2,1]);assert.deepEqual(series.numericCache,[2,1]);
 assert.equal(result.sheetStates['_JARVIS_차트_1'],'hidden');assert.equal(output.inspection.rowCount,3);assert.equal(output.inspection.totalRowCount,5);
 assert.equal(result.actualRenderingVerified,false);
 assert.equal(output.renderSmoke.actualRenderingVerified,false);assert.equal(output.visualValidation.actualRenderingVerified,false);
}));
test('line and pie charts keep the selected rows and values, including zero',()=>fixture(async root=>{
 const path=join(root,'types.xlsx');await new ExcelWorkbookWorker().writeWorkbook({outputPath:path,sheetName:'실적',columns:['월','실적'],rows:[['1월',0],['2월',2],['3월',10]],charts:[{type:'line',range:'A1:B3'},{type:'pie',range:'A1:B4'}]});
 const result=await inspect(path);assert.deepEqual(result.charts.map(c=>c.series[0].numericCache),[[0,2],[0,2,10]]);
}));
