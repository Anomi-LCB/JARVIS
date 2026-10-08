import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExcelWorkbookWorker } from '../apps/pc-agent/src/adapters/excel/excel-worker.js';

test('Workbook supports distinct worksheets, numeric cells and bold totals', async () => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-workbook-sheets-'));
  const worker=new ExcelWorkbookWorker();
  const result=await worker.writeWorkbook({outputPath:join(root,'plan.xlsx'),style:{headerBold:true,totalRowBold:true},sheets:[
    {sheetName:'일정',columns:['업무','담당'],rows:[['준비','김하늘']]},
    {sheetName:'예산',columns:['항목','금액'],rows:[['인쇄',20000],['간식',30000],['합계',50000]]}
  ]});
  assert.deepEqual(result.inspection.sheetNames,['일정','예산']);
  assert.equal(result.inspection.rowCount,4);
  assert.equal(result.openValidation.status,'passed');
  const xml=(await readFile(join(root,'plan.xlsx'))).toString('utf8');
  assert.match(xml, /<c r="B2"><v>20000<\/v><\/c>/);
  assert.match(xml, /<c r="B4" s="2"><v>50000<\/v><\/c>/);
  assert.match(xml, /Target="worksheets\/sheet2.xml"/);
  assert.match(xml, /PartName="\/xl\/worksheets\/sheet2.xml"/);
});

test('Invalid secondary worksheets are rejected before writing', async () => {
  const worker=new ExcelWorkbookWorker();
  for (const sheets of [
    [{sheetName:'a',columns:['x'],rows:[]},{sheetName:'A',columns:['x'],rows:[]}],
    [{sheetName:'a',columns:['x'],rows:[]},{sheetName:'bad/name',columns:['x'],rows:[]}],
    [{sheetName:'a',columns:['x'],rows:[]},{sheetName:'b',columns:[],rows:[]}],
    []
  ]) await assert.rejects(worker.prepare({outputPath:join(tmpdir(),'not-written.xlsx'),sheets}));
});

test('Workbook converts structured column descriptors into readable headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-workbook-column-descriptors-'));
  const outputPath = join(root, 'structured-columns.xlsx');
  const worker = new ExcelWorkbookWorker();
  await worker.writeWorkbook({
    outputPath,
    sheets: [
      {
        sheetName: '사람별',
        columns: [{ name: '이름' }, { name: '총시간(h)' }, { name: '초과여부' }],
        rows: [['김하늘', 43, '초과']
        ]
      },
      {
        sheetName: '프로젝트별',
        columns: [
          { key: 'project', label: '프로젝트' },
          { key: 'hours', title: '총시간(h)' }
        ],
        rows: [{ project: 'A', hours: 38 }]
      }
    ]
  });

  const xml = (await readFile(outputPath)).toString('utf8');
  assert.doesNotMatch(xml, /\[object Object\]/u);
  assert.match(xml, /<t>이름<\/t>/u);
  assert.match(xml, /<t>총시간\(h\)<\/t>/u);
  assert.match(xml, /<t>프로젝트<\/t>/u);
  assert.match(xml, /<t>A<\/t><\/is><\/c><c r="B2"><v>38<\/v>/u);
});

test('Workbook rejects a structured column descriptor without a usable header', async () => {
  const worker = new ExcelWorkbookWorker();
  await assert.rejects(
    worker.prepare({
      outputPath: join(tmpdir(), 'invalid-column.xlsx'),
      columns: [{ width: 20 }],
      rows: [['value']]
    }),
    /invalid-column-name:1/u
  );
});
