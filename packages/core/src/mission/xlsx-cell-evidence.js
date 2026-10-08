import { inflateRawSync } from 'node:zlib';
import {createHash} from 'node:crypto';
import { posix } from 'node:path';

// Deliberately bounded OOXML subset. No extraction, network, macros or formula execution.
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAX = 16 * 1024 * 1024;
const fail = () => { throw new Error('xlsx-content-unreadable'); };
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function archive(bytes,{maxBytes=MAX,maxExpandedBytes=32*1024*1024}={}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes || bytes.length < 22) fail();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), length = bytes.readUInt32LE(end + 12);
  if (count > 2048 || bytes.readUInt16LE(end + 8) !== count || start + length !== end) fail();
  const files = new Map(); let cursor = start, expanded = 0, previousEnd = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const n = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    if (flags & ~0x808 || ![0, 8].includes(method) || size > maxBytes || (expanded += size) > maxExpandedBytes || cursor + 46 + n + extra + comment > end) fail();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + n), name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') || files.has(name)) fail();
    if (offset < previousEnd || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail();
    const localN = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), data = offset + 30 + localN + localExtra;
    if (localN !== n || !bytes.subarray(offset + 30, offset + 30 + localN).equals(nameBytes) || data + compressed > start) fail();
    if (!(flags & 8) && (bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== size)) fail();
    const payload = bytes.subarray(data, data + compressed);
    const decoded = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: maxBytes });
    if (decoded.length !== size || crc32(decoded) !== crc) fail();
    files.set(name, decoded); previousEnd = data + compressed; cursor += 46 + n + extra + comment;
  }
  if (cursor !== end) fail();
  return files;
}
// Bind all package parts while ignoring ZIP timestamps/compression metadata.
// Existing cell readers retain their smaller limits; Mission recovery has a
// separate 128 MiB file budget and verifies path identity around this read.
// Shared bounded ZIP container reader: no extraction or execution. Consumers
// compare these measured members against their own original input contract.
export function zipMemberEvidence(bytes) {
  return [...archive(bytes,{maxBytes:513*1024*1024,maxExpandedBytes:512*1024*1024})]
    .map(([name,content])=>({name,size:content.length,sha256:createHash('sha256').update(content).digest('hex')}));
}
export function xlsxArchiveContentSha256(bytes){
  const entries=[...archive(bytes,{maxBytes:128*1024*1024,maxExpandedBytes:128*1024*1024})]
    .sort(([left],[right])=>left<right?-1:left>right?1:0)
    .map(([name,data])=>[name,createHash('sha256').update(data).digest('hex')]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
function decode(value) {
  return value.replace(/&([^;]*);|&/gu, (all, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(entity ?? '')) fail();
    const n = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!legal(n)) fail(); return String.fromCodePoint(n);
  });
}
const legal = n => n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff;
function xml(bytes) {
  if (!bytes) fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if ([...text].some(c => !legal(c.codePointAt(0)))) fail();
  const stack = [], roots = []; let cursor = 0, nodes = 0;
  const attachText = value => { if (stack.length) stack.at(-1).text += value; else if (value.trim()) fail(); };
  const qname = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
  while (cursor < text.length) {
    if (text[cursor] !== '<') {
      const end = text.indexOf('<', cursor), value = text.slice(cursor, end < 0 ? text.length : end);
      if (value.includes(']]>')) fail(); attachText(decode(value)); cursor = end < 0 ? text.length : end; continue;
    }
    if (text.startsWith('<?xml ', cursor) && cursor === 0) {
      const end = text.indexOf('?>', cursor);
      if (end < 0 || !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/iu.test(text.slice(cursor, end + 2))) fail();
      cursor = end + 2; continue;
    }
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4); if (end < 0 || text.slice(cursor + 4, end).includes('--')) fail(); cursor = end + 3; continue;
    }
    const match = new RegExp(`^<(/?)(${qname})`, 'u').exec(text.slice(cursor)); if (!match) fail();
    const closing = match[1] === '/', name = match[2]; let position = cursor + match[0].length;
    if (closing) {
      const close = /^\s*>/u.exec(text.slice(position)); if (!close || stack.at(-1)?.name !== name) fail(); stack.pop(); cursor = position + close[0].length; continue;
    }
    const attrs = new Map(); let self = false;
    while (true) {
      const ending = /^\s*(\/?)>/u.exec(text.slice(position));
      if (ending) { self = ending[1] === '/'; position += ending[0].length; break; }
      const attribute = new RegExp(`^\\s+(${qname})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'u').exec(text.slice(position));
      if (!attribute || attrs.has(attribute[1])) fail();
      attrs.set(attribute[1], decode(attribute[2] ?? attribute[3]).replace(/[\t\n\r]/gu, ' ')); position += attribute[0].length;
    }
    const ns = Object.assign(Object.create(null), stack.at(-1)?.ns, { xml: 'http://www.w3.org/XML/1998/namespace' });
    for (const [key, value] of attrs) if (key === 'xmlns') ns[''] = value; else if (key.startsWith('xmlns:')) {
      const prefix = key.slice(6);
      if (['xmlns', '__proto__', 'constructor', 'prototype'].includes(prefix) || prefix === 'xml' && value !== ns.xml) fail();
      ns[prefix] = value;
    }
    const expand = (key, attr = false) => { const parts = key.split(':'); if (parts.length === 2) { if (!ns[parts[0]]) fail(); return `{${ns[parts[0]]}}${parts[1]}`; } return `{${attr ? '' : ns[''] ?? ''}}${key}`; };
    const attributes = new Map();
    for (const [key, value] of attrs) if (key !== 'xmlns' && !key.startsWith('xmlns:')) { const expanded = expand(key, true); if (attributes.has(expanded)) fail(); attributes.set(expanded, value); }
    const node = { name, key: expand(name), attributes, ns, children: [], text: '' };
    if (++nodes > 100000 || stack.length > 64) fail();
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!self) stack.push(node); cursor = position;
  }
  if (stack.length || roots.length !== 1) fail(); return roots[0];
}
const children = (node, name, ns = MAIN) => node.children.filter(c => c.key === `{${ns}}${name}`);
const attr = (node, name, ns = '') => node.attributes.get(`{${ns}}${name}`);
const one = (node, name, ns = MAIN) => { const found = children(node, name, ns); if (found.length !== 1) fail(); return found[0]; };
const richText = node => node.children.map(child => child.key === `{${MAIN}}t` ? child.text : child.key === `{${MAIN}}r` ? one(child, 't').text : fail()).join('');
function cellAddress(value) {
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u.test(value)) fail();
  const [, letters, digits] = /^([A-Z]+)([0-9]+)$/u.exec(value);
  if ([...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) > 16384 || Number(digits) > 1048576) fail();
  return value;
}
export function validXlsxCellAddress(value) { try { return typeof value === 'string' && cellAddress(value) === value; } catch { return false; } }

function openWorkbook(bytes) {
  const files = archive(bytes), packageRels = xml(files.get('_rels/.rels')), types = xml(files.get('[Content_Types].xml'));
  if (packageRels.key !== `{${REL}}Relationships` || types.key !== `{${TYPES}}Types`) fail();
  const office = children(packageRels, 'Relationship', REL).filter(r => attr(r, 'Type') === `${DOCREL}/officeDocument`);
  if (office.length !== 1 || attr(office[0], 'TargetMode') || !['xl/workbook.xml', '/xl/workbook.xml'].includes(attr(office[0], 'Target'))) fail();
  const overrides = children(types, 'Override', TYPES);
  if (new Set(overrides.map(o => attr(o, 'PartName'))).size !== overrides.length) fail();
  const assertType = (path, type) => { if (attr(overrides.find(o => attr(o, 'PartName') === '/' + path) ?? { attributes: new Map() }, 'ContentType') !== `application/vnd.openxmlformats-officedocument.spreadsheetml.${type}+xml`) fail(); };
  assertType('xl/workbook.xml', 'sheet.main');
  const workbook = xml(files.get('xl/workbook.xml')), relations = xml(files.get('xl/_rels/workbook.xml.rels'));
  if (workbook.key !== `{${MAIN}}workbook` || relations.key !== `{${REL}}Relationships`) fail();
  const rs = children(relations, 'Relationship', REL);
  if (new Set(rs.map(r => attr(r, 'Id'))).size !== rs.length) fail();
  const sharedRelations = rs.filter(r => attr(r, 'Type') === `${DOCREL}/sharedStrings`);
  if (sharedRelations.length > 1) fail();
  let shared = null;
  if (sharedRelations.length) {
    const r = sharedRelations[0];
    if (attr(r, 'TargetMode') || !['sharedStrings.xml', '/xl/sharedStrings.xml'].includes(attr(r, 'Target'))) fail();
    assertType('xl/sharedStrings.xml', 'sharedStrings'); shared = xml(files.get('xl/sharedStrings.xml'));
  }
  if (shared && shared.key !== `{${MAIN}}sst`) fail();
  return { files, workbook, rs, assertType, overrides, strings: shared ? children(shared, 'si').map(richText) : [], sheets: new Map() };
}
function worksheetEvidence(book, sheetName) {
  if (book.sheets.has(sheetName)) return book.sheets.get(sheetName);
  const sheets = children(one(book.workbook, 'sheets'), 'sheet');
  if (new Set(sheets.map(s => attr(s, 'name')?.toLowerCase())).size !== sheets.length) fail();
  const sheet = sheets.find(s => attr(s, 'name') === sheetName); if (!sheet) fail();
  const relation = book.rs.find(r => attr(r, 'Id') === attr(sheet, 'id', DOCREL));
  if (!relation || attr(relation, 'TargetMode') || attr(relation, 'Type') !== `${DOCREL}/worksheet`) fail();
  const target = attr(relation, 'Target');
  if (!target || target.includes('\\') || target.includes(':') || target.includes('%') || target.split('/').includes('..')) fail();
  const path = target.startsWith('/') ? target.slice(1) : posix.join('xl', target);
  if (!path.startsWith('xl/worksheets/')) fail();
  book.assertType(path, 'worksheet');
  const worksheet = xml(book.files.get(path)); if (worksheet.key !== `{${MAIN}}worksheet`) fail();
  const result = { worksheet, path }; book.sheets.set(sheetName, result); return result;
}
function readCells(book, sheetName, addresses) {
  const { worksheet } = worksheetEvidence(book, sheetName);
  const strings = book.strings, cells = new Map(), selected = new Set(addresses);
  const sheetData = one(worksheet, 'sheetData'), rows = new Set();
  if (sheetData.children.some(c => c.key !== `{${MAIN}}row`)) fail();
  for (const row of children(sheetData, 'row')) {
    const rowNumber = attr(row, 'r');
    if (!/^[1-9][0-9]{0,6}$/u.test(rowNumber ?? '') || Number(rowNumber) > 1048576 || rows.has(rowNumber) || row.children.some(c => c.key !== `{${MAIN}}c`)) fail();
    rows.add(rowNumber);
    for (const cell of children(row, 'c')) {
    const address = cellAddress(attr(cell, 'r'));
    if (cells.has(address) || address.replace(/^[A-Z]+/u, '') !== rowNumber) fail(); cells.set(address, null);
    if (!selected.has(address)) continue;
    if (children(cell, 'f').length) throw Object.assign(new Error('xlsx-formula-unverified'), { code: 'XLSX_FORMULA_UNVERIFIED' });
    const type = attr(cell, 't') ?? 'n'; let value;
    if (!['inlineStr', 'n', 's', 'b', 'str'].includes(type)) fail();
    if (cell.children.some(c => !['f', 'v', 'is'].some(name => c.key === `{${MAIN}}${name}`))) fail();
    if (type === 'inlineStr') { if (children(cell, 'v').length) fail(); value = richText(one(cell, 'is')); }
    else {
      if (children(cell, 'is').length) fail();
      const values = children(cell, 'v'); if (values.length > 1) fail(); const raw = values[0]?.text;
      if (raw === undefined) value = null;
      else if (type === 's') { if (!/^(?:0|[1-9][0-9]*)$/u.test(raw) || Number(raw) >= strings.length) fail(); value = strings[Number(raw)]; }
      else if (type === 'b') { if (!['0', '1'].includes(raw)) fail(); value = raw === '1'; }
      else if (type === 'n') { if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw) || !Number.isFinite(Number(raw))) fail(); value = Number(raw); }
      else if (type === 'str') value = raw;
      else fail();
    }
    cells.set(address, value);
    }
  }
  return Object.fromEntries(addresses.map(address => [address, cells.get(address) ?? null]));
}

/** Read literal cells only. Cached formula values cannot prove recalculation/freshness. */
export function readXlsxCells(bytes, sheetName, addresses) { return readCells(openWorkbook(bytes), sheetName, addresses); }

export function xlsxReadRange(range='A1:J100') {
  const parts=typeof range==='string'?range.split(':'):[];
  if(parts.length!==2||!parts.every(validXlsxCellAddress))throw Error('XLSX_READ_RANGE_INVALID');
  const parse=address=>{const [,letters,row]=/^([A-Z]+)([0-9]+)$/u.exec(address);return {column:[...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0),row:Number(row)};};
  const start=parse(parts[0]),end=parse(parts[1]);
  if(start.column>end.column||start.row>end.row||(end.column-start.column+1)*(end.row-start.row+1)>1000)throw Error('XLSX_READ_RANGE_INVALID');
  const columnName=index=>{let value='';for(;index>0;index=Math.floor((index-1)/26))value=String.fromCharCode(65+(index-1)%26)+value;return value;};
  const addresses=[];for(let row=start.row;row<=end.row;row++)for(let column=start.column;column<=end.column;column++)addresses.push(columnName(column)+row);
  return {range,addresses};
}

/** Literal storage values only; selected formulas never use their stale cache. */
export function readXlsxRegion(bytes,{sheetName,range='A1:J100'}={}) {
  const selection=xlsxReadRange(range),book=openWorkbook(bytes);
  const sheets=children(one(book.workbook,'sheets'),'sheet').map(sheet=>({name:attr(sheet,'name'),state:attr(sheet,'state')??'visible'}));
  if(!sheets.length||sheets.some(sheet=>typeof sheet.name!=='string'||!sheet.name||sheet.name.length>31
    ||!['visible','hidden','veryHidden'].includes(sheet.state))||new Set(sheets.map(sheet=>sheet.name.toLowerCase())).size!==sheets.length)fail();
  const selected=sheetName??sheets.find(sheet=>sheet.state==='visible')?.name;
  if(!selected||typeof selected!=='string'||!sheets.some(sheet=>sheet.name===selected))throw Error('XLSX_READ_SHEET_NOT_FOUND');
  const cells=readCells(book,selected,selection.addresses),set=new Set(selection.addresses);
  const {worksheet}=worksheetEvidence(book,selected);
  const hasCellsOutsideRange=children(one(worksheet,'sheetData'),'row').some(row=>children(row,'c').some(cell=>!set.has(attr(cell,'r'))));
  if(Buffer.byteLength(JSON.stringify(cells),'utf8')>256*1024)throw Error('XLSX_READ_CONTENT_LIMIT');
  return {sheetName:selected,availableSheets:sheets,range,cells:Object.fromEntries(Object.entries(cells).filter(([,value])=>value!==null)),
    selectedCellCount:selection.addresses.length,missingCellsAreNull:true,hasCellsOutsideRange,otherSheetCount:sheets.length-1,
    regionOnly:true,formulaRecalculationVerified:false,formattedValuesVerified:false,styleRenderingVerified:false};
}

const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
/** Reject known active content before native export. Not an OS sandbox. */
export function validateXlsxNativeExport(bytes) {
  const book=openWorkbook(bytes);
  for(const [name,data] of book.files){
    if(/(?:\.bin$|\.svg$|externalLinks\/|connections\.xml$|queryTables\/|embeddings\/|activeX\/|customUI\/)/iu.test(name))throw Error('XLSX_NATIVE_ACTIVE_CONTENT_BLOCKED');
    if(name.endsWith('.rels')){
      const root=xml(data);if(root.key!==`{${REL}}Relationships`)fail();
      for(const relation of children(root,'Relationship',REL))if(attr(relation,'TargetMode')||/^[a-z][a-z0-9+.-]*:/iu.test(attr(relation,'Target')??''))throw Error('XLSX_NATIVE_EXTERNAL_LINK_BLOCKED');
    }
  }
  const sheets=children(one(book.workbook,'sheets'),'sheet');let count=0;
  if(!sheets.length||sheets.length>20)throw Error('XLSX_NATIVE_SHEET_LIMIT');
  for(const sheet of sheets){
    const name=attr(sheet,'name'),{worksheet}=worksheetEvidence(book,name);
    const addresses=children(one(worksheet,'sheetData'),'row').flatMap(row=>children(row,'c').map(cell=>attr(cell,'r')));
    count+=addresses.length;if(count>50000)throw Error('XLSX_NATIVE_CELL_LIMIT');
    readCells(book,name,addresses);
  }
  return {sheetCount:sheets.length,storedCellCount:count,formulaRecalculationVerified:false};
}
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const ART = 'http://schemas.openxmlformats.org/drawingml/2006/main';
function internalPart(book, from, id, type, prefix) {
  const relPath = posix.join(posix.dirname(from), '_rels', posix.basename(from) + '.rels'), root = xml(book.files.get(relPath));
  if (root.key !== `{${REL}}Relationships`) fail();
  const rs = children(root, 'Relationship', REL);
  if (new Set(rs.map(r => attr(r, 'Id'))).size !== rs.length) fail();
  const r = rs.find(r => attr(r, 'Id') === id), target = r && attr(r, 'Target');
  if (!r || attr(r, 'TargetMode') || attr(r, 'Type') !== `${DOCREL}/${type}` || !target || /[\\:%?#]/u.test(target)) fail();
  const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(from), target));
  if (!path.startsWith(prefix) || !book.files.has(path)) fail();
  const contentType = attr(book.overrides.find(o => attr(o, 'PartName') === '/' + path) ?? { attributes: new Map() }, 'ContentType');
  if (contentType !== (type === 'chart' ? 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml' : 'application/vnd.openxmlformats-officedocument.drawing+xml')) fail();
  return path;
}
function literal(node) { if (node.children.length) fail(); return node.text; }
function chartReference(formula) {
  const match = /^'((?:[^']|'')+)'!\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6}):\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/u.exec(formula);
  if (!match || match[2] !== match[4] || Number(match[3]) > Number(match[5]) || Number(match[5]) - Number(match[3]) > 999) fail();
  const sheet = match[1].replaceAll("''", "'"), addresses = [];
  if (sheet.length > 31 || /[\[\]:*?/\\\u0000-\u001f]/u.test(sheet)) fail();
  for (let i = Number(match[3]); i <= Number(match[5]); i++) addresses.push(cellAddress(match[2] + i));
  return { sheet, addresses };
}
export function validXlsxChartReference(formula) { try { if (typeof formula !== 'string') return false; chartReference(formula); return true; } catch { return false; } }
function referencedCells(book, formula) {
  const { sheet, addresses } = chartReference(formula);
  const cells = readCells(book, sheet, addresses);
  return addresses.map(address => cells[address]);
}
function cachedPoints(ref, kind, count) {
  const cache = one(ref, kind, CHART), n = attr(one(cache, 'ptCount', CHART), 'val');
  if (cache.children.some(c => !['ptCount', 'pt', ...(kind === 'numCache' ? ['formatCode'] : [])].some(name => c.key === `{${CHART}}${name}`))) fail();
  if (n !== String(count)) fail();
  const points = children(cache, 'pt', CHART), found = new Map();
  if (points.length !== count) fail();
  for (const point of points) {
    if (point.children.length !== 1) fail();
    const index = attr(point, 'idx');
    if (!/^(?:0|[1-9][0-9]*)$/u.test(index ?? '') || Number(index) >= count || found.has(index)) fail();
    const value = literal(one(point, 'v', CHART));
    if (kind === 'numCache') {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || !Number.isFinite(Number(value))) fail();
      found.set(index, Number(value));
    } else found.set(index, value);
  }
  return Array.from({ length: count }, (_, i) => found.get(String(i)));
}
function descendants(node, name, ns) {
  const result = []; for (const child of node.children) { if (child.key === `{${ns}}${name}`) result.push(child); result.push(...descendants(child, name, ns)); } return result;
}
/** Only charts attached to the selected worksheet count; orphan parts cannot prove a chart. */
export function readXlsxCharts(bytes, sheetName) {
  const book = openWorkbook(bytes), { worksheet, path: sheetPath } = worksheetEvidence(book, sheetName), drawings = children(worksheet, 'drawing');
  if (!drawings.length) return [];
  if (drawings.length !== 1) fail();
  const drawingPath = internalPart(book, sheetPath, attr(drawings[0], 'id', DOCREL), 'drawing', 'xl/drawings/'), drawing = xml(book.files.get(drawingPath));
  if (drawing.key !== `{${DRAWING}}wsDr`) fail();
  const chartPaths = new Set(), output = [];
  for (const anchor of drawing.children) {
    if (!['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].some(name => anchor.key === `{${DRAWING}}${name}`)) fail();
    const frame = one(anchor, 'graphicFrame', DRAWING), graphic = one(frame, 'graphic', ART), data = one(graphic, 'graphicData', ART);
    if (attr(data, 'uri') !== CHART || data.children.length !== 1) fail();
    const reference = one(data, 'chart', CHART), chartPath = internalPart(book, drawingPath, attr(reference, 'id', DOCREL), 'chart', 'xl/charts/');
    if (chartPaths.has(chartPath) || output.length >= 3) fail(); chartPaths.add(chartPath);
    const root = xml(book.files.get(chartPath)); if (root.key !== `{${CHART}}chartSpace` || children(root, 'externalData', CHART).length || descendants(root, 'extLst', CHART).length) fail();
    const chart = one(root, 'chart', CHART), plot = one(chart, 'plotArea', CHART);
    const plots = plot.children.filter(node => /Chart$/u.test(node.key));
    if (plots.length !== 1) fail();
    const type = ['bar', 'line', 'pie'].find(type => plots[0].key === `{${CHART}}${type}Chart`); if (!type) fail();
    const title = one(one(one(chart, 'title', CHART), 'tx', CHART), 'rich', CHART);
    const titleText = descendants(title, 't', ART).map(literal).join('');
    const series = children(plots[0], 'ser', CHART), ordered = new Map(), indexes = new Set();
    if (!series.length || series.length > 100 || type === 'pie' && series.length !== 1) fail();
    for (const item of series) {
      const index = attr(one(item, 'idx', CHART), 'val'), order = attr(one(item, 'order', CHART), 'val');
      if (!/^(?:0|[1-9][0-9]*)$/u.test(index ?? '') || indexes.has(index) || !/^(?:0|[1-9][0-9]*)$/u.test(order ?? '') || Number(order) >= series.length || ordered.has(order)) fail();
      indexes.add(index);
      const tx = one(item, 'tx', CHART), category = one(item, 'cat', CHART), value = one(item, 'val', CHART);
      if ([tx, category, value].some(node => node.children.length !== 1)) fail();
      const name = literal(one(tx, 'v', CHART)), cat = one(category, 'strRef', CHART), val = one(value, 'numRef', CHART);
      if (cat.children.length !== 2 || val.children.length !== 2) fail();
      const categoryFormula = literal(one(cat, 'f', CHART)), valueFormula = literal(one(val, 'f', CHART));
      const categoryCells = referencedCells(book, categoryFormula), values = referencedCells(book, valueFormula);
      if (!categoryCells.length || categoryCells.some(value => value === null) || values.length !== categoryCells.length || values.some(value => typeof value !== 'number' || type === 'pie' && value < 0)) fail();
      const categories = categoryCells.map(String), categoryCache = cachedPoints(cat, 'strCache', categories.length), numericCache = cachedPoints(val, 'numCache', values.length);
      if (JSON.stringify(categoryCache) !== JSON.stringify(categories) || JSON.stringify(numericCache) !== JSON.stringify(values)) throw Object.assign(new Error('xlsx-chart-cache-mismatch'), { code: 'XLSX_CHART_CACHE_MISMATCH' });
      ordered.set(order, { name, categoryFormula, valueFormula, categories, values });
    }
    output.push({ type, title: titleText, series: Array.from({ length: series.length }, (_, i) => ordered.get(String(i))) });
  }
  return output;
}
