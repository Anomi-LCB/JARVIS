import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output).resolve();out.mkdir(exist_ok=False);results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-duffel-disconnect-') as root:
 env=dict(os.environ);env.update({'JARVIS_TEST_DUFFEL_REVOCATIONS':str(Path(root)/'revocations.sqlite'),'JARVIS_TEST_DUFFEL_REQUEST_LOG':str(out/'requests.json')})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/duffel-product-ui.mjs')],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['brokerPid']!=ready['corePid'];origin=ready['url'].split('/src/')[0]
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for view,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(origin+'/') else r.abort())
     page.goto(ready['url'],wait_until='networkidle')
     if view=='desktop':
      expect(page.locator('[data-travel-disconnect]')).to_be_enabled();page.locator('[data-travel-disconnect]').click()
     expect(page.locator('body')).to_contain_text('중개 서버가 이 프로그램의 접근 해제를 확인했습니다')
     expect(page.locator('[data-travel-disconnect]')).to_be_disabled();expect(page.locator('[data-travel-quote] button')).to_be_disabled()
     expect(page.locator('body')).to_contain_text('제공자 계정의 키를 폐기하는 작업은 아닙니다')
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
     page.screenshot(path=str(out/(view+'-revoked.png')),full_page=True);results.append({'view':view,'brokerReceiptConfirmed':True,'quoteDisabled':True,'providerKeyDeletionNotClaimed':True,'pageErrors':errors});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
requests=json.loads((out/'requests.json').read_text(encoding='utf-8'))
assert sum(x['path']=='/travel/duffel/disconnect' for x in requests['requests'])==1
assert not any(x['path']=='/travel/duffel/quote' for x in requests['requests'])
(out/'report.json').write_text(json.dumps({'observations':results,'disconnectRequests':1,'quoteRequests':0,'productionActivation':False},ensure_ascii=False,indent=2),encoding='utf-8')
