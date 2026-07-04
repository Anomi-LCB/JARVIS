import { readFile } from 'node:fs/promises';

const encoder = new TextEncoder();

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function zipDateTime(date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function zipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = zipDateTime();

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(now.dosTime),
      u16(now.dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      Buffer.from(name)
    ]);
    localParts.push(localHeader, data);

    centralParts.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(now.dosTime),
      u16(now.dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      Buffer.from(name)
    ]));
    offset += localHeader.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0)
  ]);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function worksheetXml({ columns, rows, style = {}, charts = [] }) {
  const headerStyle = style.headerBold || style.headerFill ? ' s="1"' : '';
  const headerCells = columns.map((column, index) => {
    const ref = `${columnName(index)}1`;
    return `<c r="${ref}"${headerStyle} t="inlineStr"><is><t>${escapeXml(column)}</t></is></c>`;
  }).join('');
  const bodyRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = columns.map((column, columnIndex) => {
      const value = Array.isArray(row) ? row[columnIndex] : row[column] ?? '';
      const ref = `${columnName(columnIndex)}${rowNumber}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}"/>
  ${style.autoFilter ? `<autoFilter ref="A1:${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}"/>` : ''}
  <sheetData>
    <row r="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  ${charts.length ? '<drawing r:id="rId1"/>' : ''}
</worksheet>`;
}

function stylesXml({ style = {} } = {}) {
  const headerFill = style.headerFill ?? 'FFD9EAD3';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${escapeXml(headerFill)}"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="${style.headerBold ? 1 : 0}" fillId="${style.headerFill ? 2 : 0}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function metadataXml({ template, style = {}, charts = [] }) {
  const chartItems = charts.map((chart, index) => `
    <chart index="${index + 1}" type="${escapeXml(chart.type)}" title="${escapeXml(chart.title)}" range="${escapeXml(chart.range)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jarvisWorkbookMetadata>
  <template id="${escapeXml(template?.templateId ?? 'blank')}" name="${escapeXml(template?.name ?? 'Blank workbook')}" source="${escapeXml(template?.source ?? 'builtin')}" version="${escapeXml(template?.version ?? '1.0.0')}"/>
  <style headerBold="${Boolean(style.headerBold)}" headerFill="${escapeXml(style.headerFill ?? '')}" autoFilter="${Boolean(style.autoFilter)}"/>
  <charts count="${charts.length}">${chartItems}
  </charts>
</jarvisWorkbookMetadata>`;
}

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function workbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function worksheetRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
}

function drawingXml(charts = []) {
  const anchors = charts.map((chart, index) => {
    const col = 4 + (index % 2) * 8;
    const row = 1 + Math.floor(index / 2) * 16;
    const relId = `rId${index + 1}`;
    return `
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${col + 7}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 14}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="${index + 2}" name="${escapeXml(chart.title ?? `Chart ${index + 1}`)}"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${anchors}
</xdr:wsDr>`;
}

function drawingRelsXml(charts = []) {
  const relationships = charts.map((chart, index) => `
  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}
</Relationships>`;
}

function chartXml({ chart, index, sheetName, columns, rows }) {
  const type = String(chart.type ?? 'bar').toLowerCase();
  const chartTag = type === 'line' ? 'lineChart' : type === 'pie' ? 'pieChart' : 'barChart';
  const categoryColumn = columnName(0);
  const valueColumn = columnName(Math.min(1, Math.max(columns.length - 1, 0)));
  const lastRow = Math.max(rows.length + 1, 2);
  const escapedSheetName = `'${String(sheetName).replaceAll("'", "''")}'`;
  const categoryFormula = `${escapedSheetName}!$${categoryColumn}$2:$${categoryColumn}$${lastRow}`;
  const valueFormula = `${escapedSheetName}!$${valueColumn}$2:$${valueColumn}$${lastRow}`;
  const grouping = type === 'line' ? '<c:grouping val="standard"/>' : '';
  const barDir = type === 'bar' ? '<c:barDir val="col"/>' : '';
  const varyColors = type === 'pie' ? '<c:varyColors val="1"/>' : '<c:varyColors val="0"/>';
  const axes = type === 'pie' ? '' : '<c:axId val="48650112"/><c:axId val="48672768"/>';
  const axisBlocks = type === 'pie' ? '' : `
      <c:catAx><c:axId val="48650112"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="48672768"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>
      <c:valAx><c:axId val="48672768"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="48650112"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(chart.title ?? `Chart ${index + 1}`)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title>
    <c:plotArea>
      <c:layout/>
      <c:${chartTag}>
        ${grouping}
        ${barDir}
        ${varyColors}
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:v>${escapeXml(columns[1] ?? columns[0] ?? 'Value')}</c:v></c:tx>
          <c:cat><c:strRef><c:f>${escapeXml(categoryFormula)}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>${escapeXml(valueFormula)}</c:f></c:numRef></c:val>
        </c:ser>
        ${axes}
      </c:${chartTag}>
      ${axisBlocks}
    </c:plotArea>
    <c:legend><c:legendPos val="r"/><c:layout/></c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function contentTypesXml(charts = []) {
  const chartOverrides = charts.map((chart, index) => `
  <Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');
  const drawingOverride = charts.length ? '\n  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';
  const sheetRelOverride = '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/custom.xml" ContentType="application/xml"/>${drawingOverride}${sheetRelOverride}${chartOverrides}
</Types>`;
}

export function createWorkbookBuffer({ sheetName = 'Sheet1', columns, rows, template, style = {}, charts = [] }) {
  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(charts) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'xl/workbook.xml', data: workbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml() },
    { name: 'xl/styles.xml', data: stylesXml({ style }) },
    { name: 'xl/worksheets/sheet1.xml', data: worksheetXml({ columns, rows, style, charts }) },
    { name: 'docProps/custom.xml', data: metadataXml({ template, style, charts }) }
  ];
  if (charts.length) {
    entries.push(
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: worksheetRelsXml() },
      { name: 'xl/drawings/drawing1.xml', data: drawingXml(charts) },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: drawingRelsXml(charts) },
      ...charts.map((chart, index) => ({
        name: `xl/charts/chart${index + 1}.xml`,
        data: chartXml({ chart, index, sheetName, columns, rows })
      }))
    );
  }
  return zipStore(entries);
}

export async function inspectWorkbookFile(path) {
  const buffer = await readFile(path);
  const text = buffer.toString('utf8');
  const sheetName = /<sheet name="([^"]+)"/.exec(text)?.[1] ?? null;
  const rows = [...text.matchAll(/<row r="/g)].length;
  const firstRow = /<row r="1">([\s\S]*?)<\/row>/.exec(text)?.[1] ?? '';
  const columns = [...firstRow.matchAll(/<c r="/g)].length;
  const metadata = /<jarvisWorkbookMetadata>[\s\S]*?<\/jarvisWorkbookMetadata>/.exec(text)?.[0] ?? '';
  const templateId = /<template id="([^"]+)"/.exec(metadata)?.[1] ?? null;
  const templateSource = /<template[^>]+source="([^"]+)"/.exec(metadata)?.[1] ?? null;
  const templateVersion = /<template[^>]+version="([^"]+)"/.exec(metadata)?.[1] ?? null;
  const chartCount = Number(/<charts count="(\d+)"/.exec(metadata)?.[1] ?? 0);
  const chartPartCount = new Set([...text.matchAll(/xl\/charts\/chart\d+\.xml/g)].map((match) => match[0])).size;
  const hasDrawing = text.includes('xl/drawings/drawing1.xml') && text.includes('<drawing r:id="rId1"');
  const hasStyles = text.includes('<styleSheet');
  const hasAutoFilter = text.includes('<autoFilter');
  const hasContentTypes = text.includes('[Content_Types].xml') && text.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
  const hasWorkbookRelationship = text.includes('_rels/.rels') && text.includes('officeDocument');
  return {
    zipMagic: buffer.subarray(0, 2).toString('utf8'),
    sheetName,
    columnCount: columns,
    rowCount: Math.max(rows - 1, 0),
    templateId,
    templateSource,
    templateVersion,
    chartCount,
    chartPartCount,
    hasDrawing,
    hasStyles,
    hasAutoFilter,
    hasContentTypes,
    hasWorkbookRelationship
  };
}
