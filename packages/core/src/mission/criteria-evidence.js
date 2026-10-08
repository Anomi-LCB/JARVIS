import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { validateWorkflowSpec } from './workflow-ir.js';
import { observedNewsSummaryRequirement } from './news-article-provenance.js';
import { verifyArtifactConsistency } from './artifact-consistency.js';
import {verifyResearchSourceTrace} from './research-source-trace.js';
import {normalizeLayoutRequirements,layoutRequirementsSha256} from '../../../shared/src/artifact-layout-requirements.js';
import { exhaustiveListingItems } from './listing-completeness.js';
import { readXlsxCells, readXlsxCharts, validXlsxCellAddress, validXlsxChartReference, xlsxReadRange } from './xlsx-cell-evidence.js';

export const CRITERION_EVIDENCE_VERSION = 'a-criterion-evidence-v1';
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel));
};
function invalid(reason) {
  throw Object.assign(new Error(`Invalid mission criterion: ${reason}`), { code: 'A_MISSION_CRITERION_INVALID' });
}
function boundedText(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(name);
  return value;
}
function exactKeys(value, keys, name) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(name);
}
function jsonValue(value, depth = 0) {
  if (depth > 20 || value === undefined || typeof value === 'bigint' || typeof value === 'function') invalid('equals');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid('equals'); return; }
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (!plain(value) || Object.keys(value).some(key => unsafeKeys.has(key))) invalid('equals');
  for (const item of Object.values(value)) jsonValue(item, depth + 1);
}

/** A client supplies declarative checks, never executable code or claimed results. */
export function normalizeCriterionExtensions(criterion, { objectiveLength = null } = {}) {
  const extensions = {};
  if (own(criterion, 'requirementId')) {
    const id = boundedText(criterion.requirementId, 160, 'requirementId');
    if (!/^[\p{L}\p{N}_.:-]+$/u.test(id)) invalid('requirementId');
    extensions.requirementId = id;
  }
  if (own(criterion, 'sourceSpan')) {
    const span = criterion.sourceSpan;
    exactKeys(span, ['start', 'end'], 'sourceSpan');
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0
      || span.end <= span.start || (objectiveLength !== null && span.end > objectiveLength)) invalid('sourceSpan');
    extensions.sourceSpan = { start: span.start, end: span.end };
  }
  if (own(criterion, 'artifactRole')) {
    if (!['input', 'output'].includes(criterion.artifactRole)) invalid('artifactRole');
    extensions.artifactRole = criterion.artifactRole;
  }
  if (own(criterion, 'verificationSpec')) extensions.verificationSpec = normalizeVerificationSpec(criterion.verificationSpec);
  return extensions;
}

