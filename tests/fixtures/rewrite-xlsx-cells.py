"""Independent ZIP/XML fixture mutator; synthetic test artifacts only."""
import sys, zipfile, re
source, target, mode = sys.argv[1:]
with zipfile.ZipFile(source) as archive:
    entries = {name: archive.read(name) for name in archive.namelist()}
sheet = 'xl/worksheets/sheet2.xml'
text = entries[sheet].decode('utf-8')
needle = re.search(r'<c r="B4"(?: s="[0-9]+")?><v>50000</v></c>', text).group(0)
changes = {
    'formula': '<c r="B4" s="2"><f>1+1</f><v>50000</v></c>',
    'duplicate': needle + needle,
    'numeric-string': '<c r="B4" t="inlineStr"><is><t>50000</t></is></c>',
    'wrong-row': '<c r="B5"><v>50000</v></c>',
    'unknown-type': '<c r="B4" t="e"><v>50000</v></c>',
    'malformed': '<c r="B4"><v>50000</c></v>',
    'unknown-entity': '<c r="B4" t="inlineStr"><is><t>&undefined;</t></is></c>',
    'duplicate-attribute': '<c r="B4" r="B4"><v>50000</v></c>',
    'foreign-cell': '<x:c xmlns:x="https://untrusted.invalid" r="B4"><v>50000</v></x:c>',
    'boolean': '<c r="B4" t="b"><v>1</v></c>',
    'shared': '<c r="B4" t="s"><v>0</v></c>',
    'prefix': needle,
    'doctype': needle,
    'external': needle,
    'duplicate-zip': needle,
    'compressed': needle,
    'root-target': needle,
    'macro': needle,
    'shared-target': '<c r="B4" t="s"><v>0</v></c>',
}
text = text.replace(needle, changes[mode])
if mode in ('shared', 'shared-target'):
    entries['xl/sharedStrings.xml'] = b'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>50</t></r><r><t>000</t></r></si></sst>'
    entries['xl/_rels/workbook.xml.rels'] = entries['xl/_rels/workbook.xml.rels'].replace(b'</Relationships>', b'<Relationship Id="rShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    entries['[Content_Types].xml'] = entries['[Content_Types].xml'].replace(b'</Types>', b'<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
if mode == 'shared-target':
    entries['xl/_rels/workbook.xml.rels'] = entries['xl/_rels/workbook.xml.rels'].replace(b'Target="sharedStrings.xml"', b'Target="other.xml"')
if mode == 'root-target':
    entries['_rels/.rels'] = entries['_rels/.rels'].replace(b'Target="xl/workbook.xml"', b'Target="xl/other.xml"')
if mode == 'macro':
    entries['[Content_Types].xml'] = entries['[Content_Types].xml'].replace(b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', b'application/vnd.ms-excel.sheet.macroEnabled.main+xml')
if mode == 'prefix':
    import xml.etree.ElementTree as ET
    ET.register_namespace('s', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    text = ET.tostring(ET.fromstring(text), encoding='unicode')
if mode == 'doctype':
    text = text.replace('<worksheet ', '<!DOCTYPE worksheet [<!ENTITY e SYSTEM "file:///secret">]><worksheet ', 1)
if mode == 'external':
    entries['xl/_rels/workbook.xml.rels'] = entries['xl/_rels/workbook.xml.rels'].replace(b'Target="worksheets/sheet2.xml"', b'Target="https://untrusted.invalid/file" TargetMode="External"')
entries[sheet] = text.encode('utf-8')
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in entries.items():
        archive.writestr(name, data)
    if mode == 'duplicate-zip':
        archive.writestr(sheet, entries[sheet])
