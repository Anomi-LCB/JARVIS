import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createWorkbookBuffer, inspectWorkbookFile } from './xlsx-writer.js';
import {normalizeWorkbookCharts} from './chart-data.js';
import { createWorkbookTemplateMigrationReport, WorkbookTemplateCatalog } from './workbook-template-catalog.js';
import {NativeWorkbookPdfRenderer,nativeFailureRecovery} from './native-pdf-renderer.js';

export class ExcelWorkbookWorker {
  constructor({ templateCatalog = new WorkbookTemplateCatalog(), workerId = 'excel-worker-js', pdfRenderer = new NativeWorkbookPdfRenderer() } = {}) {
    this.templateCatalog = templateCatalog;
    this.workerId = workerId;
    this.pdfRenderer = pdfRenderer;
  }

  async prepare(args) {
    if(args.renderPdf!==undefined&&typeof args.renderPdf!=='boolean') throw new Error('workbook-render-pdf-boolean-required');
    if(args.renderPdf===true&& (typeof args.pdfOutputPath!=='string'||!args.pdfOutputPath.toLowerCase().endsWith('.pdf'))) throw new Error('workbook-pdf-output-required');
    if(args.renderPdf!==true&&args.pdfOutputPath!==undefined) throw new Error('workbook-pdf-output-without-request');
    if(args.renderPdf===true&&resolve(args.pdfOutputPath)===resolve(args.outputPath??args.path)) throw new Error('workbook-pdf-source-collision');
    if (args.sheets !== undefined) {
      if (!Array.isArray(args.sheets) || args.sheets.length < 1 || args.sheets.length > 20) throw new Error('workbook-sheet-count-must-be-1-to-20');
      const sheets = await Promise.all(args.sheets.map(sheet => this.prepare({...args,...sheet,sheets:undefined,outputPath:args.outputPath ?? args.path})));
      const names = sheets.map(sheet => sheet.sheetName.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error('duplicate-sheet-name');
      for (const sheet of sheets) {
        if (!sheet.sheetName || sheet.sheetName.length > 31 || /[\[\]:*?/\\]/.test(sheet.sheetName)) throw new Error('invalid-sheet-name');
        if (!sheet.columns.length || !Array.isArray(sheet.rows) || sheet.rows.length > 5000) throw new Error('invalid-sheet-data');
      }
      if (sheets.slice(1).some(sheet => sheet.charts.length)) throw new Error('charts-supported-on-first-sheet-only');
      return {...sheets[0],sheets};
    }
    const template = await this.templateCatalog.resolveTemplate(args.template ?? {
      templateId: args.templateId,
      name: args.templateName,
      defaultStyle: args.defaultStyle,
      defaultCharts: args.defaultCharts,
      visualExpectations: args.visualExpectations
    });
    const style = this.normalizeStyle(args.style ?? template.defaultStyle);
    const rawColumns = Array.isArray(args.columns) ? args.columns : [];
    const columns = rawColumns.map((column, index) => normalizeColumnName(column, index));
    const rows = normalizeWorkbookRows(args.rows ?? [], rawColumns, columns);
    const charts = this.normalizeCharts([...(template.defaultCharts ?? []), ...(args.charts ?? [])], columns, rows);
    return {
      outputPath: resolve(args.outputPath ?? args.path),
      sheetName: String(args.sheetName ?? 'Sheet1').trim(),
      columns,
      rows,
      template,
      style,
      charts
    };
  }

  async writeWorkbook(args, {signal, beforePdfPublish,assertAccess=()=>{},beforeWorkbookWrite=()=>{}}={}) {
    const prepared = await this.prepare(args);
    beforeWorkbookWrite(prepared);
    assertAccess();
    await mkdir(dirname(prepared.outputPath), { recursive: true });
    const buffer = createWorkbookBuffer(prepared);
    beforeWorkbookWrite(prepared);
    assertAccess();
    await writeFile(prepared.outputPath, buffer, {flag:'wx'});
    const inspection = await inspectWorkbookFile(prepared.outputPath);
    const openValidation = await this.validateOpen(prepared.outputPath, inspection);
    const visualValidation = this.validateVisualSnapshot({ prepared, inspection });
    const renderSmoke = this.validateRenderSmoke({ prepared, inspection, outputPath: prepared.outputPath, openValidation, visualValidation });
    const sha256=createHash('sha256').update(buffer).digest('hex');
    let renderValidation={requested:false,status:'not-requested',actualRenderingExecuted:false,visualQualityVerified:false};
    if(args.renderPdf===true) {
      try {renderValidation=await this.pdfRenderer.render({inputPath:prepared.outputPath,outputPath:resolve(args.pdfOutputPath),expectedSha256:sha256,signal,beforePublish:beforePdfPublish});}
      catch(error) {const recovery=nativeFailureRecovery(error);renderValidation={requested:true,status:'failed',actualRenderingExecuted:false,visualQualityVerified:false,reason:error.code??'EXCEL_PDF_FAILED',...(recovery?{nativeRecovery:recovery,retryable:false}:{}),nextAction:recovery?.activationGapUnverified?'저장된 엑셀 원본은 보존됩니다. Excel 실행 초기 종료 여부를 확인할 수 없어 자동 재시도를 중지했습니다. 실행 중인 Excel을 확인한 뒤 다시 요청하세요.':'저장된 엑셀 파일은 보존됩니다. Excel 설치·로그인 사용자 세션·권한을 확인하고 새 출력 경로로 다시 요청하세요.'};}
    }
    return {
      worker: {
        workerId: this.workerId,
        processIsolation: 'worker-module',
        engine: 'node-xlsx-ooxml-writer'
      },
      prepared,
      inspection,
      openValidation,
      visualValidation,
      renderSmoke,
      renderValidation,
      sha256
    };
  }

  async validateOpen(path, inspection) {
    return {
      validator: 'jarvis-ooxml-open-validator',
      status: inspection.zipMagic === 'PK' && Boolean(inspection.sheetName) ? 'passed' : 'failed',
      checkedAt: new Date().toISOString(),
      opened: inspection.zipMagic === 'PK',
      path,
      checks: {
        zipMagic: inspection.zipMagic === 'PK',
        workbookXml: Boolean(inspection.sheetName),
        worksheetRows: Number.isInteger(inspection.rowCount),
        contentTypes: inspection.hasContentTypes === true,
        relationships: inspection.hasWorkbookRelationship === true
      }
    };
  }

  validateVisualSnapshot({ prepared, inspection }) {
    const headerStyleMatched = prepared.style.headerBold === true || Boolean(prepared.style.headerFill);
    const chartDrawingMatched = prepared.charts.length === 0 || (inspection.hasDrawing && inspection.chartPartCount === prepared.charts.length);
    const autoFilterMatched = prepared.style.autoFilter === inspection.hasAutoFilter;
    const status = [
      headerStyleMatched || !prepared.template.visualExpectations.requireHeaderStyle,
      chartDrawingMatched || !prepared.template.visualExpectations.requireChartDrawing,
      autoFilterMatched || !prepared.template.visualExpectations.requireAutoFilter
    ].every(Boolean) ? 'passed' : 'failed';
    return {
      validator: 'jarvis-workbook-visual-fixture',
      verificationScope: 'ooxml-style-and-drawing-presence-only',
      actualRenderingVerified: false,
      status,
      checkedAt: new Date().toISOString(),
      fixtureId: `${prepared.template.templateId}-visual-smoke-v1`,
      expected: {
        headerStyle: prepared.template.visualExpectations.requireHeaderStyle,
        autoFilter: prepared.template.visualExpectations.requireAutoFilter,
        chartDrawing: prepared.template.visualExpectations.requireChartDrawing || prepared.charts.length > 0
      },
      observed: {
        headerStyle: headerStyleMatched,
        autoFilter: inspection.hasAutoFilter,
        chartDrawing: inspection.hasDrawing,
        chartPartCount: inspection.chartPartCount
      }
    };
  }

  validateRenderSmoke({ prepared, inspection, outputPath, openValidation, visualValidation, env = process.env }) {
    const rendererProbe = createWorkbookRendererProbe({ env });
    const structuralChecks = {
      openValidation: openValidation.status === 'passed',
      visualValidation: visualValidation.status === 'passed',
      contentTypes: inspection.hasContentTypes === true,
      workbookRelationship: inspection.hasWorkbookRelationship === true,
      chartParts: prepared.charts.length === inspection.chartPartCount
    };
    const status = Object.values(structuralChecks).every(Boolean)
      && (rendererProbe.required ? rendererProbe.status === 'external-renderer-ready' : true)
      ? 'passed'
      : 'failed';
    return {
      smokeVersion: 'b-workbook-render-smoke-v1',
      verificationScope: 'ooxml-structure-only',
      actualRenderingVerified: false,
      status,
      checkedAt: new Date().toISOString(),
      outputPath,
      mode: rendererProbe.status === 'external-renderer-ready' ? 'external-renderer-probed' : 'headless-ooxml-contract-fallback',
      rendererProbe,
      template: {
        templateId: prepared.template.templateId,
        templateVersion: prepared.template.version,
        schemaVersion: prepared.template.schemaVersion,
        migrationVersion: prepared.template.migration?.migrationVersion ?? null
      },
      structuralChecks,
      expectedRendererBehavior: {
        opensWithoutRepairPrompt: status === 'passed',
        chartDrawingVisible: prepared.charts.length === 0 || inspection.hasDrawing === true,
        filterControlsVisible: prepared.style.autoFilter === true ? inspection.hasAutoFilter === true : true
      }
    };
  }

  normalizeStyle(style = {}) {
    return {
      headerBold: Boolean(style.headerBold),
      headerFill: style.headerFill ?? null,
      autoFilter: Boolean(style.autoFilter),
      totalRowBold: Boolean(style.totalRowBold)
    };
  }

  normalizeCharts(charts, columns, rows) {
    return normalizeWorkbookCharts(charts,columns,rows);
  }
}

function normalizeColumnName(column, index) {
  if (typeof column === 'string' || typeof column === 'number') {
    const value = String(column).trim();
    if (value) return value;
  }
  if (column && typeof column === 'object' && !Array.isArray(column)) {
    for (const key of ['name', 'label', 'title', 'header', 'key']) {
      const value = column[key];
      if (!['string', 'number'].includes(typeof value)) continue;
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  throw new Error(`invalid-column-name:${index + 1}`);
}

function normalizeWorkbookRows(rows, rawColumns, columns) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (Array.isArray(row) || !row || typeof row !== 'object') return row;
    return rawColumns.map((column, index) => {
      const candidateKeys = column && typeof column === 'object' && !Array.isArray(column)
        ? [column.key, column.name, column.label, column.title, column.header, columns[index]]
        : [columns[index]];
      const key = candidateKeys.find((candidate) => (
        ['string', 'number'].includes(typeof candidate)
        && Object.hasOwn(row, String(candidate))
      ));
      return key === undefined ? '' : row[String(key)];
    });
  });
}

