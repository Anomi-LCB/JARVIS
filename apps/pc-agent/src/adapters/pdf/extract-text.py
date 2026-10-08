"""Isolated, fixed parser; bytes arrive via stdin, never an executable PDF action."""
import hashlib, io, json, logging, os, pathlib, sys
logging.disable(logging.CRITICAL)
# This isolated text-only reader explicitly disables jbig2dec below. pypdf
# nevertheless discovers that executable at import time (twice), which can
# traverse slow/network entries in the inherited PATH before limits apply.
# Remove executable discovery only inside this child, before importing pypdf.
# The parent's PATH, Python module paths and parser limits remain unchanged.
os.environ['PATH']=''
os.environ['NoDefaultCurrentDirectoryInExePath']='1'
wheel=pathlib.Path(sys.argv[1])
sys.path.insert(0,str(wheel))
from pypdf import PdfReader, Configuration
from pypdf._configuration import apply_configuration
import pypdf

def fail(code):
    print(json.dumps({'status':'blocked','reason':code}));sys.exit(0)

try:
    if pypdf.__version__!='6.19.0': fail('PDF_PARSER_VERSION_MISMATCH')
    first,count=int(sys.argv[2]),int(sys.argv[3])
    data=sys.stdin.buffer.read(16*1024*1024+1)
    if len(data)>16*1024*1024 or not data.startswith(b'%PDF-'): fail('PDF_INPUT_INVALID')
    limits=Configuration(maximum_declared_stream_length=4*1024*1024,array_based_stream_maximum_output_length=4*1024*1024,
      zlib_maximum_output_length=4*1024*1024,lzw_maximum_output_length=4*1024*1024,run_length_maximum_output_length=4*1024*1024,
      image_maximum_buffer_size=4*1024*1024,page_tree_maximum_entries=5000,page_tree_maximum_depth=32,
      xform_maximum_invocations_per_extraction=100,jbig2dec_binary=None,disable_legacy_handling=True)
    with apply_configuration(limits):
        reader=PdfReader(io.BytesIO(data),strict=True)
        if reader.is_encrypted: fail('PDF_PASSWORD_REQUIRED')
        total=len(reader.pages)
        if total>500 or first>total: fail('PDF_PAGE_RANGE_INVALID')
        pages=[];chars=0
        for index in range(first-1,min(first-1+count,total)):
            text=reader.pages[index].extract_text() or ''
            chars+=len(text)
            if chars>100000: fail('PDF_TEXT_LIMIT')
            if not text.strip(): fail('PDF_OCR_OR_BLANK_PAGE_REVIEW_REQUIRED')
            pages.append({'pageNumber':index+1,'text':text})
        print(json.dumps({'status':'success','parserVersion':pypdf.__version__,'totalPages':total,'firstPage':first,
          'pages':pages,'truncated':pages[-1]['pageNumber']<total,'sourceSha256':hashlib.sha256(data).hexdigest(),
          'verificationScope':'text-layer-only','ocrPerformed':False},ensure_ascii=True))
except Exception:
    fail('PDF_PARSE_FAILED')
