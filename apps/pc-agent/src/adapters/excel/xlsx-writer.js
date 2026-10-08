import { readFile } from 'node:fs/promises';
import {workbookChartData,normalizeWorkbookCharts} from './chart-data.js';

const encoder = new TextEncoder();

function escapeXml(value) {
  const text=String(value??'');
  if([...text].some(c=>{const p=c.codePointAt(0);return !(p===9||p===10||p===13||p>=0x20&&p<=0xd7ff||p>=0xe000&&p<=0xfffd||p>=0x10000&&p<=0x10ffff);}))throw Object.assign(new Error('B_WORKBOOK_XML_CHARACTER_INVALID'),{code:'B_WORKBOOK_XML_CHARACTER_INVALID'});
  return text
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
      const cellStyle = style.totalRowBold && rowIndex === rows.length - 1 ? ' s="2"' : '';
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${cellStyle}><v>${value}</v></c>`;
      return `<c r="${ref}"${cellStyle} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${charts.length ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}
  <dimension ref="A1:${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}"/>
  <sheetData>
    <row r="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  ${style.autoFilter ? `<autoFilter ref="A1:${columnName(Math.max(columns.length - 1, 0))}${rows.length + 1}"/>` : ''}
  ${charts.length ? '<pageMargins left="0.35" right="0.35" top="0.35" bottom="0.35" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>' : ''}
  ${charts.length && (charts.length > 1 || rows.length > 10) ? `<rowBreaks count="${charts.length - (rows.length > 10 ? 0 : 1)}" manualBreakCount="${charts.length - (rows.length > 10 ? 0 : 1)}">${charts.map((_, index) => index === 0 && rows.length <= 10 ? '' : `<brk id="${rows.length + 4 + index * 18}" min="0" max="16383" man="1"/>`).join('')}</rowBreaks>` : ''}
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
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="${style.headerBold ? 1 : 0}" fillId="${style.headerFill ? 2 : 0}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
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

function workbookXml(sheetNames) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetNames.map((sheet,index)=>`<sheet name="${escapeXml(typeof sheet==='string'?sheet:sheet.name)}" sheetId="${index+1}" r:id="rId${index+1}"${sheet.hidden?' state="hidden"':''}/>`).join('\n')}
  </sheets>
</workbook>`;
}

function workbookRelsXml(sheetCount = 1) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from({length:sheetCount},(_,index)=>`<Relationship Id="rId${index+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`).join('\n')}
  <Relationship Id="rId${sheetCount+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function worksheetRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
}