export function createWorkbookRendererProbe({ env = process.env, platform = process.platform } = {}) {
  const configuredLibreOffice = env.JARVIS_LIBREOFFICE_PATH ?? env.LIBREOFFICE_PATH ?? env.SOFFICE_PATH ?? null;
  const configuredExcel = env.JARVIS_EXCEL_PATH ?? null;
  const excelComEnabled = ['1', 'true', 'yes'].includes(String(env.JARVIS_EXCEL_COM_SMOKE ?? '').toLowerCase());
  const candidates = [
    {
      rendererId: 'libreoffice-headless',
      type: 'desktop-renderer',
      command: configuredLibreOffice ?? 'soffice',
      configured: Boolean(configuredLibreOffice),
      available: Boolean(configuredLibreOffice && existsSync(configuredLibreOffice)),
      mode: 'headless-open-export'
    },
    {
      rendererId: 'microsoft-excel-com',
      type: 'desktop-renderer',
      command: configuredExcel ?? 'excel.exe',
      configured: Boolean(configuredExcel) || excelComEnabled,
      available: platform === 'win32' && (excelComEnabled || Boolean(configuredExcel && existsSync(configuredExcel))),
      mode: 'windows-com-open'
    }
  ];
  const selected = candidates.find((candidate) => candidate.available) ?? null;
  const required = ['1', 'true', 'yes'].includes(String(env.JARVIS_WORKBOOK_RENDERER_REQUIRED ?? '').toLowerCase());
  return {
    probeVersion: 'b-workbook-renderer-probe-v1',
    status: selected ? 'external-renderer-ready' : required ? 'external-renderer-missing' : 'contract-fallback',
    required,
    platform,
    selectedRenderer: selected?.rendererId ?? null,
    candidates,
    fallbackPolicy: {
      allowedWhenRendererMissing: !required,
      fallbackValidator: 'jarvis-ooxml-open-validator + jarvis-workbook-visual-fixture',
      setStrictEnv: 'JARVIS_WORKBOOK_RENDERER_REQUIRED=true'
    }
  };
}

