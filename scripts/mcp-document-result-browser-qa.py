import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-mcp-result-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/mcp-document-result-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
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
     page.locator('[data-mcp-history]').click();button=page.locator('[data-mcp-result]');expect(button).to_have_count(1,timeout=10000);button.click()
     content=page.locator('[data-mcp-verified-content]');expect(content).to_contain_text('검증한 실제 자료',timeout=10000);expect(content.locator('pre')).to_contain_text('<img src=x')
     assert page.evaluate('window.injected !== 1');assert content.locator('img').count()==0
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
     page.screenshot(path=str(out/(view+'-verified-content.png')),full_page=True)
     page.locator('[data-mcp-result-close]').click();expect(content).to_have_count(0);results.append({'view':view,'verifiedContentShown':True,'htmlInstructionNotExecuted':True,'contentClosed':True,'pageErrors':errors});page.close()
    child.stdin.write('revoke\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='revoked' and reply['calls']==1
    page=browser.new_page(viewport={'width':390,'height':1000});page.goto(ready['url']+'/src/ui/connections/mcp.html',wait_until='networkidle');page.locator('[data-mcp-history]').click();page.locator('[data-mcp-result]').click();expect(page.locator('[role=status]')).to_contain_text('권한이 철회',timeout=10000);expect(page.locator('[data-mcp-verified-content]')).to_have_count(0);page.screenshot(path=str(out/'mobile-revoked.png'),full_page=True);page.close()
    child.stdin.write('restart\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='restarted' and reply['calls']==1
    page=browser.new_page(viewport={'width':390,'height':1000});page.goto(ready['url']+'/src/ui/connections/mcp.html',wait_until='networkidle');page.locator('[data-mcp-history]').click();page.locator('[data-mcp-result]').click();expect(page.locator('[role=status]')).to_contain_text('본문 보관이 끝났거나',timeout=10000);expect(page.locator('[data-mcp-verified-content]')).to_have_count(0);page.screenshot(path=str(out/'mobile-restarted.png'),full_page=True);page.close();results.append({'revokeBlocked':True,'restartContentUnavailable':True,'providerCalls':1,'retrievalReplayCalls':0})
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
