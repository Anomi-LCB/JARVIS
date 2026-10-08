"""Compare Windows-extracted native icon pixels with the packaged ICO's 32px DIB."""
import argparse, json, struct
from pathlib import Path
from PIL import Image
args=argparse.ArgumentParser();args.add_argument('--ico',required=True);args.add_argument('--extracted',required=True);args.add_argument('--report',required=True);args=args.parse_args()
raw=Path(args.ico).read_bytes();reserved,kind,count=struct.unpack_from('<HHH',raw);assert reserved==0 and kind==1 and count==7
entries=[struct.unpack_from('<BBBBHHII',raw,6+16*i) for i in range(count)]
entry=next(e for e in entries if e[0]==32 and e[1]==32);offset=entry[7];assert struct.unpack_from('<IiiHH',raw,offset)==(40,32,64,1,32)
image=Image.open(args.extracted).convert('RGBA');assert image.size==(32,32)
expected=[]
for y in range(32):
 for x in range(32):
  b,g,r,a=struct.unpack_from('<BBBB',raw,offset+40+((31-y)*32+x)*4);expected.append((r,g,b,a))
assert list(image.getdata())==expected, 'NATIVE_EMBEDDED_ICON_PIXELS_DIFFER'
assert expected[0][3]==0 and expected[16*32+16][3]==0 and any(p[3]==255 for p in expected)
report={'status':'passed','nativeAssociatedIconMatchesPackagedBrandPixels':True,'size':[32,32],'pixelsCompared':1024,'transparentPixels':sum(p[3]==0 for p in expected),'opaquePixels':sum(p[3]==255 for p in expected),'taskbarLiveWindowVerified':False}
with Path(args.report).open('x',encoding='utf-8') as handle:json.dump(report,handle,ensure_ascii=False,indent=2)
print(json.dumps(report))
