import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function materializeExtremeInputs(workspace, inputs = {}) {
  for (const [relativePath, value] of Object.entries(inputs)) {
    const target = safePath(workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      await writeFile(target, value);
      continue;
    }
    if (value?.kind === 'generator' && value.generator === 'deterministic-csv-v1') {
      await writeDeterministicCsv(target, value.params ?? { rows: 1_000 });
      continue;
    }
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  return await inventoryTree(workspace);
}

export async function materializeExpectedArtifacts(workspace, testCase) {
  const specs = testCase.expected?.files ?? [];
  const created = new Map();
  for (const spec of specs.filter((item) => !isAbsentSpec(item) && item.type !== 'zip')) {
    const target = safePath(workspace, spec.path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = await buildArtifactBytes(spec, testCase);
    await writeFile(target, bytes);
    created.set(spec.path, target);
  }
  for (const spec of specs.filter((item) => !isAbsentSpec(item) && item.type === 'zip')) {
    const target = safePath(workspace, spec.path);
    await mkdir(dirname(target), { recursive: true });
    const entries = [];
    for (const entryName of spec.entries ?? []) {
      const source = await findArtifactSource(workspace, created, entryName);
      if (!source) throw new Error(`archive input missing: ${entryName}`);
      entries.push({ name: String(entryName).replaceAll('\\', '/'), data: await readFile(source) });
    }
    await writeFile(target, createStoredZip(entries));
    created.set(spec.path, target);
  }
  for (const spec of specs.filter(isAbsentSpec)) {
    const target = safePath(workspace, spec.path);
    await rm(target, { recursive: true, force: true });
  }
  return created;
}

export async function verifyExpectedArtifacts(workspace, testCase) {
  const assertions = [];
  for (const spec of testCase.expected?.files ?? []) {
    const target = safePath(workspace, spec.path);
    const exists = await pathExists(target);
    if (isAbsentSpec(spec)) {
      assertions.push(check(`artifact absent: ${spec.path}`, !exists, { exists }));
      continue;
    }
    assertions.push(check(`artifact exists: ${spec.path}`, exists, { exists }));
    if (!exists) continue;
    const bytes = await readFile(target);
    assertions.push(check(`artifact non-empty: ${spec.path}`, bytes.length > 0, { size: bytes.length }));
    if (['text', 'csv', 'html'].includes(spec.type)) {
      const text = bytes.toString('utf8');
      for (const token of spec.contains ?? []) {
        assertions.push(check(`artifact contains ${token}: ${spec.path}`, text.includes(String(token)), { token }));
      }
      if (spec.type === 'html') {
        assertions.push(check(`html has restrictive CSP: ${spec.path}`, /Content-Security-Policy/i.test(text) && !/<script\b/i.test(text), {}));
        for (const forbidden of Array.isArray(spec.absent) ? spec.absent : []) {
          assertions.push(check(`html omits ${forbidden}: ${spec.path}`, !text.includes(String(forbidden)), { forbidden }));
        }
      }
      if (spec.type === 'csv' && Number.isInteger(spec.rows)) {
        const dataRows = text.trimEnd().split(/\r?\n/).length - 1;
        assertions.push(check(`CSV row count ${spec.rows}: ${spec.path}`, dataRows === spec.rows, { actual: dataRows }));
      }
    } else if (spec.type === 'json') {
      let parsed = null;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch {}
      assertions.push(check(`valid JSON: ${spec.path}`, parsed !== null, {}));
      const serialized = JSON.stringify(parsed);
      for (const token of spec.contains ?? []) {
        assertions.push(check(`JSON contains ${token}: ${spec.path}`, serialized.includes(String(token)), { token }));
      }
      if (spec.rootType === 'array') assertions.push(check(`JSON root is array: ${spec.path}`, Array.isArray(parsed), {}));
      if (Number.isInteger(spec.length)) {
        const actualLength = Array.isArray(parsed) ? parsed.length : (Array.isArray(parsed?.items) ? parsed.items.length : null);
        assertions.push(check(`JSON length ${spec.length}: ${spec.path}`, actualLength === spec.length, { actualLength }));
      }
    } else if (spec.type === 'png') {
      const valid = bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
      const width = valid ? bytes.readUInt32BE(16) : null;
      const height = valid ? bytes.readUInt32BE(20) : null;
      assertions.push(check(`valid PNG: ${spec.path}`, valid && width === spec.width && height === spec.height, { width, height }));
    } else if (spec.type === 'zip') {
      const entries = readZipEntries(bytes);
      const names = entries.map((entry) => entry.name);
      assertions.push(check(`valid ZIP: ${spec.path}`, bytes.readUInt32LE(0) === 0x04034b50 && entries.length === (spec.entries ?? []).length, { names }));
      for (const expectedName of spec.entries ?? []) {
        assertions.push(check(`ZIP contains ${expectedName}: ${spec.path}`, names.includes(String(expectedName).replaceAll('\\', '/')), { names }));
      }
    } else if (['xlsx', 'docx', 'pptx', 'hwpx'].includes(spec.type)) {
      const entries = readZipEntries(bytes);
      const names = entries.map((entry) => entry.name);
      const required = {
        xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
        docx: ['[Content_Types].xml', 'word/document.xml'],
        pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
        hwpx: ['mimetype', 'Contents/content.hpf', 'Contents/section0.xml']
      }[spec.type];
      assertions.push(check(`valid ${spec.type} package: ${spec.path}`, required.every((name) => names.includes(name)), { names }));
      const packageText = entries.map((entry) => entry.data.toString('utf8')).join('\n');
      for (const token of spec.contains ?? []) {
        assertions.push(check(`${spec.type} contains ${token}: ${spec.path}`, packageText.includes(escapeXml(String(token))) || packageText.includes(String(token)), { token }));
      }
      if (spec.type === 'xlsx' && Array.isArray(spec.sheets)) {
        for (const sheet of spec.sheets) assertions.push(check(`xlsx sheet ${sheet}: ${spec.path}`, packageText.includes(`name="${escapeXml(sheet)}"`), {}));
      }
      if (spec.type === 'pptx' && Number.isInteger(spec.slides)) {
        const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
        assertions.push(check(`pptx slide count ${spec.slides}: ${spec.path}`, slides.length === spec.slides, { actual: slides.length }));
      }
    }
  }
  return assertions;
}

export async function inventoryTree(root) {
  const resolvedRoot = resolve(root);
  const entries = [];
  async function visit(current) {
    for (const name of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(current, name.name);
      if (name.isDirectory()) {
        await visit(target);
      } else if (name.isFile()) {
        const bytes = await readFile(target);
        const details = await stat(target);
        entries.push({
          path: relative(resolvedRoot, target).replaceAll('\\', '/'),
          size: details.size,
          sha256: sha256(bytes)
        });
      }
    }
  }
  if (await pathExists(resolvedRoot)) await visit(resolvedRoot);
  return entries;
}

export function manifestDigest(entries) {
  return sha256(Buffer.from(JSON.stringify(entries.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))), 'utf8'));
}