export function normalizeVerificationSpec(value) {
  const keys = {
    'file.exists': ['version', 'kind', 'path'],
    'json.value': ['version', 'kind', 'path', 'pointer', 'equals'],
    'text.equals': ['version', 'kind', 'path', 'equals'],
    'csv.rows': ['version', 'kind', 'path', 'equals', 'numericColumns', 'order'],
    'xlsx.cells': ['version', 'kind', 'path', 'sheetName', 'equals'],
    'xlsx.charts': ['version', 'kind', 'path', 'sheetName', 'equals'],
    'pdf.text': ['version', 'kind', 'path', 'firstPage', 'totalPages', 'equals'],
    'xlsx.pdfRowText': ['version','kind','sourcePath','pdfPath','sheetName','equals','rows'],
    'artifact.consistency': ['version', 'kind', 'sourcePath', 'reportPath', 'tablePath', 'cardPath'],
    'research.sourceTrace': ['version','kind','path','reportPath','minimumSources'],
    'image.cardLayout':['version','kind','path','equals','width','height'],
    'presentation.contentLayout':['version','kind','path','equals'],
    'document.tables':['version','kind','path','equals'],
    'document.paragraphs':['version','kind','path','equals']
  };
  if (!plain(value) || !keys[value.kind]) invalid('verificationSpec.kind');
  exactKeys(value, keys[value.kind], 'verificationSpec.fields');
  if (value.version !== 1) invalid('verificationSpec.version');
  if(['image.cardLayout','presentation.contentLayout','document.tables','document.paragraphs'].includes(value.kind)){
    let equals;try{equals=normalizeLayoutRequirements(value.kind,value.equals);}catch{invalid('verificationSpec.layout.equals');}
    if(Buffer.byteLength(JSON.stringify(equals),'utf8')>65536)invalid('verificationSpec.layout.size');
    const layout={version:1,kind:value.kind,path:boundedText(value.path,4096,'verificationSpec.path'),equals};
    if(value.kind==='image.cardLayout'){
      if(!Number.isInteger(value.width)||value.width<640||value.width>2400||!Number.isInteger(value.height)||value.height<360||value.height>1600)invalid('verificationSpec.layout.dimensions');
      layout.width=value.width;layout.height=value.height;
    }
    return layout;
  }
  if(value.kind==='research.sourceTrace'){
    if(!Number.isSafeInteger(value.minimumSources)||value.minimumSources<1||value.minimumSources>20)invalid('verificationSpec.minimumSources');
    return {version:1,kind:value.kind,path:boundedText(value.path,4096,'verificationSpec.path'),
      reportPath:boundedText(value.reportPath,4096,'verificationSpec.reportPath'),minimumSources:value.minimumSources};
  }
  if(value.kind==='xlsx.pdfRowText'){
    const cells=normalizeVerificationSpec({version:1,kind:'xlsx.cells',path:value.sourcePath,sheetName:value.sheetName,equals:value.equals});
    if(!Array.isArray(value.rows)||!value.rows.length||value.rows.length>100)invalid('verificationSpec.pdf.rows');
    const used=[],locations=[];let previousSourceRow=0,previousPage=0,previousLine=0;
    for(const row of value.rows){
      exactKeys(row,['cells','pageNumber','lineNumber'],'verificationSpec.pdf.row');
      if(!Array.isArray(row.cells)||!row.cells.length||row.cells.length>20||row.cells.some(address=>!own(cells.equals,address))
        ||!Number.isSafeInteger(row.pageNumber)||row.pageNumber<1||row.pageNumber>500
        ||!Number.isSafeInteger(row.lineNumber)||row.lineNumber<1||row.lineNumber>10000)invalid('verificationSpec.pdf.row');
      used.push(...row.cells);locations.push(`${row.pageNumber}:${row.lineNumber}`);
      const coordinates=row.cells.map(address=>{const match=/^([A-Z]+)([0-9]+)$/u.exec(address);
        return {row:Number(match[2]),column:[...match[1]].reduce((value,c)=>value*26+c.charCodeAt(0)-64,0)};});
      if(coordinates.some((cell,index)=>cell.row!==coordinates[0].row||index>0&&cell.column!==coordinates[index-1].column+1)
        ||coordinates[0].row<=previousSourceRow||row.pageNumber<previousPage||row.pageNumber===previousPage&&row.lineNumber<=previousLine)invalid('verificationSpec.pdf.row.order');
      previousSourceRow=coordinates[0].row;previousPage=row.pageNumber;previousLine=row.lineNumber;
    }
    if(new Set(used).size!==used.length||used.length!==Object.keys(cells.equals).length||new Set(locations).size!==locations.length
      ||Object.values(cells.equals).some(value=>!['string','number'].includes(typeof value)||typeof value==='string'&&/[\r\n\u0000]/u.test(value)))invalid('verificationSpec.pdf.row.mapping');
    return {version:1,kind:value.kind,sourcePath:cells.path,pdfPath:boundedText(value.pdfPath,4096,'verificationSpec.pdfPath'),
      sheetName:cells.sheetName,equals:cells.equals,rows:structuredClone(value.rows)};
  }
  if (value.kind === 'artifact.consistency') {
    return { version: 1, kind: value.kind,
      sourcePath: boundedText(value.sourcePath, 4096, 'verificationSpec.sourcePath'),
      reportPath: boundedText(value.reportPath, 4096, 'verificationSpec.reportPath'),
      tablePath: boundedText(value.tablePath, 4096, 'verificationSpec.tablePath'),
      cardPath: boundedText(value.cardPath, 4096, 'verificationSpec.cardPath') };
  }
  const result = { version: 1, kind: value.kind, path: boundedText(value.path, 4096, 'verificationSpec.path') };
  if (value.kind === 'file.exists') return result;
  if (!own(value, 'equals')) invalid('verificationSpec.equals');
  jsonValue(value.equals);
  if (Buffer.byteLength(JSON.stringify(value.equals), 'utf8') > 65536) invalid('verificationSpec.equals.size');
  result.equals = structuredClone(value.equals);
  if(value.kind==='pdf.text') {
    if(!Number.isSafeInteger(value.firstPage)||value.firstPage<1||!Number.isSafeInteger(value.totalPages)
      ||value.totalPages<value.firstPage||value.totalPages>500||!Array.isArray(value.equals)
      ||value.equals.length<1||value.equals.length>20||value.firstPage+value.equals.length-1>value.totalPages)invalid('verificationSpec.pdf.pages');
    for(const [index,page] of value.equals.entries()){
      exactKeys(page,['pageNumber','text'],'verificationSpec.pdf.page');
      if(page.pageNumber!==value.firstPage+index||typeof page.text!=='string'||!page.text.trim()||page.text.length>100000)invalid('verificationSpec.pdf.page');
    }
    result.firstPage=value.firstPage;result.totalPages=value.totalPages;
  } else if (value.kind === 'xlsx.charts') {
    result.sheetName = boundedText(value.sheetName, 31, 'verificationSpec.sheetName');
    if (!Array.isArray(value.equals) || value.equals.length > 3) invalid('verificationSpec.charts');
    for (const chart of value.equals) {
      exactKeys(chart, ['type', 'title', 'series'], 'verificationSpec.chart.fields');
      if (!['bar', 'line', 'pie'].includes(chart.type) || typeof chart.title !== 'string' || chart.title.length > 1000
        || !Array.isArray(chart.series) || !chart.series.length || chart.series.length > 100 || chart.type === 'pie' && chart.series.length !== 1) invalid('verificationSpec.chart');
      for (const series of chart.series) {
        exactKeys(series, ['name', 'categoryFormula', 'valueFormula', 'categories', 'values'], 'verificationSpec.chart.series.fields');
        if (typeof series.name !== 'string' || series.name.length > 1000 || !Array.isArray(series.categories)
          || !series.categories.length || series.categories.length > 1000 || series.categories.some(v => typeof v !== 'string')
          || !Array.isArray(series.values) || series.values.length !== series.categories.length
          || series.values.some(v => typeof v !== 'number' || !Number.isFinite(v) || chart.type === 'pie' && v < 0)) invalid('verificationSpec.chart.series');
        boundedText(series.categoryFormula, 4096, 'verificationSpec.chart.categoryFormula');
        boundedText(series.valueFormula, 4096, 'verificationSpec.chart.valueFormula');
        if (!validXlsxChartReference(series.categoryFormula) || !validXlsxChartReference(series.valueFormula)) invalid('verificationSpec.chart.reference');
      }
    }
  } else if (value.kind === 'xlsx.cells') {
    result.sheetName = boundedText(value.sheetName, 31, 'verificationSpec.sheetName');
    if (!plain(value.equals) || !Object.keys(value.equals).length || Object.keys(value.equals).length > 1000
      || Object.entries(value.equals).some(([address, cell]) => !validXlsxCellAddress(address)
        || (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)))) invalid('verificationSpec.cells');
  } else if (value.kind === 'text.equals') {
    if (typeof value.equals !== 'string') invalid('verificationSpec.text');
  } else if (value.kind === 'json.value') {
    const pointer = value.pointer ?? '';
    if (typeof pointer !== 'string' || pointer.length > 1024 || (pointer !== '' && !pointer.startsWith('/'))
      || /~(?![01])/u.test(pointer) || pointer.split('/').some(token => unsafeKeys.has(token.replace(/~1/g, '/').replace(/~0/g, '~')))) invalid('verificationSpec.pointer');
    result.pointer = pointer;
  } else {
    if (!Array.isArray(value.equals) || value.equals.length > 1000
      || value.equals.some(row => !plain(row) || Object.values(row).some(cell => !['string', 'number'].includes(typeof cell)))) invalid('verificationSpec.rows');
    const numericColumns = value.numericColumns ?? [];
    if (!Array.isArray(numericColumns) || numericColumns.length > 100
      || numericColumns.some(key => typeof key !== 'string' || !key || key.length > 200 || unsafeKeys.has(key))
      || new Set(numericColumns).size !== numericColumns.length) invalid('verificationSpec.numericColumns');
    result.numericColumns = [...numericColumns];
    result.order = value.order ?? 'ordered';
    if (!['ordered', 'unordered'].includes(result.order)) invalid('verificationSpec.order');
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseCsv(text, numericColumns) {
  const records = [];
  let record = [], field = '', quoted = false, closed = false;
  const endField = () => { record.push(field); field = ''; closed = false; };
  const endRecord = () => { endField(); records.push(record); record = []; };
  text = text.replace(/^\uFEFF/u, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',' ) endField();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; endRecord(); }
    else if (closed) throw new Error('csv-trailing-quoted-content');
    else if (char === '"') { if (field) throw new Error('csv-unexpected-quote'); quoted = true; }
    else field += char;
  }
  if (quoted) throw new Error('csv-unclosed-quote');
  if (field || record.length || closed) endRecord();
  const headers = records.shift();
  if (!headers?.length || headers.some(key => !key || unsafeKeys.has(key)) || new Set(headers).size !== headers.length) throw new Error('csv-invalid-header');
  if (numericColumns.some(key => !headers.includes(key))) throw new Error('csv-numeric-column-missing');
  return records.map(cells => {
    if (cells.length !== headers.length) throw new Error('csv-column-count');
    return Object.fromEntries(headers.map((key, index) => {
      const value = cells[index];
      if (!numericColumns.includes(key)) return [key, value];
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || !Number.isFinite(Number(value))) throw new Error('csv-invalid-number');
      return [key, Number(value)];
    }));
  });
}