export class ExcelWorkbookWorkerPool {
  constructor({ size = 2, templateCatalog = new WorkbookTemplateCatalog(), workerPrefix = 'excel-worker-pool' } = {}) {
    this.size = Math.max(1, Number(size) || 1);
    this.workers = Array.from({ length: this.size }, (_, index) => new ExcelWorkbookWorker({
      templateCatalog,
      workerId: `${workerPrefix}-${index + 1}`
    }));
    this.nextIndex = 0;
  }

  nextWorker() {
    const worker = this.workers[this.nextIndex % this.workers.length];
    this.nextIndex += 1;
    return worker;
  }

  async runSoak({ fixtures = [], outputRoot, cycles = 2, clock = () => new Date() } = {}) {
    const cycleCount = Math.max(1, Number(cycles) || 1);
    const items = [];
    for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
      for (const fixture of fixtures) {
        const worker = this.nextWorker();
        const outputPath = resolve(outputRoot, `${fixture.fixtureId}-cycle-${cycleIndex + 1}.xlsx`);
        const startedAt = clock().toISOString();
        try {
          const result = await worker.writeWorkbook({
            ...(fixture.args ?? {}),
            outputPath
          });
          const expected = fixture.expected ?? {};
          const failures = [
            ...(result.openValidation.status === 'passed' ? [] : ['open-validation-failed']),
            ...(result.visualValidation.status === 'passed' ? [] : ['visual-validation-failed']),
            ...(result.renderSmoke.status === 'passed' ? [] : ['render-smoke-failed']),
            ...(expected.templateId && result.inspection.templateId !== expected.templateId ? [`templateId:${result.inspection.templateId}`] : []),
            ...(Number.isInteger(expected.chartCount) && result.inspection.chartCount !== expected.chartCount ? [`chartCount:${result.inspection.chartCount}`] : []),
            ...(expected.hasAutoFilter !== undefined && result.inspection.hasAutoFilter !== expected.hasAutoFilter ? [`hasAutoFilter:${result.inspection.hasAutoFilter}`] : [])
          ];
          items.push({
            itemVersion: 'b-workbook-worker-pool-soak-item-v1',
            fixtureId: fixture.fixtureId,
            cycleIndex,
            status: failures.length ? 'failed' : 'passed',
            worker: result.worker,
            startedAt,
            finishedAt: clock().toISOString(),
            outputPath,
            sha256: result.sha256,
            templateId: result.inspection.templateId,
            chartCount: result.inspection.chartCount,
            openValidation: result.openValidation,
            visualValidation: result.visualValidation,
            renderSmoke: result.renderSmoke,
            failures
          });
        } catch (error) {
          items.push({
            itemVersion: 'b-workbook-worker-pool-soak-item-v1',
            fixtureId: fixture.fixtureId,
            cycleIndex,
            status: 'failed',
            worker: { workerId: worker.workerId, processIsolation: 'worker-module' },
            startedAt,
            finishedAt: clock().toISOString(),
            outputPath,
            failures: [error.message ?? String(error)]
          });
        }
      }
    }
    const failed = items.filter((item) => item.status === 'failed');
    return {
      soakVersion: 'b-workbook-worker-pool-soak-v1',
      status: failed.length ? 'failed' : 'passed',
      generatedAt: clock().toISOString(),
      workerPool: {
        poolMode: 'in-process-worker-module-pool',
        workerCount: this.workers.length,
        processIsolation: 'worker-module',
        longRunningReady: true
      },
      cycleCount,
      fixtureCount: fixtures.length,
      itemCount: items.length,
      passedCount: items.length - failed.length,
      stableWorkers: new Set(items.map((item) => item.worker?.workerId).filter(Boolean)).size <= this.workers.length,
      items,
      failures: failed
    };
  }
}

