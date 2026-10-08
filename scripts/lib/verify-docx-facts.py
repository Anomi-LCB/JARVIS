import json
import sys
import zipfile
import xml.etree.ElementTree as ElementTree
from pathlib import Path

MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024
WORD_NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def main():
    if len(sys.argv) != 2:
        raise ValueError('document-path-required')
    path = Path(sys.argv[1])
    if not path.is_file() or path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('docx-file-missing-or-too-large')
    expected = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    if not isinstance(expected, list) or len(expected) > 1000 or any(not isinstance(value, str) for value in expected):
        raise ValueError('expected-facts-invalid')
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > 1000 or any(info.file_size > MAX_DOCUMENT_XML_BYTES for info in infos):
            raise ValueError('docx-entry-limit')
        entry = archive.getinfo('word/document.xml')
        if entry.file_size > MAX_DOCUMENT_XML_BYTES:
            raise ValueError('docx-document-xml-too-large')
        root = ElementTree.fromstring(archive.read(entry))
    texts = [node.text or '' for node in root.iter(f'{WORD_NS}t')]
    document_text = ''.join(texts)
    checks = [bool(value) and value in document_text for value in expected]
    print(json.dumps({
        'status': 'passed' if all(checks) else 'failed',
        'expectedCount': len(expected),
        'matchedCount': sum(checks),
        'documentXmlBytes': entry.file_size,
        'entryCount': len(infos),
    }, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error)[:120]}, separators=(',', ':')))
        sys.exit(2)