function result(status, checkId, reasons = [], details = {}) {
  return { status, passed: status === 'passed', reasons,
    checks: [{ checkId, passed: status === 'passed', ...details }] };
}

/** Compare bytes only after the caller independently verifies file identity and freshness. */
export function compareTypedCriterionContent({ spec: inputSpec, bytes }) {
  let spec;
  try { spec = normalizeVerificationSpec(inputSpec); }
  catch { return result('unverified', 'typed_criterion_invalid', ['criterion-spec-invalid']); }
  if (spec.kind === 'artifact.consistency') return result('unverified', 'typed_criterion_invalid', ['criterion-content-comparator-unsupported']);
  if(spec.kind==='research.sourceTrace')return result('unverified','typed_research_source_trace',['criterion-current-source-observations-required']);
  if(spec.kind==='pdf.text')return result('unverified','typed_pdf_text',['criterion-current-g-pdf-observation-required']);
  if(spec.kind==='xlsx.pdfRowText')return result('unverified','typed_xlsx_pdf_row_text',['criterion-current-multiple-artifact-observations-required']);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_CONTENT_BYTES) return result('unverified', 'typed_artifact_size', ['criterion-verification-size-limit']);
  try {
    if (spec.kind === 'file.exists') return result('passed', 'typed_file_exists', [], { contentSha256: hash(bytes), size: bytes.length });
    let actual;
    if (spec.kind === 'text.equals') {
      actual = bytes.toString('utf8');
    } else if (spec.kind === 'json.value') {
      actual = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
      for (const token of spec.pointer === '' ? [] : spec.pointer.slice(1).split('/')) {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        if (actual === null || typeof actual !== 'object' || !own(actual, key)) return result('failed', 'typed_json_value', ['criterion-json-pointer-missing']);
        actual = actual[key];
      }
    } else if (spec.kind === 'xlsx.cells') {
      actual = readXlsxCells(bytes, spec.sheetName, Object.keys(spec.equals));
    } else if (spec.kind === 'xlsx.charts') {
      actual = readXlsxCharts(bytes, spec.sheetName);
    } else {
      actual = parseCsv(bytes.toString('utf8'), spec.numericColumns);
    }
    const comparison = value => spec.kind === 'csv.rows' && spec.order === 'unordered'
      ? JSON.stringify(value.map(canonical).sort()) : canonical(value);
    const actualCanonical = comparison(actual), expectedCanonical = comparison(spec.equals);
    const matched = actualCanonical === expectedCanonical;
    return result(matched ? 'passed' : 'failed', { 'json.value': 'typed_json_value', 'csv.rows': 'typed_csv_rows', 'text.equals': 'typed_text_equals', 'xlsx.cells': 'typed_xlsx_cells', 'xlsx.charts': 'typed_xlsx_charts' }[spec.kind],
      matched ? [] : ['criterion-value-mismatch'], { actualSha256: hash(actualCanonical), expectedSha256: hash(expectedCanonical),
        ...(spec.kind === 'xlsx.cells' ? { checkedCellCount: Object.keys(spec.equals).length, formulaRecalculationVerified: false, actualRenderingVerified: false } : {}),
        ...(spec.kind === 'xlsx.charts' ? { checkedChartCount: actual.length, chartCachesMatchReferencedCells: true, formulaRecalculationVerified: false, actualRenderingVerified: false } : {}) });
  } catch (error) {
    if (error.code === 'XLSX_FORMULA_UNVERIFIED') return result('unverified', 'typed_xlsx_formula', ['criterion-xlsx-formula-recalculation-unverified']);
    if (error.code === 'XLSX_CHART_CACHE_MISMATCH') return result('failed', 'typed_xlsx_chart_cache', ['criterion-xlsx-chart-cache-mismatch']);
    return result('failed', 'typed_artifact_read', ['criterion-content-unreadable']);
  }
}