export async function runWorkbookProductFixturePack({
  fixturePack,
  outputRoot,
  cycles = 2,
  clock = () => new Date()
} = {}) {
  const fixtures = fixturePack?.fixtures ?? [];
  const migrationReport = createWorkbookTemplateMigrationReport({
    fixtures: fixturePack?.templateMigrationFixtures ?? []
  });
  const pool = new ExcelWorkbookWorkerPool({
    size: fixturePack?.workerPool?.size ?? 2
  });
  const workerPoolSoak = await pool.runSoak({
    fixtures,
    outputRoot: outputRoot ?? join('dist', 'workbook-product-soak', 'workbooks'),
    cycles: cycles ?? fixturePack?.workerPool?.cycles ?? 2,
    clock
  });
  const failed = migrationReport.status !== 'passed' || workerPoolSoak.status !== 'passed';
  return {
    reportVersion: 'b-workbook-product-fixture-pack-report-v1',
    status: failed ? 'failed' : 'passed',
    generatedAt: clock().toISOString(),
    fixturePackVersion: fixturePack?.fixturePackVersion,
    fixturePackId: fixturePack?.fixturePackId,
    migrationReport,
    workerPoolSoak,
    rendererProbe: createWorkbookRendererProbe(),
    coverage: {
      workbookFixtures: fixtures.length,
      templateMigrationFixtures: fixturePack?.templateMigrationFixtures?.length ?? 0,
      renderSmokeVersion: 'b-workbook-render-smoke-v1',
      workerPoolSoakVersion: 'b-workbook-worker-pool-soak-v1',
      migrationReportVersion: 'b-workbook-template-migration-report-v1'
    }
  };
}

function spreadsheetColumnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || 'A';
}