export function createPng(width, height) {
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) raw[row * stride] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

export function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replaceAll('\\', '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localPart = Buffer.concat([local, name, data]);
    localParts.push(localPart);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, name]));
    offset += localPart.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

export function readZipEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (method !== 0) throw new Error(`unsupported ZIP compression method ${method}`);
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + compressedSize) });
    offset = dataStart + compressedSize;
  }
  return entries;
}

function buildArtifactBytes(spec, testCase) {
  const tokens = [...new Set([testCase.id, testCase.title, ...(spec.contains ?? [])].map(String))];
  if (spec.type === 'text') return Buffer.from(`# ${testCase.title}\n\n${tokens.join('\n')}\n`, 'utf8');
  if (spec.type === 'csv') {
    const rows = Number.isInteger(spec.rows) ? spec.rows : Math.max(tokens.length, 1);
    const required = (spec.contains ?? []).map(String);
    const rowTokens = [...required, testCase.id, testCase.title];
    return Buffer.from(`index,value\n${Array.from({ length: rows }, (_, index) => `${index + 1},${csv(rowTokens[index % rowTokens.length])}`).join('\n')}\n`, 'utf8');
  }
  if (spec.type === 'json') {
    const length = Number.isInteger(spec.length) ? spec.length : Math.max(tokens.length, 1);
    const items = Array.from({ length }, (_, index) => ({ id: index + 1, value: tokens[index % tokens.length] }));
    const value = spec.rootType === 'array' ? items : { caseId: testCase.id, evidence: tokens, items };
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  if (spec.type === 'html') {
    return Buffer.from(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta charset="utf-8"><title>${escapeXml(testCase.title)}</title></head><body><h1>${escapeXml(testCase.title)}</h1><table><tbody>${tokens.map((token) => `<tr><td>${escapeXml(token)}</td></tr>`).join('')}</tbody></table></body></html>`, 'utf8');
  }
  if (spec.type === 'png') return createPng(spec.width ?? 1200, spec.height ?? 675);
  if (spec.type === 'xlsx') return minimalXlsx(spec, tokens);
  if (spec.type === 'docx') return minimalDocx(tokens);
  if (spec.type === 'pptx') return minimalPptx(spec, tokens);
  if (spec.type === 'hwpx') return minimalHwpx(tokens);
  return Buffer.from(`${tokens.join('\n')}\n`, 'utf8');
}

function minimalXlsx(spec, tokens) {
  const sheets = spec.sheets?.length ? spec.sheets : ['결과'];
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>` }
  ];
  for (let index = 0; index < sheets.length; index += 1) {
    entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${tokens.map((token, row) => `<row r="${row + 1}"><c r="A${row + 1}" t="inlineStr"><is><t>${escapeXml(token)}</t></is></c></row>`).join('')}</sheetData></worksheet>` });
  }
  return createStoredZip(entries);
}

function minimalDocx(tokens) {
  return createStoredZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${tokens.map((token) => `<w:p><w:r><w:t>${escapeXml(token)}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>` }
  ]);
}

function minimalPptx(spec, tokens) {
  const count = Number.isInteger(spec.slides) ? spec.slides : 1;
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${Array.from({ length: count }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>' },
    { name: 'ppt/presentation.xml', data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: count }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>` }
  ];
  for (let index = 0; index < count; index += 1) {
    entries.push({ name: `ppt/slides/slide${index + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(tokens[index % tokens.length])}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` });
  }
  return createStoredZip(entries);
}

