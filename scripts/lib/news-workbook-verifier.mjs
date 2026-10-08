import { createWorkbookBuffer } from '../../apps/pc-agent/src/adapters/excel/xlsx-writer.js';

const COLUMNS = Object.freeze(['title', 'source', 'publishedAt', 'url', 'articleStatus']);

export function createNewsFactsWorkbookBuffer(headlines) {
  if (!Array.isArray(headlines) || headlines.length > 100) throw new TypeError('news-workbook-row-limit');
  const rows = headlines.map(fact => {
    if (!fact || COLUMNS.some(column => typeof fact[column] !== 'string')) throw new TypeError('news-workbook-fact-invalid');
    return COLUMNS.map(column => fact[column]);
  });
  return { buffer: createWorkbookBuffer({ sheetName: 'Headlines', columns: [...COLUMNS], rows }), columns: [...COLUMNS], rows };
}

export async function verifyNewsFactsWorkbook(path, expectedRows) {
  const excelModule = await import('../../apps/pc-agent/node_modules/exceljs/excel.js');
  const ExcelJS = excelModule.default ?? excelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const worksheet = workbook.getWorksheet('Headlines');
  if (!worksheet) return { status: 'failed', reason: 'worksheet-missing', rowCount: 0, columnCount: 0 };
  const columns = COLUMNS.map((_column, index) => worksheet.getRow(1).getCell(index + 1).value);
  const rows = expectedRows.map((_row, rowIndex) =>
    COLUMNS.map((_column, columnIndex) => worksheet.getRow(rowIndex + 2).getCell(columnIndex + 1).value));
  const status = JSON.stringify(columns) === JSON.stringify(COLUMNS)
    && JSON.stringify(rows) === JSON.stringify(expectedRows) ? 'passed' : 'failed';
  return { status, rowCount: rows.length, columnCount: columns.length, headers: columns, rows };
}
