"""Saved OOXML content and native raster observations; never imports authoring code."""
import sys, json, os, hashlib, zipfile, xml.etree.ElementTree as ET
from PIL import Image, ImageChops
NS = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
def normalize(value):
    return value.replace('\r\n', '\n').replace('\r', '\n')
def text(shape):
    return '' if shape is None else '\n'.join(''.join(t.text or '' for t in paragraph.findall('.//a:t', NS)) for paragraph in shape.findall('.//a:p', NS))
def verify(request):
    root=request['staging']; path=os.path.join(root,'presentation.pptx')
    with open(path,'rb') as file: sha=hashlib.sha256(file.read()).hexdigest()
    with open(os.path.join(root,'native-report.json'),encoding='utf-8-sig') as file: native=json.load(file)
    if native['sourceSha256'] != sha or native['status'] != 'verified': raise ValueError('presentation-current-hash-mismatch')
    expected=request['deck']['slides']; results=[]
    if len(native['slides']) != len(expected): raise ValueError('presentation-observation-count-mismatch')
    with zipfile.ZipFile(path) as archive:
        entries=archive.infolist()
        if len(entries)>3000 or sum(e.file_size for e in entries)>32*1024*1024: raise ValueError('presentation-package-limit')
        if any(e.filename.endswith('vbaProject.bin') for e in entries): raise ValueError('presentation-macro-rejected')
        presentation=ET.fromstring(archive.read('ppt/presentation.xml'))
        if len(presentation.findall('.//p:sldId',NS)) != len(expected): raise ValueError('presentation-slide-count-mismatch')
        for index,item in enumerate(expected,1):
            slide=ET.fromstring(archive.read('ppt/slides/slide%d.xml'%index)); shapes={}
            for shape in slide.findall('.//p:sp',NS):
                identity=shape.find('p:nvSpPr/p:cNvPr',NS)
                if identity is not None: shapes[identity.attrib.get('name')]=shape
            for role,name,value in [('title','JARVIS_Title',item['title']),('body','JARVIS_Body','\n'.join(item['bullets']))]:
                if name not in shapes or normalize(text(shapes[name])) != normalize(value): raise ValueError('presentation-ooxml-'+role+'-mismatch')
                shape=shapes[name]; transform=shape.find('p:spPr/a:xfrm',NS)
                if transform is None: raise ValueError('presentation-ooxml-layout-missing')
                offset=transform.find('a:off',NS); extent=transform.find('a:ext',NS)
                if offset is None or extent is None or transform.attrib.get('rot','0')!='0': raise ValueError('presentation-ooxml-layout-invalid')
                box=[int(offset.attrib['x'])/12700,int(offset.attrib['y'])/12700]
                box.extend([box[0]+int(extent.attrib['cx'])/12700,box[1]+int(extent.attrib['cy'])/12700])
                expected_box=[48,32,912,142] if role=='title' else [48,166,912,492]
                if any(abs(actual-expected)>0.1 for actual,expected in zip(box,expected_box)): raise ValueError('presentation-ooxml-layout-mismatch')
                field=native['slides'][index-1]['fields'][0 if role=='title' else 1]
                if any(abs(actual-recorded)>0.1 for actual,recorded in zip(box,field['box'])): raise ValueError('presentation-native-layout-mismatch')
                identity=shape.find('p:nvSpPr/p:cNvPr',NS)
                if identity.attrib.get('hidden','0') not in ['0','false']: raise ValueError('presentation-ooxml-hidden-text')
                if shape.find('p:txBody/a:bodyPr/a:noAutofit',NS) is None: raise ValueError('presentation-ooxml-autofit-rejected')
                for properties in shape.findall('.//a:rPr',NS):
                    if properties.attrib.get('sz') != ('3200' if role=='title' else '2200'): raise ValueError('presentation-ooxml-font-size-mismatch')
                if any(alpha.attrib.get('val')!='100000' for alpha in shape.findall('.//a:alpha',NS)): raise ValueError('presentation-ooxml-hidden-text')
            if item['notes']:
                notes=ET.fromstring(archive.read('ppt/notesSlides/notesSlide%d.xml'%index))
                body=[s for s in notes.findall('.//p:sp',NS) if s.find('p:nvSpPr/p:nvPr/p:ph',NS) is not None and s.find('p:nvSpPr/p:nvPr/p:ph',NS).attrib.get('type')=='body']
                if len(body)!=1 or normalize(text(body[0])) != normalize(item['notes']): raise ValueError('presentation-ooxml-notes-mismatch')
            observed=native['slides'][index-1]
            if observed['index']!=index or [f['role'] for f in observed['fields']]!=['title','body']: raise ValueError('presentation-observation-order-mismatch')
            png_path=os.path.join(root,'slide-%d.png'%index); image=Image.open(png_path).convert('RGB')
            if image.size!=(1600,900): raise ValueError('presentation-render-size-mismatch')
            for field,value in zip(observed['fields'],[item['title'],'\n'.join(item['bullets'])]):
                if normalize(field['text'])!=normalize(value): raise ValueError('presentation-native-content-mismatch')
                left,top,right,bottom=field['bounds'];box=field['box']
                if value and (left<box[0]-1 or top<box[1]-1 or right>box[2]+1 or bottom>box[3]+1 or box[0]<0 or box[1]<0 or box[2]>960 or box[3]>540): raise ValueError('presentation-text-overflow')
                if value:
                    crop=image.crop((int(left*1600/960),int(top*900/540),int(right*1600/960)+1,int(bottom*900/540)+1))
                    blank=Image.new('RGB',crop.size,(255,255,255))
                    if ImageChops.difference(crop,blank).getbbox() is None: raise ValueError('presentation-render-text-missing')
            with open(png_path,'rb') as file: png_sha=hashlib.sha256(file.read()).hexdigest()
            results.append({'index':index,'png':os.path.basename(png_path),'pngSha256':png_sha,'exactContent':True,'nativeBounds':True,'renderHasInk':True})
    return {'status':'verified','sha256':sha,'slideCount':len(expected),'slides':results,'scope':'saved-ooxml-exact-content-native-bounds-and-raster-ink','semanticMeaning':'not-evaluated','pixelTextRecognition':'not-evaluated'}
if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        with open(sys.argv[1],encoding='utf-8-sig') as file: request=json.load(file)
        print(json.dumps(verify(request),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status':'failed','reason':str(error)},ensure_ascii=False));sys.exit(1)