function drawingXml(charts = [], sourceRowCount = 0) {
  const anchors = charts.map((chart, index) => {
    const col = 0;
    const row = sourceRowCount + 4 + index * 18 + (index > 0 || sourceRowCount > 10 ? 1 : 0);
    const relId = `rId${index + 1}`;
    return `
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${col + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 14}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
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

function chartXml({ chart, index, sheetName, columns, rows, binding = null }) {
  const data=binding??workbookChartData(chart,columns,rows);
  const type = data.type;
  const chartTag = type === 'line' ? 'lineChart' : type === 'pie' ? 'pieChart' : 'barChart';
  const escapedSheetName = `'${String(sheetName).replaceAll("'", "''")}'`;
  const categoryFormula = `${escapedSheetName}!$${data.categoryColumn}$${data.firstDataRow}:$${data.categoryColumn}$${data.lastDataRow}`;
  const categoryCache=`<c:strCache><c:ptCount val="${data.categories.length}"/>${data.categories.map((v,i)=>`<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const seriesXml=data.series.map((series,i)=>{
    const valueFormula=`${escapedSheetName}!$${series.column}$${data.firstDataRow}:$${series.column}$${data.lastDataRow}`;
    const cache=`<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${series.values.length}"/>${series.values.map((v,j)=>`<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache>`;
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${escapeXml(series.name)}</c:v></c:tx><c:cat><c:strRef><c:f>${escapeXml(categoryFormula)}</c:f>${categoryCache}</c:strRef></c:cat><c:val><c:numRef><c:f>${escapeXml(valueFormula)}</c:f>${cache}</c:numRef></c:val></c:ser>`;
  }).join('\n');
  const grouping = type === 'line' ? '<c:grouping val="standard"/>' : type === 'bar' ? '<c:grouping val="clustered"/>' : '';
  const barDir = type === 'bar' ? '<c:barDir val="col"/>' : '';
  const varyColors = type === 'pie' ? '<c:varyColors val="1"/>' : '<c:varyColors val="0"/>';
  const axes = type === 'pie' ? '' : '<c:axId val="48650112"/><c:axId val="48672768"/>';
  const textProperties='<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000" lang="ko-KR"><a:solidFill><a:srgbClr val="334155"/></a:solidFill><a:latin typeface="맑은 고딕"/><a:ea typeface="맑은 고딕"/></a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>';
  const axisTicks='<c:majorTickMark val="none"/><c:minorTickMark val="none"/>';
  const axisBlocks = type === 'pie' ? '' : `
      <c:catAx><c:axId val="48650112"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${axisTicks}<c:tickLblPos val="nextTo"/>${textProperties}<c:crossAx val="48672768"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>
      <c:valAx><c:axId val="48672768"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/>${axisTicks}<c:tickLblPos val="nextTo"/>${textProperties}<c:crossAx val="48650112"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="1400" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill><a:latin typeface="맑은 고딕"/><a:ea typeface="맑은 고딕"/></a:rPr><a:t>${escapeXml(chart.title ?? `Chart ${index + 1}`)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>
    <c:plotArea>
      <c:layout/>
      <c:${chartTag}>
        ${barDir}
        ${grouping}
        ${varyColors}
        ${seriesXml}
        ${axes}
      </c:${chartTag}>
      ${axisBlocks}
    </c:plotArea>
    <c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/>${textProperties}</c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
  ${textProperties}
</c:chartSpace>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function contentTypesXml(charts = [], sheetCount = 1) {
  const chartOverrides = charts.map((chart, index) => `
  <Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');
  const drawingOverride = charts.length ? '\n  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';
  const sheetRelOverride = '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${Array.from({length:sheetCount},(_,index)=>`<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/custom.xml" ContentType="application/xml"/>${drawingOverride}${sheetRelOverride}${chartOverrides}
</Types>`;
}

export function createWorkbookBuffer({ sheetName = 'Sheet1', columns, rows, template, style = {}, charts = [], sheets = null }) {
  const allSheets = [...(sheets ?? [{sheetName,columns,rows,style,charts}])];
  const first=allSheets[0];
  if(allSheets.slice(1).some(sheet=>sheet.charts?.length))throw new Error('charts-supported-on-first-sheet-only');
  charts=normalizeWorkbookCharts(first.charts??charts,first.columns,first.rows);
  sheetName=first.sheetName;columns=first.columns;rows=first.rows;
  const bindings=charts.map((chart,index)=>{
    const data=workbookChartData(chart,columns,rows);
    if(!data.aggregation)return {sheetName,data};
    let name=`_JARVIS_차트_${index+1}`,suffix=1;
    while(allSheets.some(s=>s.sheetName.toLowerCase()===name.toLowerCase()))name=`_JARVIS_차트_${index+1}_${suffix++}`;
    allSheets.push({sheetName:name,hidden:true,columns:['분류','건수'],rows:data.categories.map((category,i)=>[category,data.series[0].values[i]]),style:{},charts:[]});
    return {sheetName:name,data};
  });
  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(charts, allSheets.length) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'xl/workbook.xml', data: workbookXml(allSheets.map(sheet=>({name:sheet.sheetName,hidden:sheet.hidden===true}))) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml(allSheets.length) },
    { name: 'xl/styles.xml', data: stylesXml({ style }) },
    ...allSheets.map((sheet,index)=>({name:`xl/worksheets/sheet${index+1}.xml`,data:worksheetXml(sheet)})),
    { name: 'docProps/custom.xml', data: metadataXml({ template, style, charts }) }
  ];
  if (charts.length) {
    entries.push(
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: worksheetRelsXml() },
      { name: 'xl/drawings/drawing1.xml', data: drawingXml(charts, rows.length) },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: drawingRelsXml(charts) },
      ...charts.map((chart, index) => ({
        name: `xl/charts/chart${index + 1}.xml`,
        data: chartXml({ chart, index, sheetName:bindings[index].sheetName, columns, rows, binding:bindings[index].data })
      }))
    );
  }
  return zipStore(entries);
}

export async function inspectWorkbookFile(path) {
  const buffer = await readFile(path);
  const text = buffer.toString('utf8');
  const sheetName = /<sheet name="([^"]+)"/.exec(text)?.[1] ?? null;
  const sheetNames = [...text.matchAll(/<sheet name="([^"]+)"/g)].map(match=>match[1]);
  const sheetDeclarations=[...text.matchAll(/<sheet name="([^"]+)"[^>]*\/>/g)];
  const sourceRowCount=[...text.matchAll(/<sheetData>([\s\S]*?)<\/sheetData>/g)].reduce((sum,match,index)=>{
    const declaration=sheetDeclarations[index];
    if(declaration&&declaration[1].startsWith('_JARVIS_차트_')&&declaration[0].includes('state="hidden"'))return sum;
    return sum+Math.max([...match[1].matchAll(/<row r="/g)].length-1,0);
  },0);
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
    sheetNames,
    sheetCount: sheetNames.length,
    columnCount: columns,
    rowCount: sourceRowCount,
    totalRowCount: Math.max(rows-sheetNames.length,0),
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
