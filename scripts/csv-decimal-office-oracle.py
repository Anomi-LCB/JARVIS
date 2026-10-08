"""Independent source/CSV/OOXML value audit; imports no JARVIS producer code."""
import csv, hashlib, json, sys, zipfile
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET

root = Path(sys.argv[1]).resolve()
totals = {}
with (root / 'source.csv').open(encoding='utf-8', newline='') as stream:
    for row in csv.DictReader(stream):
        if row['status'] == 'paid':
            totals[row['region']] = totals.get(row['region'], Decimal(0)) + Decimal(row['amount'])
with (root / 'summary.csv').open(encoding='utf-8', newline='') as stream:
    rows = list(csv.DictReader(stream))
assert len(rows) == len(totals)
assert {row['region']: Decimal(row['total']) for row in rows} == totals
ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'c':'http://schemas.openxmlformats.org/drawingml/2006/chart',
      'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with zipfile.ZipFile(root / 'report.xlsx') as book:
    sheet = ET.fromstring(book.read('xl/worksheets/sheet1.xml'))
    cells = {cell.attrib['r']: cell for cell in sheet.findall('.//s:sheetData/s:row/s:c', ns)}
    actual = {}
    for index in range(2, 2 + len(totals)):
        region = ''.join(cells[f'A{index}'].itertext())
        actual[region] = Decimal(cells[f'B{index}'].find('s:v', ns).text)
    assert actual == totals
    chart = ET.fromstring(book.read('xl/charts/chart1.xml'))
    series = chart.findall('.//c:ser', ns)
    assert len(series) == 1
    categories = [point.find('c:v', ns).text for point in series[0].findall('.//c:cat/c:strRef/c:strCache/c:pt', ns)]
    numbers = [Decimal(point.find('c:v', ns).text) for point in series[0].findall('.//c:val/c:numRef/c:numCache/c:pt', ns)]
    assert dict(zip(categories, numbers, strict=True)) == totals
    assert series[0].find('.//c:val/c:numRef/c:f', ns).text == "'집계'!$B$2:$B$3"
with zipfile.ZipFile(root / 'report.docx') as document:
    body = ET.fromstring(document.read('word/document.xml')).find('w:body', ns)
    tables = body.findall('w:tbl', ns)
    assert len(tables) == 1
    matrix = [[''.join(cell.itertext()) for cell in row.findall('w:tc', ns)] for row in tables[0].findall('w:tr', ns)]
    assert matrix[0] == ['region', 'total']
    assert {region:Decimal(value) for region, value in matrix[1:]} == totals
result = {'independentOracle':'Python csv + Decimal + standard-library ZIP/XML',
          'totals':{key:str(value) for key,value in totals.items()},
          'csvValuesMatchSource':True,'xlsxCellsMatchSource':True,'chartValuesAndReferencesMatchSource':True,
          'wordCoordinatesMatchSource':True,'sourcePreserved':json.loads((root/'result.json').read_text(encoding='utf-8'))['sourcePreserved'],
          'fileSha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['source.csv','summary.csv','report.xlsx','report.docx']},
          'limits':'literal values only; no formula recalculation, semantic quality or visual layout judgment'}
with (root/'independent-oracle.json').open('x',encoding='utf-8') as stream:
    json.dump(result,stream,ensure_ascii=False,indent=2)
print(json.dumps(result,ensure_ascii=False))
