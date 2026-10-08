import argparse,json,os,subprocess,tempfile,importlib.util
from datetime import datetime,timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-delegation-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/delegation-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for view,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url']+'/src/ui/connections/delegation.html',wait_until='networkidle')
     if view=='desktop':
      expect(page.locator('body')).to_contain_text('등록한 위임이 없습니다')
      page.locator('#mandate-count').fill('3');page.locator('#mandate-expiry').fill((datetime.now()+timedelta(days=1)).strftime('%Y-%m-%dT%H:%M'))
      page.locator('[data-mandate-create] button').click();expect(page.locator('[data-mandate-id]')).to_contain_text('남은 3회',timeout=10000)
      child.stdin.write('restart\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='restarted' and reply['externalCalls']==0
      page.reload(wait_until='networkidle')
     item=page.locator('[data-mandate-id]');expect(item).to_contain_text('jarvis:missions',timeout=10000);expect(item).to_contain_text('남은 3회');assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
     page.screenshot(path=str(out/(view+'-registered.png')),full_page=True)
     if view=='mobile':
      page.locator('[data-mandate-revoke]').click();expect(item).to_contain_text('철회됨',timeout=10000);expect(page.locator('[data-mandate-revoke]')).to_have_count(0)
      page.reload(wait_until='networkidle');expect(page.locator('[data-mandate-id]')).to_contain_text('철회됨',timeout=10000)
      page.screenshot(path=str(out/'mobile-revoked.png'),full_page=True)
      page.route('**/api/core/personal-mandates',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":{"code":"OFFLINE"}}'))
      page.locator('[data-refresh]').click();expect(page.locator('body')).to_contain_text('목록 미확인',timeout=10000);expect(page.locator('[data-mandate-id]')).to_have_count(0);expect(page.locator('body')).to_contain_text('관리 인증');assert not errors
      page.unroute('**/api/core/personal-mandates');page.locator('[data-refresh]').click();expect(page.locator('[data-mandate-id]')).to_contain_text('철회됨',timeout=10000)
      page.route('**/api/core/integrations',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":{"code":"CORE_OFFLINE"}}'))
      page.locator('[data-refresh]').click();expect(page.locator('body')).to_contain_text('목록 미확인',timeout=10000);expect(page.locator('[data-mandate-id]')).to_have_count(0);assert not errors
     results.append({'view':view,'quotaCreatedAndRestored':True,'pageErrors':errors,'horizontalOverflow':False,'revokedAndPersisted':view=='mobile','failureClearsStaleRows':view=='mobile'});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