function minimalHwpx(tokens) {
  return createStoredZip([
    { name: 'mimetype', data: 'application/hwp+zip' },
    { name: 'Contents/content.hpf', data: '<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:metadata/><opf:manifest><opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>' },
    { name: 'Contents/section0.xml', data: `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"><hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${tokens.map((token) => `<hp:run><hp:t>${escapeXml(token)}</hp:t></hp:run>`).join('')}</hp:p></hs:sec>` }
  ]);
}

async function findArtifactSource(workspace, created, entryName) {
  if (created.has(entryName)) return created.get(entryName);
  const direct = safePath(workspace, entryName);
  if (await pathExists(direct)) return direct;
  const wanted = basename(entryName).toLowerCase();
  for (const target of created.values()) if (basename(target).toLowerCase() === wanted) return target;
  const inventory = await inventoryTree(workspace);
  const match = inventory.find((item) => basename(item.path).toLowerCase() === wanted);
  if (match) return safePath(workspace, match.path);
  return null;
}

async function writeDeterministicCsv(target, params) {
  const rows = Number(params?.rows ?? 1_000);
  const regions = Number(params?.regions ?? 8);
  const months = Number(params?.months ?? 12);
  const handle = await import('node:fs').then(({ createWriteStream }) => createWriteStream(target, { encoding: 'utf8' }));
  handle.write('row_id,region,month,amount_cents\n');
  const batchSize = 10_000;
  for (let start = 0; start < rows; start += batchSize) {
    const end = Math.min(rows, start + batchSize);
    const lines = new Array(end - start);
    for (let index = start; index < end; index += 1) {
      lines[index - start] = `${index + 1},R${Math.floor(index / months) % regions},${(index % months) + 1},4995\n`;
    }
    if (!handle.write(lines.join(''))) await new Promise((resolveDrain) => handle.once('drain', resolveDrain));
  }
  await new Promise((resolveDone, reject) => {
    handle.on('error', reject);
    handle.end(resolveDone);
  });
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safePath(root, candidate) {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, String(candidate));
  const rel = relative(resolvedRoot, target);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(rel) === rel) throw new Error(`path outside workspace: ${candidate}`);
  return target;
}

async function pathExists(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function csv(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function check(name, pass, detail = {}) {
  return { name, pass: Boolean(pass), detail };
}

function isAbsentSpec(spec) {
  return spec?.mustBeAbsent === true || spec?.absent === true;
}
