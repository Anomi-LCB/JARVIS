"""Compare isolated native Excel observations with fixed synthetic chart requirements."""
import hashlib, json, pathlib, re, sys
import fitz

sample = pathlib.Path(sys.argv[1])
render = pathlib.Path(sys.argv[2])
source = json.loads((sample / 'recheck.json').read_text(encoding='utf-8-sig'))
native = json.loads((render / 'render-report.json').read_text(encoding='utf-8-sig'))
expected = source['spec']['equals']
assert native['readOnly'] is True and native['sourceUnchanged'] is True
assert native['sourceSha256'] == source['contentSha256']
assert len(native['charts']) == len(expected)
types = {'bar': 51, 'line': 65, 'pie': 5}
for actual, wanted in zip(native['charts'], expected):
    assert actual['title'] == wanted['title'] and actual['chartType'] == types[wanted['type']]
    assert len(actual['series']) == len(wanted['series'])
    for index, (observed, series) in enumerate(zip(actual['series'], wanted['series']), 1):
        assert observed['name'] == series['name']
        assert observed['categories'] == series['categories'] and observed['values'] == series['values']
        formula = '=SERIES("' + series['name'].replace('"', '""') + '",' + series['categoryFormula'] + ',' + series['valueFormula'] + ',' + str(index) + ')'
        # Excel removes optional quoting from simple worksheet names on read.
        # Preserve quoting for names containing spaces, apostrophes or punctuation.
        def canonical_reference(text):
            return re.sub(r"'([\w]+)'!", r'\1!', text)
        assert canonical_reference(observed['formula']) == canonical_reference(formula)
    assert actual['titleIncludedInLayout'] is True
    if wanted['type'] != 'pie':
        assert len(actual['axes']) == 2 and all(axis['fontSize'] >= 10 for axis in actual['axes'])
pdf = render / 'sheet-1.pdf'
doc = fitz.open(pdf)
assert len(doc) == len(expected)
page_text = [page.get_text() for page in doc]
for i, chart in enumerate(expected):
    assert ''.join(chart['title'].split()) in ''.join(page_text[i].split())
    for other in expected:
        if other['title'] != chart['title']:
            assert ''.join(other['title'].split()) not in ''.join(page_text[i].split())
    for category in chart['series'][0]['categories']:
        assert category in page_text[i]
    doc[i].get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(render / f'pdf-page-{i+1}.png')
report = {'sourceSha256': source['contentSha256'], 'pdfSha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
          'nativePointAndReferenceComparisonPassed': True, 'expectedChartCount': len(expected), 'pdfPages': len(doc),
          'titlesAndCategoriesOnSeparatePagesPassed': True, 'actualExcelVersion': native['version'], 'actualExcelBuild': native['build'],
          'readOnly': True, 'sourceUnchanged': True, 'scope': 'fixed synthetic chart files; not all workbooks or actual GUI prompt observation',
          'visualReviewRequired': True, 'individualNativePngExportVerified': native['mode'] != 'pdf-only'}
with (render / 'native-independent-check.json').open('x', encoding='utf-8') as output:
    json.dump(report, output, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=True))
