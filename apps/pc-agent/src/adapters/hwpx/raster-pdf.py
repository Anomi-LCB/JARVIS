"""Inspect real exported PDF text/bounds, then rasterize its actual pages."""
import hashlib, json, re, sys
from pathlib import Path
import fitz
from PIL import Image

def normalized(text):
    return re.sub(r'\s+', '', text)

job=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
pdf=Path(job['pdfPath']);data=pdf.read_bytes()
document=fitz.open(stream=data,filetype='pdf')
if document.is_encrypted or not 1 <= len(document) <= 50:
    raise ValueError('hancom-pdf-page-or-encryption-invalid')
text='\n'.join(page.get_text() for page in document)
if any(normalized(value) not in normalized(text) for value in job['expectedText']):
    raise ValueError('hancom-pdf-required-content-missing')
pages=[]
for index,page in enumerate(document,1):
    if page.rect.width>2000 or page.rect.height>2000:
        raise ValueError('hancom-pdf-page-size-exceeded')
    for word in page.get_text('words'):
        if not page.rect.contains(fitz.Rect(*word[:4])):
            raise ValueError('hancom-pdf-text-outside-page')
    path=pdf.parent/f'page-{index}.png'
    pix=page.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False)
    if job.get('verifyOnly'):
        with Image.open(path) as image:
            if image.size != (pix.width,pix.height) or image.convert('RGB').tobytes() != pix.samples:
                raise ValueError('hancom-page-pixels-do-not-match-pdf')
    else:
        if path.exists(): raise ValueError('hancom-page-output-exists')
        pix.save(path)
    blob=path.read_bytes()
    pages.append({'page':index,'name':path.name,'sha256':hashlib.sha256(blob).hexdigest(),'size':len(blob),'width':pix.width,'height':pix.height})
print(json.dumps({'pdfSha256':hashlib.sha256(data).hexdigest(),'pageCount':len(document),'requiredTextVerified':True,'textBoundsVerified':True,'pages':pages}))
