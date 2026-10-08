import hashlib
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
LIMIT = 16 * 1024 * 1024


def cell_text(cell):
    paragraphs = []
    for paragraph in cell.findall(NS + 'p'):
        parts = []
        for node in paragraph.iter():
            if node.tag == NS + 't':
                parts.append(node.text or '')
            elif node.tag == NS + 'tab':
                parts.append('\t')
            elif node.tag in (NS + 'br', NS + 'cr'):
                parts.append('\n')
        paragraphs.append(''.join(parts))
    return '\n'.join(paragraphs)


def main():
    request_bytes = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(request_bytes) > 1024 * 1024:
        raise ValueError('word-table-request-limit')
    expected = json.loads(request_bytes)
    paragraphs_mode = len(sys.argv) == 3 and sys.argv[2] == '--paragraphs'
    if paragraphs_mode:
        if not isinstance(expected, list) or not 1 <= len(expected) <= 1000 or any(not isinstance(v, str) or len(v) > 6000 or '\x00' in v for v in expected):
            raise ValueError('word-table-paragraph-contract-invalid')
        expected_paragraphs = expected
        expected = []
    if not isinstance(expected, list) or len(expected) > 100:
        raise ValueError('word-table-contract-invalid')
    for table in expected:
        if not isinstance(table, list) or not table or len(table) > 1001:
            raise ValueError('word-table-contract-invalid')
        width = len(table[0]) if isinstance(table[0], list) else 0
        if not 1 <= width <= 100 or any(not isinstance(row, list) or len(row) != width
                or any(not isinstance(value, str) or len(value) > 6000 for value in row) for row in table):
            raise ValueError('word-table-contract-invalid')
    with open(sys.argv[1], 'rb') as source:
        data = source.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('word-table-file-limit')
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or len({entry.filename for entry in entries}) != len(entries) \
                or sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
            raise ValueError('word-table-archive-limit')
        entry = archive.getinfo('word/document.xml')
        if entry.file_size > LIMIT or entry.flag_bits & 1:
            raise ValueError('word-table-xml-limit')
        xml = archive.read(entry)
    # This bounded profile accepts UTF-8 OOXML only. Decode before checking so
    # UTF-16 declarations cannot bypass the entity/doctype guard.
    text = xml.decode('utf-8-sig')
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('word-table-xml-declaration-denied')
    body = ET.fromstring(text).find(NS + 'body')
    if body is None:
        raise ValueError('word-table-body-missing')
    if paragraphs_mode:
        if any(n.tag not in (NS + 'p', NS + 'sectPr') for n in body) or any(list(body.iter(NS + name)) for name in ['del', 'ins', 'fldChar', 'instrText', 'drawing', 'object', 'txbxContent', 'vanish']):
            raise ValueError('word-table-paragraph-structure-unsupported')
        actual = [cell_text_container(p) for p in body.findall(NS + 'p')]
        # Native authoring ends with one structural empty paragraph. Keep every
        # other empty paragraph and whitespace; do not normalize content away.
        if actual and actual[-1] == '':
            actual.pop()
        if actual != [v.replace('\r\n', '\n').replace('\r', '\n') for v in expected_paragraphs]:
            raise ValueError('word-table-paragraph-value-mismatch')
        print(json.dumps({'passed': True, 'paragraphCount': len(actual), 'sha256': hashlib.sha256(data).hexdigest(), 'scope': 'saved-ooxml-ordered-body-paragraphs'}))
        return
    tables = body.findall(NS + 'tbl')
    if len(list(body.iter(NS + 'tbl'))) != len(tables):
        raise ValueError('word-table-nested-unsupported')
    if len(tables) != len(expected):
        raise ValueError('word-table-count-mismatch')
    count = 0
    for table, matrix in zip(tables, expected):
        rows = table.findall(NS + 'tr')
        if len(rows) != len(matrix):
            raise ValueError('word-table-row-count-mismatch')
        for row, wanted in zip(rows, matrix):
            cells = row.findall(NS + 'tc')
            if len(cells) != len(wanted):
                raise ValueError('word-table-column-count-mismatch')
            for cell, value in zip(cells, wanted):
                if any(list(cell.iter(NS + name)) for name in ['gridSpan', 'vMerge', 'hMerge', 'del', 'ins']):
                    raise ValueError('word-table-merged-or-tracked-unsupported')
                if cell_text(cell) != value.replace('\r\n', '\n').replace('\r', '\n'):
                    raise ValueError('word-table-cell-value-mismatch')
                count += 1
    print(json.dumps({'passed': True, 'tableCount': len(tables), 'cellCount': count,
                      'sha256': hashlib.sha256(data).hexdigest(), 'scope': 'saved-ooxml-cell-coordinates'}))


def cell_text_container(paragraph):
    container = ET.Element(NS + 'tc')
    container.append(paragraph)
    return cell_text(container)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'passed': False, 'reason': str(error)[:120]}))
        sys.exit(2)
