import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { ActionType, TaskStatus } from '../packages/shared/src/types.js';

test('native document adapters block outputs outside approved roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-native-doc-guard-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  try {
    const runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot: join(root, 'audit'),
      env: {},
      workerDaemonEnabled: false
    });
    const fixtures = [
      { toolName: 'word.create', path: join(root, 'outside.docx') },
      { toolName: 'powerpoint.create', path: join(root, 'outside.pptx') },
      { toolName: 'hwp.create', path: join(root, 'outside.hwp') },
      { toolName: 'hwp.create', path: join(root, 'outside.hwpx') }
    ];

    for (const [index, fixture] of fixtures.entries()) {
      const result = await execute(runtime, {
        id: `native_guard_${index}`,
        actionType: ActionType.CREATE_FILE,
        toolName: fixture.toolName,
        args: { path: fixture.path, title: 'blocked', blocks: [], slides: [] }
      });
      assert.equal(result.status, TaskStatus.BLOCKED);
      assert.match(result.blockedReason, /outside-allowed-roots/);
      await assert.rejects(access(fixture.path));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Excel document edits are journaled and restore the original binary workbook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-excel-edit-rollback-'));
  const workspace = join(root, 'workspace');
  const workbookPath = join(workspace, 'editable.xlsx');
  await mkdir(workspace, { recursive: true });
  try {
    const runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot: join(root, 'audit'),
      env: {},
      workerDaemonEnabled: false
    });
    const created = await execute(runtime, {
      id: 'excel_create',
      actionType: ActionType.CREATE_FILE,
      toolName: 'excel.createWorkbook',
      args: {
        outputPath: workbookPath,
        sheetName: 'Data',
        columns: ['Name', 'Value'],
        rows: [['Before', 10]]
      }
    });
    assert.equal(created.status, TaskStatus.COMPLETED);
    assert.equal(created.executionResult.status, 'success');

    const edited = await execute(runtime, {
      id: 'excel_edit',
      actionType: ActionType.EDIT_DOCUMENT,
      toolName: 'document.edit',
      args: {
        targetPath: workbookPath,
        sheet: 'Data',
        edits: [{ cell: 'B2', value: 99 }]
      }
    });
    assert.equal(edited.status, TaskStatus.COMPLETED);
    assert.equal(edited.executionResult.status, 'success');
    assert.ok(edited.executionResult.undoJournalId);
    assert.equal(Number(await readWorkbookCell(workbookPath, 'Data', 'B2')), 99);
    assert.equal(relative(workspace, edited.executionResult.backupPath).startsWith('..'), false);

    const rolledBack = await runtime.pcAgent.rollbackTask(edited.taskId);
    assert.equal(rolledBack.success, true);
    assert.equal(Number(await readWorkbookCell(workbookPath, 'Data', 'B2')), 10);
    assert.equal(runtime.pcAgent.undoJournal.verifyChain().status, 'valid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('HWP cleanup releases only its COM object and never kills all HWP processes', async () => {
  const source = await readFile(resolve('apps/pc-agent/src/pc-agent-runtime.js'), 'utf8');
  const hwpAdapterSource = source.slice(
    source.indexOf('export class HwpCreateToolAdapter'),
    source.indexOf('function hardenWindowsVaultKeyFile')
  );
  assert.equal(source.includes('Get-Process Hwp* -ErrorAction SilentlyContinue | Stop-Process -Force'), false);
  assert.equal(source.includes('FinalReleaseComObject($hwp)'), true);
  assert.equal(source.includes('$name.IndexOf($ExpectedOutputPath, [StringComparison]::OrdinalIgnoreCase)'), true);
  assert.equal(source.includes('approvalScope = "single-path"'), true);
  assert.equal(source.includes('StartsWith("접근 허용"'), true);
  assert.equal(hwpAdapterSource.includes('execFileSync('), false);
  assert.equal(hwpAdapterSource.includes('await execFileAsync('), true);
  assert.equal(hwpAdapterSource.includes('$hwp.SaveAs("${esc(nativeSavePath)}"'), true);
  assert.equal(hwpAdapterSource.includes('$hwp.SaveAs("${esc(outPath)}"'), false);
  assert.equal(hwpAdapterSource.includes('$hwp.CreateAction("TableCreate")'), true);
  assert.equal(hwpAdapterSource.includes('$tableSet.SetItem("Rows", $rowCount)'), true);
  assert.equal(hwpAdapterSource.includes('$tableSet.SetItem("Cols", $columnCount)'), true);
  assert.equal(hwpAdapterSource.includes('$hwp.HAction.Run("TableRightCell")'), true);
  assert.equal(hwpAdapterSource.includes('$hwp.CreateAction("CellFill")'), true);
  assert.equal(hwpAdapterSource.includes('ParagraphShapeAlignCenter'), true);
  assert.equal(hwpAdapterSource.includes('CreateItemArray("ColWidth", $columnCount)'), true);
  assert.equal(hwpAdapterSource.includes('CreateItemArray("RowHeight", $rowCount)'), true);
  assert.equal(hwpAdapterSource.includes('jarvis-professional-table-v1'), true);
  assert.equal(hwpAdapterSource.includes('hwp-table-style-mismatch'), true);
  assert.equal(hwpAdapterSource.includes('hwp-table-layout-mismatch'), true);
  assert.equal(hwpAdapterSource.includes("createHash('sha256').update(readFileSync(outPath)).digest('hex')"), true);
  assert.equal(hwpAdapterSource.includes('JSON.stringify(doc)'), true);
  assert.match(hwpAdapterSource, /const errorPath = resolve\(process\.env\.TEMP \?\? '\.', `jarvis-hwp-/);
  // Existing-target preservation is exercised by hwp-publication.test.js.
  // The current publication path deliberately never backs up/overwrites it.
  assert.equal(hwpAdapterSource.includes("nativeSaveMode: 'ascii-staging'"), true);
  assert.equal(source.includes('async function runComScript'),false);
  // Both Office authoring paths use separately guarded native hosts.
  assert.equal((source.match(/await runComScript\(/g) ?? []).length, 0);
  assert.match(source,/await createVerifiedWordDocument\(/);
  assert.match(source,/await createVerifiedPresentation\(requestPath/);
});

test('file listing reports a blocked result when the requested directory is outside approved roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-list-guard-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  try {
    const runtime = createAgRuntime({
      allowedRoots: [workspace],
      auditRoot: join(root, 'audit'),
      env: {},
      workerDaemonEnabled: false
    });
    const result = await execute(runtime, {
      id: 'list_guard',
      actionType: ActionType.LIST_FILES,
      toolName: 'filesystem.listFiles',
      args: { directory: root }
    });

    assert.equal(result.status, TaskStatus.BLOCKED);
    assert.match(result.blockedReason, /outside-allowed-roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function execute(runtime, { id, actionType, toolName, args }) {
  const taskId = `task_${id}`;
  const planId = `plan_${id}`;
  const approvalId = `approval_${id}`;
  const action = { actionType, toolName, skillId: `test.${id}`, arguments: args };
  const capabilityToken = runtime.policyRuntime.capabilities.issue({
    taskId,
    planId,
    approvalId,
    action,
    allowedPaths: runtime.pcAgent.allowedRoots
  });
  assert.ok(capabilityToken.tokenId);
  return await runtime.pcAgent.receiveExecutionPacket({
    packetId: `packet_${id}`,
    taskId,
    planId,
    action,
    capabilityToken,
    requestedMode: 'execute',
    userConfirmation: { confirmed: true, approvalId },
    approvalDecision: { approvalId, decision: 'approve' }
  });
}

async function readWorkbookCell(path, sheetName, cellAddress) {
  const imported = await import('../apps/pc-agent/node_modules/exceljs/excel.js');
  const ExcelJS = imported.default ?? imported;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook.getWorksheet(sheetName).getCell(cellAddress).value;
}
