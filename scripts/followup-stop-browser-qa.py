import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-notification-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/knowledge-browser-product.mjs'),root,'followup-cancel'],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for name,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('[data-notification-inbox]',timeout=30000)
     page.locator('[data-notification-inbox] summary').click()
     found=False
     for button in page.locator('[data-notification-detail]').all():
      button.click();page.wait_for_selector('[data-notification-detail-panel]',timeout=30000)
      if page.locator('[data-followup-cancel]').count():found=True;break
      page.locator('[data-notification-close]').click()
     assert found
     with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/cancel'),timeout=30000) as cancellation:page.locator('[data-followup-cancel]').click()
     stopped=cancellation.value.json();assert cancellation.value.status==200 and stopped.get('mission',{}).get('status')=='CANCELLED',json.dumps({'status':cancellation.value.status,'body':stopped},ensure_ascii=False)
     expect(page.locator('[role="status"]')).to_contain_text('이전 작업을 중단했습니다',timeout=30000)
     page.wait_for_selector('[data-followup-replan]',timeout=30000);assert page.locator('[data-followup-cancel]').count()==0
     page.screenshot(path=str(out/(name+'-stopped.png')),full_page=True)
     page.locator('#ws-replan-objective').fill('중단 후 자료 목록 다시 확인 '+name)
     with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/replan'),timeout=30000) as revised:page.locator('[data-followup-replan] button').click()
     assert revised.value.status==200 and revised.value.json()['status']=='CREATED'
     expect(page.locator('[role="status"]')).to_contain_text('아직 실행하지 않았습니다',timeout=30000)
     assert not errors;results.append({'view':name,'targetBoundCancel':True,'cancelledStateConfirmed':True,'replanCreatedWithoutExecution':True,'pageErrors':errors});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
