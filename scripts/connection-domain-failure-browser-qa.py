import argparse, json, os, subprocess, tempfile, importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py')
qa=importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
parser=argparse.ArgumentParser(); parser.add_argument('--node',required=True); parser.add_argument('--output',required=True)
args=parser.parse_args(); out=Path(args.output); out.mkdir(exist_ok=False); results=[]
cases=[('mcp','mcp-package-browser-product.mjs','/api/core/integrations/mcp','격리 계산 도구'),('accounts','google-removal-browser-product.mjs','/api/core/personal-inbox','격리 Google 계정'),('devices','a2a-registration-browser-product.mjs','/api/core/pc-nodes','격리 PC')]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
 try:
  for kind,fixture,failed_path,label in cases:
   with tempfile.TemporaryDirectory(prefix='jarvis-domain-observation-') as root:
    env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}}
    env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
    child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures'/fixture),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
     ready=json.loads(child.stdout.readline()); assert ready['status']=='ready'
     for view,width in [('desktop',1440),('mobile',390)]:
      page=browser.new_page(viewport={'width':width,'height':1000}); errors=[]; mutations=[]
      page.on('pageerror',lambda e:errors.append(str(e)))
      state={'failed':False}
      def route(r):
       if not r.request.url.startswith(ready['url']+'/'): r.abort(); return
       if r.request.method!='GET': mutations.append(r.request.method+' '+r.request.url)
       if state['failed'] and r.request.url.endswith(failed_path):
        r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':{'code':'TEST_DOMAIN_LOOKUP_UNAVAILABLE'}})); return
       r.continue_()
      page.route('**/*',route)
      page.goto(ready['url']+'/src/ui/connections/'+kind+'.html',wait_until='networkidle')
      expect(page.locator('.connection-content')).to_contain_text(label)
      state['failed']=True; page.locator('[data-refresh]').click()
      expect(page.locator('[data-connection-unavailable]')).to_be_visible()
      expect(page.locator('.connection-content form')).to_have_count(0)
      expect(page.locator('.connection-content')).not_to_contain_text(label)
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
      page.screenshot(path=str(out/(view+'-'+kind+'-failed.png')),full_page=True)
      state['failed']=False; page.locator('[data-refresh]').click()
      expect(page.locator('[data-connection-unavailable]')).to_have_count(0)
      expect(page.locator('.connection-content')).to_contain_text(label)
      assert not errors and not mutations
      results.append({'view':view,'kind':kind,'failedLookupHidCachedLabelAndForms':True,'registrationRestored':True,'unexpectedMutationRequests':mutations,'pageErrors':errors})
      page.close()
     child.stdin.write('restart\n'); child.stdin.flush(); restarted=json.loads(child.stdout.readline())
     assert restarted['status']=='restarted'
     assert restarted.get('calls',0)==0 and restarted.get('providerCalls',0)==0 and restarted.get('externalCalls',0)==0
     results.append({'kind':kind,'serverRestarted':True,'reportedCounters':restarted})
    finally:
     child.stdin.write('stop\n'); child.stdin.flush()
     try: child.wait(timeout=15)
     except subprocess.TimeoutExpired: child.terminate(); child.wait(timeout=5)
 finally: browser.close()
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
