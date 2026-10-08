import argparse, json, os, subprocess, tempfile, importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py')
qa=importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
parser=argparse.ArgumentParser(); parser.add_argument('--node',required=True); parser.add_argument('--output',required=True)
args=parser.parse_args(); out=Path(args.output); out.mkdir(exist_ok=False); results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-observation-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}}
 env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/a2a-registration-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline()); assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    card={'name':'검증용 전문 서비스','description':'연결 조회 실패 검증용 서비스','version':'1.0.0','supportedInterfaces':[{'url':'https://example.org/a2a','protocolVersion':'1.0','protocolBinding':'JSONRPC'}],'capabilities':{},'defaultInputModes':['application/json'],'defaultOutputModes':['application/json'],'skills':[{'id':'read','name':'자료 읽기','description':'시험용'}]}
    response=browser.new_context().request.post(ready['url']+'/api/core/integrations/a2a',data={'label':'보존할 전문 서비스','source':'https://example.org/docs','card':card})
    assert response.ok, response.text()
    for view,width in [('desktop',1440),('mobile',390)]:
     for kind in ['a2a','api','agents']:
      page=browser.new_page(viewport={'width':width,'height':1000}); errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
      state={'failed':False,'path':'/api/core/integrations/a2a' if kind=='a2a' else '/api/core/integrations'}
      def route(r):
       if not r.request.url.startswith(ready['url']+'/'): r.abort(); return
       if state['failed'] and r.request.url.endswith(state['path']):
        r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':{'code':'TEST_OBSERVATION_UNAVAILABLE'}})); return
       r.continue_()
      page.route('**/*',route)
      page.goto(ready['url']+'/src/ui/connections/'+kind+'.html',wait_until='networkidle')
      expect(page.locator('[data-connection-unavailable]')).to_have_count(0)
      expect(page.locator('.connection-content form').first).to_be_visible()
      if kind=='a2a': expect(page.locator('[data-a2a-service]')).to_contain_text('보존할 전문 서비스')
      state['failed']=True; page.locator('[data-refresh]').click()
      expect(page.locator('[data-connection-unavailable]')).to_be_visible()
      expect(page.locator('.connection-content form')).to_have_count(0)
      expect(page.locator('[data-a2a-service]')).to_have_count(0)
      expect(page.locator('body')).to_contain_text('철회한 것은 아닙니다')
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
      page.screenshot(path=str(out/(view+'-'+kind+'-failed.png')),full_page=True)
      state['failed']=False; page.locator('[data-refresh]').click()
      expect(page.locator('[data-connection-unavailable]')).to_have_count(0)
      expect(page.locator('.connection-content form').first).to_be_visible()
      if kind=='a2a': expect(page.locator('[data-a2a-service]')).to_contain_text('보존할 전문 서비스')
      assert not errors
      results.append({'view':view,'kind':kind,'failedLookupHidFormsAndOldReadiness':True,'recoveredWithoutDeletingRegistration':True,'pageErrors':errors})
      page.close()
   finally: browser.close()
 finally:
  child.stdin.write('stop\n'); child.stdin.flush()
  try: child.wait(timeout=15)
  except subprocess.TimeoutExpired: child.terminate(); child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
