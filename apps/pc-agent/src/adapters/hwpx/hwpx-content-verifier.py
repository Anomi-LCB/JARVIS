"""Read-only OWPML content oracle; never equates package validity with rendering."""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
REQUIRED = {'mimetype', 'Contents/content.hpf', 'Contents/section0.xml', 'META-INF/manifest.xml'}

def verify_document(path, document):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or not REQUIRED.issubset(names):
            raise ValueError('hwpx-package-entries-invalid')
        if sum(info.file_size for info in archive.infolist()) > 64 * 1024 * 1024:
            raise ValueError('hwpx-package-expanded-size-exceeded')
        if archive.testzip():
            raise ValueError('hwpx-package-crc-invalid')
        sections = sorted(name for name in names if name.startswith('Contents/section') and name.endswith('.xml'))
        roots = [ET.fromstring(archive.read(name)) for name in sections]
    actual_text = '\n'.join(''.join(root.itertext()) for root in roots)
    expected_text = [document.get('title') or '']
    expected_tables = []
    for block in document['blocks']:
        kind = block['type']
        if kind in ('heading', 'paragraph'):
            expected_text.append(block['text'])
        elif kind == 'bullets':
            expected_text.extend(block['items'])
        elif kind == 'table':
            expected_tables.append([block['columns'], *block['rows']])
        else:
            raise ValueError('hwpx-block-type-unsupported')
    if any(value and value not in actual_text for value in expected_text):
        raise ValueError('hwpx-text-postcondition-failed')
    actual_tables = []
    for root in roots:
        for table in root.iter(HP + 'tbl'):
            rows = []
            for row in table.findall(HP + 'tr'):
                rows.append([''.join(cell.itertext()) for cell in row.findall(HP + 'tc')])
            actual_tables.append(rows)
    if actual_tables != expected_tables:
        raise ValueError('hwpx-table-postcondition-failed')
    return {'packageVerified': True, 'textVerified': True, 'tableStructureVerified': True,
            'tableCount': len(actual_tables), 'rendering': {'status': 'unverified', 'reason': 'native-render-not-observed'}}

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        print(json.dumps(verify_document(payload['outputPath'], payload['document']), ensure_ascii=False))
    except Exception as error:
        reason = str(error)
        if not reason.startswith('hwpx-') or any(c not in 'abcdefghijklmnopqrstuvwxyz-' for c in reason):
            reason = 'hwpx-content-inspection-failed'
        print(json.dumps({'status':'failed','reason':reason}))
        sys.exit(1)