/** Read only a G-bound artifact in an allowed physical root; do not trust planner prose. */
export function verifyTypedCriterion({ criterion, observations = [], evidenceActionIds = [], allowedRoots = [],actions=[],beforeAccess }) {
  let spec;
  try { spec = normalizeVerificationSpec(criterion.verificationSpec); }
  catch { return result('unverified', 'typed_criterion_invalid', ['criterion-spec-invalid']); }
  const roots = allowedRoots.map(root => resolve(root));
  if(['image.cardLayout','presentation.contentLayout','document.tables','document.paragraphs'].includes(spec.kind)){
    const target=resolve(roots[0]??'.',spec.path),expectedHash=layoutRequirementsSha256(spec.kind,spec.equals);
    const observed=observations.filter(item=>evidenceActionIds.includes(item.actionId)&&item.outcome==='success'&&item.verification?.status==='passed');
    const binding=observed.flatMap(observation=>(observation.data?.artifactLayoutProofs??[]).map(proof=>({observation,proof}))).find(({proof})=>proof.kind===spec.kind&&proof.pathHash===hash(target)&&proof.requirementsSha256===expectedHash);
    const proof=binding?.proof;
    if(!proof||!Array.isArray(proof.files)||!proof.files.length||proof.files.length>64
      ||spec.kind==='image.cardLayout'&&(proof.files.length!==1||proof.width!==spec.width||proof.height!==spec.height)
      ||['document.tables','document.paragraphs'].includes(spec.kind)&&proof.files.length!==1
      ||spec.kind==='presentation.contentLayout'&&proof.files.length!==spec.equals.length+2)return result('unverified','typed_artifact_content_layout',['criterion-current-layout-g-proof-required']);
    const paths={};
    for(const [index,file] of proof.files.entries()){
      if(!Number.isInteger(file.rootIndex)||!roots[file.rootIndex]||typeof file.relativePath!=='string'||file.outsideAllowedRoots
        ||!/^([a-f0-9]{64})$/u.test(file.contentSha256??''))return result('unverified','typed_artifact_content_layout',['criterion-layout-file-binding-invalid']);
      const path=resolve(roots[file.rootIndex],file.relativePath);
      if(hash(path)!==file.pathHash)return result('failed','typed_artifact_content_layout',['criterion-layout-file-path-mismatch']);
      if(!binding.observation.artifacts?.some(artifact=>artifact.pathHash===file.pathHash&&artifact.contentSha256===file.contentSha256))return result('unverified','typed_artifact_content_layout',['criterion-layout-proof-digest-unbound']);
      paths[`layout${index}`]=path;
    }
    if(!Object.values(paths).includes(target))return result('unverified','typed_artifact_content_layout',['criterion-layout-primary-binding-required']);
    return verifyArtifactConsistencyCriterion({spec,observations:[binding.observation],evidenceActionIds,roots,filePaths:paths,beforeAccess,compare:()=>
      result('passed','typed_artifact_content_layout',[],{kind:spec.kind,requirementsSha256:expectedHash,currentFileCount:proof.files.length,semanticMeaning:'not-evaluated',
        verificationScope:spec.kind==='image.cardLayout'?'literal-glyph-pixels-and-layout':spec.kind==='document.tables'?'saved-ooxml-cell-coordinates':spec.kind==='document.paragraphs'?'saved-ooxml-ordered-body-paragraphs':'saved-ooxml-native-bounds-and-raster-ink'})});
  }
  if(spec.kind==='research.sourceTrace')return verifyArtifactConsistencyCriterion({spec,observations,evidenceActionIds,roots,
    filePaths:{trace:spec.path,report:spec.reportPath},beforeAccess,compare:({files})=>{
      try{const checked=verifyResearchSourceTrace({trace:JSON.parse(files.trace.toString('utf8')),report:files.report.toString('utf8'),
        observations:observations.filter(item=>evidenceActionIds.includes(item.actionId)),actions,minimumSources:spec.minimumSources});
        return result(checked.status,'typed_research_source_trace',checked.reasons,{sourceCount:checked.sourceCount??0,
          citationCount:checked.citationCount??0,semanticEntailment:'not-evaluated',verificationScope:checked.verificationScope??null});
      }catch{return result('failed','typed_research_source_trace',['research-trace-unreadable']);}
    }});
  if(spec.kind==='xlsx.pdfRowText'){
    if(resolve(roots[0]??'.',spec.sourcePath)===resolve(roots[0]??'.',spec.pdfPath))return result('failed','typed_xlsx_pdf_row_text',['criterion-artifact-paths-must-be-distinct']);
    const sourceCriterion={...(criterion.artifactRole==='input'?{artifactRole:'input'}:{}),verificationSpec:{version:1,kind:'xlsx.cells',path:spec.sourcePath,sheetName:spec.sheetName,equals:spec.equals}};
    if(criterion.artifactRole==='input'){
      const sourcePath=resolve(roots[0]??'.',spec.sourcePath);
      const observedSource=observations.find(observation=>{
        const read=observation.data?.xlsxRead,proof=observation.data?.xlsxReadProof,binding=observation.data?.fileEvidence;
        try{const selected=new Set(xlsxReadRange(read?.range).addresses);
          return evidenceActionIds.includes(observation.actionId)&&observation.outcome==='success'
          &&observation.verification?.status==='passed'&&observation.toolName==='excel.readWorkbook'
          &&read?.path===sourcePath&&read.sheetName===spec.sheetName&&read.readOnly===true
          &&read.verificationScope==='literal-region-values'&&proof?.passed===true
          &&proof.sourceSha256===read.sourceSha256&&proof.sourceSha256===binding?.contentSha256
          &&proof.sheetName===read.sheetName&&proof.range===read.range
          &&typeof read.cellsJson==='string'&&proof.cellsSha256===hash(read.cellsJson)
          &&Object.keys(spec.equals).every(address=>selected.has(address));}catch{return false;}
      });
      if(!observedSource)return result('unverified','typed_xlsx_pdf_row_text',['criterion-current-g-xlsx-input-observation-required']);
    }
    const source=verifyTypedCriterion({criterion:sourceCriterion,observations,evidenceActionIds,allowedRoots,actions,beforeAccess});
    if(!source.passed)return source;
    const target=resolve(roots[0]??'.',spec.pdfPath);
    const observed=observations.find(observation=>evidenceActionIds.includes(observation.actionId)&&observation.outcome==='success'
      &&observation.verification?.status==='passed'&&observation.toolName==='document.readPdf'&&observation.data?.pdfRead?.path===target);
    const read=observed?.data?.pdfRead;
    if(!read)return result('unverified','typed_xlsx_pdf_row_text',['criterion-current-g-pdf-observation-required']);
    // Delegate freshness and G-receipt validation, never accept the PDF preview alone.
    const pdf=verifyTypedCriterion({criterion:{artifactRole:'input',verificationSpec:{version:1,kind:'pdf.text',path:spec.pdfPath,firstPage:read.firstPage,totalPages:read.totalPages,equals:read.pages}},observations,evidenceActionIds,allowedRoots,actions,beforeAccess});
    if(!pdf.passed)return pdf;
    const matched=spec.rows.every(row=>{
      const page=read.pages.find(page=>page.pageNumber===row.pageNumber);
      return page?.text.split('\n')[row.lineNumber-1]===row.cells.map(address=>String(spec.equals[address])).join(' ');
    });
    const currentSource=verifyTypedCriterion({criterion:sourceCriterion,observations,evidenceActionIds,allowedRoots,actions,beforeAccess});
    if(!currentSource.passed)return currentSource;
    return result(matched?'passed':'failed','typed_xlsx_pdf_row_text',matched?[]:['criterion-xlsx-pdf-row-text-mismatch'],{
      checkedRowCount:spec.rows.length,checkedCellCount:Object.keys(spec.equals).length,verificationScope:'exact-mapped-row-text',
      columnGeometryVerified:false,wholeDocumentEquivalenceVerified:false,visualQualityVerified:false,ocrVerified:false});
  }
  if (spec.kind === 'artifact.consistency') return verifyArtifactConsistencyCriterion({ spec, observations, evidenceActionIds, roots,beforeAccess });
  const target = resolve(roots[0] ?? '.', spec.path);
  const rootIndex = roots.findIndex(root => inside(root, target));
  if (rootIndex < 0) return result('failed', 'typed_artifact_scope', ['criterion-path-outside-allowed-roots']);
  const candidates = observations.filter(observation => evidenceActionIds.includes(observation.actionId)
    && observation.outcome === 'success' && observation.verification?.status === 'passed');
  const bindings = candidates.flatMap(observation => criterion.artifactRole === 'input'
    ? [observation.data?.fileEvidence].filter(Boolean) : observation.artifacts ?? []);
  const artifact = bindings.find(item => item && item.outsideAllowedRoots !== true
    && item.rootIndex === rootIndex && typeof item.relativePath === 'string'
    && resolve(roots[rootIndex], item.relativePath) === target && item.pathHash === hash(target));
  if (!artifact) return result('unverified', 'typed_artifact_binding', ['criterion-g-artifact-evidence-missing']);
  if (!/^[a-f0-9]{64}$/iu.test(artifact.contentSha256 ?? '')) return result('unverified', 'typed_artifact_digest', ['criterion-content-digest-missing']);
  const permission = () => {
    try { beforeAccess?.({path:target,kind:'read',purpose:'typed-criterion-current-file'}); return null; }
    catch { return result('unverified','typed_artifact_scope',['criterion-result-read-permission-unavailable']); }
  };
  const denied = permission();
  if (denied) return denied;
  let fd;
  try {
    const physicalRoot = realpathSync(roots[rootIndex]);
    const physicalTarget = realpathSync(target);
    if (!inside(physicalRoot, physicalTarget)) return result('failed', 'typed_artifact_scope', ['criterion-physical-path-outside-root']);
    fd = openSync(physicalTarget, 'r');
    const before = fstatSync(fd);
    if (!before.isFile()) return result('failed', 'typed_artifact_regular_file', ['criterion-not-file']);
    if (before.size > MAX_CONTENT_BYTES) return result('unverified', 'typed_artifact_size', ['criterion-verification-size-limit']);
    // Bound the read even if a concurrently modified file grows after fstat.
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) break;
      count += read;
    }
    const bytes = buffer.subarray(0, count);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || realpathSync(target) !== physicalTarget || hash(bytes) !== artifact.contentSha256.toLowerCase()) {
      return result('failed', 'typed_artifact_integrity', ['criterion-artifact-changed']);
    }
    // Recheck current authority before returning file-derived values. A passed
    // historical G receipt cannot restore a revoked Mission data grant.
    const revoked = permission();
    if (revoked) return revoked;
    if(spec.kind==='pdf.text') {
      const observed=candidates.find(observation=>{
        const read=observation.data?.pdfRead,proof=observation.data?.pdfReadProof;
        return observation.toolName==='document.readPdf'&&proof?.passed===true
          &&proof.sourceSha256===artifact.contentSha256&&read?.sourceSha256===artifact.contentSha256
          &&read?.path===target&&read.verificationScope==='text-layer-only'&&read.ocrPerformed===false
          &&proof.firstPage===read.firstPage&&proof.totalPages===read.totalPages&&proof.truncated===read.truncated
          &&proof.pagesSha256===hash(JSON.stringify(read.pages));
      });
      if(!observed)return result('unverified','typed_pdf_text',['criterion-current-g-pdf-observation-required']);
      const read=observed.data.pdfRead;
      const matched=read.firstPage===spec.firstPage&&read.totalPages===spec.totalPages&&canonical(read.pages)===canonical(spec.equals);
      return result(matched?'passed':'failed','typed_pdf_text',matched?[]:['criterion-pdf-text-mismatch'],{
        sourceSha256:hash(bytes),checkedPageCount:spec.equals.length,firstPage:spec.firstPage,totalPages:spec.totalPages,
        wholeTextLayerChecked:spec.firstPage===1&&spec.equals.length===spec.totalPages,
        verificationScope:'exact-text-layer-pages',ocrVerified:false,semanticEquivalenceVerified:false,visualQualityVerified:false});
    }
    return compareTypedCriterionContent({ spec, bytes });
  } catch (error) {
    return result('failed', 'typed_artifact_read', [error.code === 'ENOENT' ? 'criterion-file-missing' : 'criterion-content-unreadable']);
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function verifyArtifactConsistencyCriterion({ spec, observations, evidenceActionIds, roots,filePaths=null,compare=compareArtifactConsistencyContent,beforeAccess }) {
  const paths = filePaths??{ source: spec.sourcePath, report: spec.reportPath, table: spec.tablePath, card: spec.cardPath };
  const targets = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, resolve(roots[0] ?? '.', path)]));
  if (new Set(Object.values(targets).map(path => process.platform === 'win32' ? path.toLowerCase() : path)).size !== Object.keys(paths).length) {
    return result('failed', 'typed_artifact_consistency_paths', ['criterion-artifact-paths-must-be-distinct']);
  }
  const boundFiles = {};
  for (const [key, target] of Object.entries(targets)) {
    const rootIndex = roots.findIndex(root => inside(root, target));
    if (rootIndex < 0) return result('failed', 'typed_artifact_consistency_scope', ['criterion-path-outside-allowed-roots']);
    try{beforeAccess?.({path:target,kind:'read',purpose:'artifact-content-layout-current-file'});}catch{return result('unverified','typed_artifact_consistency_scope',['criterion-result-read-permission-unavailable']);}
    const candidates = observations.filter(observation => evidenceActionIds.includes(observation.actionId)
      && observation.outcome === 'success' && observation.verification?.status === 'passed');
    const bindings = candidates.flatMap(observation => observation.artifacts ?? []);
    const artifact = bindings.find(item => item && item.outsideAllowedRoots !== true && item.rootIndex === rootIndex
      && typeof item.relativePath === 'string' && resolve(roots[rootIndex], item.relativePath) === target
      && item.pathHash === hash(target));
    if (!artifact) return result('unverified', 'typed_artifact_consistency_binding', [`criterion-${key}-g-artifact-evidence-missing`]);
    if (!/^[a-f0-9]{64}$/iu.test(artifact.contentSha256 ?? '')) {
      return result('unverified', 'typed_artifact_consistency_digest', [`criterion-${key}-content-digest-missing`]);
    }
    let fd;
    try {
      const physicalRoot = realpathSync(roots[rootIndex]);
      const physicalTarget = realpathSync(target);
      if (!inside(physicalRoot, physicalTarget)) return result('failed', 'typed_artifact_consistency_scope', ['criterion-physical-path-outside-root']);
      fd = openSync(physicalTarget, 'r');
      const before = fstatSync(fd);
      if (!before.isFile()) return result('failed', 'typed_artifact_consistency_regular_file', [`criterion-${key}-not-file`]);
      if (before.size > MAX_CONTENT_BYTES) return result('unverified', 'typed_artifact_consistency_size', ['criterion-verification-size-limit']);
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = readSync(fd, buffer, count, buffer.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const bytes = buffer.subarray(0, count);
      const after = fstatSync(fd);
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || realpathSync(target) !== physicalTarget || hash(bytes) !== artifact.contentSha256.toLowerCase()) {
        return result('failed', 'typed_artifact_consistency_integrity', [`criterion-${key}-artifact-changed`]);
      }
      boundFiles[key] = bytes;
    } catch (error) {
      return result('failed', 'typed_artifact_consistency_read', [error.code === 'ENOENT' ? `criterion-${key}-file-missing` : `criterion-${key}-content-unreadable`]);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  // Earlier files may lose their grant while later files are collected.
  // Check the full data scope again before deriving or returning a result.
  for (const target of Object.values(targets)) {
    try { beforeAccess?.({path:target,kind:'read',purpose:'artifact-content-layout-current-file'}); }
    catch { return result('unverified','typed_artifact_consistency_scope',['criterion-result-read-permission-unavailable']); }
  }
  return compare({ files: boundFiles });
}

/** Content oracle only; each input must first have current independently bound file evidence. */
export function compareArtifactConsistencyContent({ files } = {}) {
  const boundFiles = {};
  for (const key of ['source', 'report', 'table', 'card']) {
    const bytes = files?.[key];
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_CONTENT_BYTES) return result('unverified', 'typed_artifact_consistency_size', ['criterion-verification-size-limit']);
    try { boundFiles[key] = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')); }
    catch { return result('failed', 'typed_artifact_consistency_read', [`criterion-${key}-content-unreadable`]); }
  }
  const checked = verifyArtifactConsistency({ source: boundFiles.source,
    artifacts: ['report', 'table', 'card'].map(kind => ({ ...boundFiles[kind], kind })) });
  return result(checked.status, 'typed_artifact_consistency', checked.status === 'passed' ? [] : ['criterion-artifact-facts-or-provenance-mismatch'],
    { sourceId: checked.source?.sourceId ?? null, revision: checked.source?.revision ?? null,
      artifactCount: checked.source?.artifactCount ?? 0, checks: checked.checks.map(item => ({ checkId: item.id, passed: item.status === 'passed' })) });
}

export function criterionVerificationSummary(criteria, fallback = 'pending') {
  const status = criteria.length === 0 ? fallback : criteria.every(item => item.status === 'passed') ? 'passed'
    : criteria.some(item => item.status === 'failed') ? 'failed' : 'unverified';
  return { version: CRITERION_EVIDENCE_VERSION, status, verifiedCount: criteria.filter(item => item.status === 'passed').length,
    totalCount: criteria.length, criteria: criteria.map(item => ({ criterionId: item.criterionId,
      ...(item.requirementId ? { requirementId: item.requirementId } : {}), statement: item.statement,
      status: item.status, evidenceActionIds: item.evidenceActionIds ?? [], reasons: item.reasons ?? [],
      checks: (item.checks ?? []).map(check => ({ checkId: check.checkId, passed: check.passed === true })) })) };
}

/** Legacy prose is supported only when a complete narrow grammar has an evidence checker.
 * Extra predicates remain unverified even when one file/source/document subcheck passes.
 * Typed specs are the explicit measurement contract for richer content requirements.
 */
export function legacyCriterionNeedsContentProof(statement, checks, context = {}) {
  const text = String(statement).trim().replace(/[.!\s]+$/u, '');
  const has = checkId => checks.some(check => check.checkId === checkId);
  if (has('verified_file_listing_present')) return false;
  // Provider acceptance proves only handoff, not inbox delivery or human reading.
  if (has('external_commit_evidence_present') && /^이메일 공급자가 발송을 수락했다$/u.test(text)) return false;
  if (has('verified_file_creation_present')) return !appendLegacyPathCheck(checks, verifyLegacyFilePathEvidence({ statement, ...context, unnamedCreation: true }));
  if (has('verified_file_reads_present')) return !appendLegacyPathCheck(checks, verifyLegacyFilePathEvidence({ statement, ...context, role: 'read' }));
  if (has('g_verification_passed') && /^(?:검색\s*행동이\s*)?G\s*(?:실행\s*)?검증(?:을|이)?\s*(?:통과(?:한다|했다|됨|함)?|완료(?:된다|됨)?)$/iu.test(text)) return false;
  if (has('live_data_provenance_present')
    && (/^(?:(?:공식\s*)?출처\s*확인|MDN\s*공식\s*출처\s*URL\s*(?:두|2)\s*개)$/u.test(text)
      || /^(?:오늘\s*)?(?:최신\s*)?뉴스(?:의\s*)?(?:출처\s*(?:와|및)\s*)?(?:조회\s*(?:시점|시간)|수집\s*시각)(?:이|가)?\s*확인(?:된다|되었다|됨|한다)$/u.test(text))) return false;
  const newsCitationStatement = text.replace(legacyFilePattern(), 'FILE').replace(/\s+/gu, ' ').trim();
  if (has('observed_news_article_citations_bound')
    && /^오늘 뉴스 기사 (?:세|3)\s*건의 실제로 읽은 출처 URL을 FILE에 저장하고 확인해$/u.test(newsCitationStatement)) return false;
  if (has('observed_news_article_citations_bound') && observedNewsSummaryRequirement(statement)) {
    const sourceEvidencePassed = checks.some(check => check.checkId === 'observed_news_article_citations_bound'
      && check.passed === true
      && Array.isArray(check.observed)
      && check.observed.some(item => item.claimEvidence?.passed === true
        && item.claimEvidence?.evidenceType === 'verbatim-source-match'));
    if (sourceEvidencePassed) return false;
  }
  // Filenames alone do not authorize arbitrary surrounding prose. Consume every
  // character and accept only existence/creation predicates, optionally with G.
  const masked = text.replace(legacyFilePattern(), 'FILE');
  const files = 'FILE(?:\\s*(?:와|과|및|그리고|[,·])\\s*FILE)*';
  const g = '(?:\\s*(?:그리고|및|하고)?\\s*G\\s*검증(?:을|이)?\\s*통과(?:한다|했다|됨|함)?)?';
  const simpleFile = new RegExp(`^${files}\\s*(?:(?:텍스트\\s*)?파일|문서)?\\s*(?:가|이|를|을)?\\s*(?:(?:실제로?\\s*)?(?:생성(?:된다|되고|한다|됨)?|만들(?:어줘|고)|작성(?:된다|한다|하고)|저장(?:된다|한다|하고))|(?:실제로?\\s*)?존재(?:한다|하고)?|검색\\s*결과에\\s*존재한다|존재하는지\\s*(?:읽기\\s*전용으로\\s*)?확인한다)${g}$`, 'u');
  const observedExistence = new RegExp(`^${files}\\s*파일의\\s*존재가\\s*실제\\s*관찰\\s*증거로\\s*확인된다$`, 'u');
  const namedFileGrammar = has('named_artifacts_match') && (simpleFile.test(masked) || observedExistence.test(masked)
    || new RegExp(`^${files}\\s+(?:exists|is created|is saved|is written)(?:\\s+and\\s+passes G verification)?$`, 'iu').test(masked));
  if (namedFileGrammar) return !appendLegacyPathCheck(checks, verifyLegacyFilePathEvidence({ statement, ...context,
    role: checks.find(check => check.checkId === 'named_artifacts_match')?.evidenceMode === 'produced-artifact-only' ? 'creation' : 'existence' }));
  if (has('named_artifact_absence_verified') && new RegExp(`^${files}\\s*(?:파일|경로)?(?:이|가)?\\s*(?:실제로\\s*)?(?:존재하지\\s*않는다|없다|없음을\\s*확인한다)$`, 'u').test(masked)) {
    return !appendLegacyPathCheck(checks, verifyLegacyFileAbsenceEvidence({ statement, ...context }));
  }
  return true;
}

function legacyFilePattern() {
  return /["'“‘]?(?:(?:[A-Za-z]:[\\/]|\\\\|\/)?(?:[A-Za-z0-9가-힣_.-]+[\\/])*)[A-Za-z0-9가-힣_.-]+\.(?:txt|csv|xlsx|xls|docx|pdf|pptx|ppt|hwpx|hwp|json|md|html?|png|zip)(?![A-Za-z0-9])["'”’]?/giu;
}

function appendLegacyPathCheck(checks, evidence) {
  if (evidence.required) checks.push({ checkId: 'legacy_exact_path_evidence', passed: evidence.passed,
    expectedPathCount: evidence.expectedPathCount, verifiedPathCount: evidence.verifiedPathCount,
    reason: evidence.reason ?? null });
  return evidence.passed;
}

const creationTools = new Set(['filesystem.createTextFile', 'excel.createWorkbook', 'word.create',
  'powerpoint.create', 'hwp.create', 'weather.createHwpReport', 'visual.createCards', 'archive.createZip', 'macro.save', 'workflow.execute']);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** A past empty listing cannot prove absence at another dispatch path or after a file appeared. */
export function searchCoverageAllowsAbsence(data) {
  // Old observations retain their separate exact-dispatch/current-filesystem checks.
  if (!data || !own(data, 'searchCompleteness')) return true;
  const coverage = data.searchCompleteness;
  return plain(coverage) && coverage.version === 'pc-search-completeness-v1'
    && coverage.complete === true && Array.isArray(coverage.reasons) && coverage.reasons.length === 0
    && Number.isSafeInteger(coverage.requestedRootCount) && coverage.requestedRootCount > 0
    && coverage.returnedMatchCount === 0 && coverage.projectionTruncated !== true;
}

export function verifyLegacyFileAbsenceEvidence({ statement, mission = {}, observations = [], allowedRoots = [], evidenceActionIds = [] } = {}) {
  const references = [...String(statement).matchAll(legacyFilePattern())].map(match => match[0].replace(/^["'“‘]|["'”’]$/gu, ''));
  const roots = allowedRoots.map(root => resolve(root));
  const actions = (mission.waves ?? []).flatMap(wave => wave.actions ?? []);
  const candidates = observations.filter(observation => evidenceActionIds.includes(observation.actionId)
    && observation.outcome === 'success' && observation.verification?.status === 'passed'
    && !(observation.verification.failedCheckIds?.length));
  const physicallyAbsent = target => {
    const root = roots.find(candidate => inside(candidate, target));
    if (!root) return false;
    try { lstatSync(target); return false; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    // Resolve the closest existing ancestor, including junctions, without treating an
    // inaccessible or missing workspace as independent evidence of a missing file.
    try {
      const physicalRoot = realpathSync(root);
      let ancestor = dirname(target);
      while (inside(root, ancestor)) {
        try { return statSync(ancestor).isDirectory() && inside(physicalRoot, realpathSync(ancestor)); }
        catch (error) { if (error.code !== 'ENOENT' || samePath(ancestor, root)) return false; }
        ancestor = dirname(ancestor);
      }
    } catch { return false; }
    return false;
  };
  const verified = references.filter(reference => {
    if (!roots.length) return false;
    const target = resolve(roots[0], reference);
    if (!physicallyAbsent(target)) return false;
    return candidates.some(observation => {
      const action = actions.find(item => item.actionId === observation.actionId);
      const dispatch = action?.operation?.dispatch;
      const tool = dispatch?.toolName ?? action?.actualToolName ?? action?.expectedToolName;
      const args = dispatch?.arguments ?? action?.arguments;
      if (!args || observation.toolName !== tool) return false;
      const directory = args.directory ?? args.path;
      if (tool === 'filesystem.listFiles') {
        const items = exhaustiveListingItems(observation.data, args);
        return typeof directory === 'string' && samePath(resolve(roots[0], directory), dirname(target))
          && Array.isArray(items)
          && !items.some(item => typeof item?.name === 'string' && samePath(item.name, basename(target)));
      }
      if (tool === 'filesystem.searchFiles') {
        const scopes = Array.isArray(args.directories) ? args.directories.filter(path => typeof path === 'string').map(path => resolve(roots[0], path))
          : [typeof directory === 'string' ? resolve(roots[0], directory) : roots[0]];
        return searchCoverageAllowsAbsence(observation.data) && args.scope === 'workspace' && scopes.some(scope => samePath(scope, roots[0]) || samePath(scope, dirname(target)))
          && typeof args.query === 'string' && samePath(args.query.trim(), basename(target))
          && !String(args.contentQuery ?? '').trim() && args.modifiedWithinDays == null
          && Array.isArray(observation.data?.matches) && observation.data.matches.length === 0;
      }
      if (tool === 'filesystem.moveFiles') {
        const moves = args.moves ?? (args.from && args.to ? [{ from: args.from, to: args.to }] : []);
        return Array.isArray(moves) && moves.some(move => typeof move?.from === 'string' && typeof move?.to === 'string'
          && samePath(resolve(roots[0], move.from), target) && !samePath(resolve(roots[0], move.to), target));
      }
      return false;
    });
  });
  return { required: true, passed: references.length > 0 && verified.length === references.length,
    expectedPathCount: references.length, verifiedPathCount: verified.length,
    reason: verified.length === references.length ? null : 'exact-dispatch-path-or-current-absence-evidence-missing' };
}

/** Explicit paths need exact G-bound locations. This is file identity/existence, never content quality. */
export function verifyLegacyFilePathEvidence({ statement, mission = {}, observations = [], allowedRoots = [],
  evidenceActionIds = [], role = 'existence', unnamedCreation = false } = {}) {
  const references = [...String(statement).matchAll(legacyFilePattern())].map(match => match[0].replace(/^["'“‘]|["'”’]$/gu, ''));
  const explicit = references.filter(path => /[\\/]/u.test(path) || isAbsolute(path));
  const required = unnamedCreation || explicit.length > 0;
  if (!required) return { required: false, passed: true, expectedPathCount: 0, verifiedPathCount: 0 };
  const roots = allowedRoots.map(root => resolve(root));
  const actions = (mission.waves ?? []).flatMap(wave => wave.actions ?? []);
  const candidates = observations.filter(observation => evidenceActionIds.includes(observation.actionId)
    && observation.outcome === 'success' && observation.verification?.status === 'passed');
  const provenPaths = [];
  const physicalFile = path => {
    const root = roots.find(candidate => inside(candidate, path));
    if (!root) return false;
    try { return inside(realpathSync(root), realpathSync(path)) && statSync(path).isFile(); }
    catch { return false; }
  };
  const artifactPath = artifact => {
    if (!artifact || artifact.outsideAllowedRoots === true || !Number.isInteger(artifact.rootIndex)
      || !roots[artifact.rootIndex] || typeof artifact.relativePath !== 'string') return null;
    const path = resolve(roots[artifact.rootIndex], artifact.relativePath);
    if (!inside(roots[artifact.rootIndex], path) || artifact.pathHash !== hash(path) || !physicalFile(path)) return null;
    return path;
  };
  const boundWorkflowSpec = (args, observation) => {
    try {
      if (args?.spec) return validateWorkflowSpec(args.spec);
      if (typeof args?.specPath !== 'string' || !/^[a-f0-9]{64}$/iu.test(args.expectedSha256 ?? '')) return null;
      const path = resolve(roots[0] ?? '.', args.specPath);
      if (!roots.some(root => inside(root, path)) || !inside(realpathSync(roots[0]), realpathSync(path))) return null;
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_CONTENT_BYTES) return null;
      const bytes = readFileSync(path), actualSha256 = hash(bytes);
      if (actualSha256 !== args.expectedSha256.toLowerCase()
        || actualSha256 !== observation.data?.workflow?.specSha256) return null;
      return validateWorkflowSpec(JSON.parse(bytes.toString('utf8')));
    } catch { return null; }
  };
  for (const observation of candidates) {
    const action = actions.find(item => item.actionId === observation.actionId);
    const dispatch = action?.operation?.dispatch;
    const tool = dispatch?.toolName ?? action?.actualToolName ?? action?.expectedToolName;
    const args = dispatch?.arguments ?? action?.arguments;
    if (!tool || observation.toolName !== tool) continue;
    const creating = unnamedCreation || role === 'creation';
    if (creating && !creationTools.has(tool)) continue;
    if (role !== 'read') {
      const workflowSpec = tool === 'workflow.execute' ? boundWorkflowSpec(args, observation) : null;
      for (const artifact of observation.artifacts ?? []) {
        const path = artifactPath(artifact);
        if (!path) continue;
        // The write checkpoint, not a filename in the objective, binds a creation.
        if (creating) {
          const direct = args?.path ?? args?.outputPath;
          const workflow = tool === 'workflow.execute' && Array.isArray(workflowSpec?.outputs)
            && workflowSpec.outputs.some(output => {
              const node = workflowSpec.nodes?.find(item => item.id === output.nodeId);
              return node && /^(?:write\.|sqlite\.)/u.test(node.op ?? '')
                && typeof output.path === 'string' && samePath(resolve(args.workspaceRoot ?? roots[0], output.path), path);
            });
          const pdf=tool==='excel.createWorkbook'&&args?.renderPdf===true&&typeof args.pdfOutputPath==='string'
            &&samePath(resolve(roots[0]??'.',args.pdfOutputPath),path);
          if (!(typeof direct === 'string' && samePath(resolve(roots[0] ?? '.', direct), path)) && !pdf && !workflow) continue;
        }
        provenPaths.push(path);
      }
    }
    if (creating) continue;
    if (['filesystem.readText','document.readPdf','excel.readWorkbook'].includes(tool) && typeof args?.path === 'string') {
      if(tool==='document.readPdf'&&(observation.data?.pdfRead?.firstPage!==1||observation.data?.pdfRead?.truncated!==false))continue;
      if(tool==='excel.readWorkbook'&&(observation.data?.xlsxRead?.hasCellsOutsideRange!==false||observation.data?.xlsxRead?.otherSheetCount!==0))continue;
      const path = artifactPath(observation.data?.fileEvidence);
      if (path && samePath(path, resolve(roots[0] ?? '.', args.path))) provenPaths.push(path);
    }
    if (role === 'read') continue;
    if (tool === 'filesystem.searchFiles') {
      for (const match of observation.data?.matches ?? []) {
        const path = artifactPath(match.artifact);
        if (path) provenPaths.push(path);
      }
    }
    if (tool === 'filesystem.listFiles' && typeof args?.directory === 'string') {
      for (const item of observation.data?.items ?? []) {
        if (typeof item.name !== 'string' || basename(item.name) !== item.name || item.type === 'directory') continue;
        const path = resolve(roots[0] ?? '.', args.directory, item.name);
        if (physicalFile(path)) provenPaths.push(path);
      }
    }
  }
  const expected = explicit.map(path => roots.length ? resolve(roots[0], path) : null);
  const verifiedPathCount = unnamedCreation ? Number(provenPaths.length > 0)
    : expected.filter(target => target && provenPaths.some(path => samePath(path, target))).length;
  const expectedPathCount = unnamedCreation ? 1 : expected.length;
  return { required: true, passed: expectedPathCount > 0 && verifiedPathCount === expectedPathCount,
    expectedPathCount, verifiedPathCount,
    reason: verifiedPathCount === expectedPathCount ? null : 'exact-g-path-or-creation-evidence-missing' };
}
