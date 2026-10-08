"""Actual travel connection page prerequisites; isolated four-service runtime."""
import importlib.util,json,os,subprocess,tempfile,argparse
from pathlib import Path
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright
spec=importlib.util.spec_from_file_location('qa',Path(__file__).with_name('control-center-browser-qa.py'));qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
repo=Path(__file__).resolve().parent.parent;out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-clarification-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}}
 env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/input-latency-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True,args=['--disable-extensions','--disable-background-networking'])
   try:
    for name,viewport in [('desktop',{'width':1440,'height':1000}),('mobile',{'width':390,'height':844})]:
     page=browser.new_page(viewport=viewport);errors=[];submissions=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url']+'/src/ui/connections/travel.html',wait_until='networkidle')
     cards=page.locator('[data-travel-prerequisite]');assert cards.count()==5
     links=cards.locator('a');assert links.count()==5
     assert all(links.nth(i).get_attribute('href').startswith('https://') for i in range(5))
     assert page.get_by_text('자동 예약·결제 미연결',exact=True).count()==2
     assert page.locator('input[name="apiKey"],input[type="password"]').count()==0
     page.screenshot(path=str(out/(name+'.png')),full_page=True)
     layout=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)');assert layout==0
     assert not errors,errors
     results.append({'view':name,'providers':5,'officialLinks':5,'secretInputs':0,'horizontalOverflowPx':layout,'pageErrors':errors})
     page.close()
   finally:browser.close()
  result={'observedAt':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'passed':True,'views':results,'scope':'Actual travel.html/connection-center.js/travel.js page on four-service isolated runtime. No renderer hook or fixture provider response. Prerequisites are reviewed catalog data, not a live provider connection. No external account/transaction calls.','cost':'미측정'}
  (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False))
 finally:
  if child.poll() is None:
   child.stdin.write('stop\n');child.stdin.flush()
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:
    subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True);child.wait(timeout=10)
