"""Independent ZIP mutations with fresh CRCs for synthetic chart verification tests."""
import sys, zipfile, re
source, target, mode = sys.argv[1:]
with zipfile.ZipFile(source) as archive:
    entries = {name: archive.read(name) for name in archive.namelist()}
chart = 'xl/charts/chart1.xml'
text = entries[chart].decode('utf-8')
if mode == 'cache':
    text, count = re.subn(r'(<c:numCache>.*?<c:pt idx="1"><c:v>)120(</c:v>)', r'\g<1>999\g<2>', text, count=1, flags=re.S)
    assert count == 1
elif mode == 'cache-index':
    text, count = re.subn(r'(<c:numCache>.*?)<c:pt idx="1">', r'\g<1><c:pt idx="0">', text, count=1, flags=re.S)
    assert count == 1
elif mode == 'cache-count':
    text = text.replace('<c:ptCount val="2"/>', '<c:ptCount val="3"/>', 1)
elif mode == 'series-index':
    text = text.replace('<c:idx val="1"/>', '<c:idx val="0"/>', 1)
elif mode == 'external-formula':
    old = '&apos;성과 O&apos;&apos;Brien&apos;!'
    assert old in text
    text = text.replace(old, '&apos;[external.xlsx]성과 O&apos;&apos;Brien&apos;!', 1)
elif mode == 'no-drawing':
    sheet = entries['xl/worksheets/sheet1.xml'].decode('utf-8')
    sheet, count = re.subn(r'<drawing\b[^>]*/>', '', sheet)
    assert count == 1
    entries['xl/worksheets/sheet1.xml'] = sheet.encode('utf-8')
elif mode in ('cell', 'formula-cell'):
    old = b'<c r="C3"><v>120</v></c>'
    assert old in entries['xl/worksheets/sheet1.xml']
    new = b'<c r="C3"><v>999</v></c>' if mode == 'cell' else b'<c r="C3"><f>100+20</f><v>120</v></c>'
    entries['xl/worksheets/sheet1.xml'] = entries['xl/worksheets/sheet1.xml'].replace(old, new)
elif mode == 'external-drawing':
    name = 'xl/worksheets/_rels/sheet1.xml.rels'
    old = b'Target="../drawings/drawing1.xml"'
    assert old in entries[name]
    entries[name] = entries[name].replace(old, b'Target="https://untrusted.invalid/drawing.xml" TargetMode="External"')
elif mode == 'external-chart':
    name = 'xl/drawings/_rels/drawing1.xml.rels'
    old = b'Target="../charts/chart1.xml"'
    assert old in entries[name]
    entries[name] = entries[name].replace(old, b'Target="https://untrusted.invalid/chart.xml" TargetMode="External"')
elif mode == 'duplicate-chart':
    name = 'xl/drawings/drawing1.xml'
    drawing = entries[name].decode('utf-8')
    anchor = re.search(r'<xdr:twoCellAnchor>.*?</xdr:twoCellAnchor>', drawing, re.S).group(0)
    entries[name] = drawing.replace('</xdr:wsDr>', anchor + '</xdr:wsDr>').encode('utf-8')
elif mode == 'mixed-source':
    text = text.replace('<c:numRef>', '<c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>999</c:v></c:pt></c:numLit><c:numRef>', 1)
else:
    raise ValueError('unknown-mode')
entries[chart] = text.encode('utf-8')
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in entries.items():
        archive.writestr(name, data)
