"""Actual UI form/submit wiring with synthetic gate; isolated four-service runtime."""
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
     source=(repo/'src/ui/workspace/app.js').read_text(encoding='utf-8')+"\nwindow.__clarificationQa=(mission,gate)=>{state.ready=true;state.active={...mission,objective:'질문 답변',status:'WAITING_APPROVAL',gates:[{...gate,status:'pending'}]};document.querySelector('main').innerHTML=renderTask(state.active);};"
     def route(r):
      url=r.request.url
      if not url.startswith(ready['url']+'/'):r.abort();return
      if url.split('?')[0].endswith('/workspace/app.js'):r.fulfill(status=200,content_type='application/javascript',body=source);return
      if '/missions/qa-mission/gates/qa-gate/decision' in url:
       submissions.append(r.request.post_data_json);r.fulfill(status=200,content_type='application/json',body=json.dumps({'success':True,'missionId':'qa-mission','status':'PAUSED'}));return
      r.continue_()
     page.route('**/*',route);page.goto(ready['url'],wait_until='networkidle');page.wait_for_function('() => typeof window.__clarificationQa === "function"')
     page.evaluate("""()=>window.__clarificationQa({missionId:'qa-mission'},{gateId:'qa-gate',type:'clarification',questions:['결과 파일 이름은 무엇인가요?','포함할 자료는 무엇인가요?']})""")
     inputs=page.locator('textarea[name="clarificationAnswer"]');assert inputs.count()==2
     inputs.nth(0).fill('answer-result');page.locator('form[data-gate] button').first.click();assert len(submissions)==0
     inputs.nth(1).fill('source.txt');page.screenshot(path=str(out/(name+'.png')),full_page=True)
     layout=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)');assert layout==0
     page.locator('form[data-gate] button').first.click();page.wait_for_timeout(200)
     assert len(submissions)==1 and submissions[0]['answers']==['answer-result','source.txt'],submissions
     assert not errors,errors
     results.append({'view':name,'questionInputs':2,'missingAnswerSubmissions':0,'completeSubmissions':1,'indexMappingPreserved':True,'horizontalOverflowPx':layout,'pageErrors':errors})
     page.close()
   finally:browser.close()
  result={'observedAt':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),'passed':True,'views':results,'scope':'Actual app.js form renderer/document submit handler and four-service UI, with test-only renderer hook and synthetic gate/decision HTTP response. Core answer acceptance tested separately. No external calls or live accounts.','cost':'미측정'}
  (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False))
 finally:
  if child.poll() is None:
   child.stdin.write('stop\n');child.stdin.flush()
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:
    subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True);child.wait(timeout=10)
