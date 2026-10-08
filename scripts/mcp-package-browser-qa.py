import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-mcp-package-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/mcp-package-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for view,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url']+'/src/ui/connections/mcp.html',wait_until='networkidle')
     page.wait_for_timeout(1200)
     (out/(view+'-diagnostic.json')).write_text(json.dumps({'text':page.locator('body').inner_text(),'errors':errors},ensure_ascii=False),encoding='utf-8')
     page.screenshot(path=str(out/(view+'-before.png')),full_page=True)
     form=page.locator('[data-mcp-install]');expect(form).to_have_count(1,timeout=10000)
     if view=='desktop':
      expect(form.locator('button')).to_be_enabled();form.locator('select').select_option('reviewed.sum');form.locator('button').click()
      expect(page.locator('[data-mcp-install-status]')).to_contain_text('설치됨',timeout=30000)
      page.reload(wait_until='networkidle');expect(page.locator('[data-mcp-install-status]')).to_contain_text('설치됨',timeout=30000)
      child.stdin.write('restart\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='restarted' and reply['calls']==0
      page.reload(wait_until='networkidle');expect(page.locator('[data-mcp-install-status]')).to_contain_text('설치됨',timeout=30000)
     expect(form.locator('button')).to_be_disabled();expect(page.locator('[data-mcp-readiness]')).to_contain_text('허용하지 않음')
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
     page.screenshot(path=str(out/(view+'-installed.png')),full_page=True);results.append({'view':view,'installedShown':True,'manualPermissionUnchanged':True,'pageErrors':errors});page.close()
    child.stdin.write('change\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='changed' and reply['calls']==0
    page=browser.new_page(viewport={'width':390,'height':1000});page.goto(ready['url']+'/src/ui/connections/mcp.html',wait_until='networkidle');expect(page.locator('[data-mcp-install-status]')).to_contain_text('검토',timeout=30000);expect(page.locator('[data-mcp-install]')).to_have_count(0);page.screenshot(path=str(out/'mobile-contract-changed.png'),full_page=True);results.append({'contractChangeBlocked':True,'providerCalls':0,'restoredWithoutManualActivation':True});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
