"""Independent ZIP/XML inspection for synthetic workbook contract tests; no renderer."""
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

S = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
C = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}

def inspect(path):
    with zipfile.ZipFile(path) as archive:
        if sum(i.file_size for i in archive.infolist()) > 16 * 1024 * 1024:
            raise ValueError('fixture-too-large')
        if archive.testzip() is not None:
            raise ValueError('zip-crc-failed')
        sheets = ET.fromstring(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', S)
        sheet_names = [s.attrib['name'] for s in sheets]
        worksheets = {}
        for index, name in enumerate(sheet_names, 1):
            root = ET.fromstring(archive.read(f'xl/worksheets/sheet{index}.xml'))
            cells = {}
            for cell in root.findall('.//s:sheetData/s:row/s:c', S):
                if cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('.//s:t', S))
                else:
                    value = float(cell.find('s:v', S).text)
                cells[cell.attrib['r']] = value
            worksheets[name] = cells
        def resolve_formula(formula):
            match = re.fullmatch(r"'((?:[^']|'')+)'!\$([A-Z]+)\$(\d+):\$([A-Z]+)\$(\d+)", formula)
            if not match or match[2] != match[4]:
                raise ValueError('unexpected-chart-reference')
            cells = worksheets[match[1].replace("''", "'")]
            return [cells.get(f'{match[2]}{row}') for row in range(int(match[3]), int(match[5]) + 1)]
        charts = []
        for name in sorted(n for n in archive.namelist() if re.fullmatch(r'xl/charts/chart\d+\.xml', n)):
            root = ET.fromstring(archive.read(name))
            series = []
            for item in root.findall('.//c:ser', C):
                category = item.find('c:cat/c:strRef/c:f', C).text
                values = item.find('c:val/c:numRef/c:f', C).text
                series.append({'name': item.find('c:tx/c:v', C).text,
                    'categoryFormula': category, 'valueFormula': values,
                    'categories': resolve_formula(category), 'values': resolve_formula(values),
                    'categoryCache': [p.find('c:v', C).text for p in item.findall('c:cat/c:strRef/c:strCache/c:pt', C)],
                    'numericCache': [float(p.find('c:v', C).text) for p in item.findall('c:val/c:numRef/c:numCache/c:pt', C)]})
            charts.append({'path': name, 'series': series})
        return {'zipCrcValid': True, 'sheetNames': sheet_names, 'sheetStates': {s.attrib['name']: s.attrib.get('state', 'visible') for s in sheets}, 'worksheets': worksheets, 'charts': charts,
                'actualRenderingVerified': False}

if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=True))
