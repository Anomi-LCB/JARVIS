import json,subprocess,importlib.util,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
out=repo/sys.argv[2];out.mkdir(exist_ok=False)
child=subprocess.Popen([sys.argv[1],str(repo/'tests/fixtures/selected-sources-browser.mjs')],cwd=repo,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
try:
 ready=json.loads(child.stdout.readline());results=[]
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
  try:
   for width in [1440,390]:
    page=browser.new_page(viewport={'width':width,'height':980});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda e:errors.append(e.text) if e.type=='error' else None)
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['origin']+'/') else r.abort())
    page.request.get(ready['origin']+'/qa/reset');page.goto(ready['url'],wait_until='networkidle')
    try:expect(page.locator('[data-source-select] option')).to_have_count(2)
    except Exception:
     (out/'failure.json').write_text(json.dumps({'errors':errors,'body':page.locator('body').inner_text()},ensure_ascii=False),encoding='utf-8');page.screenshot(path=str(out/'failure.png'),full_page=True);raise
    page.locator('[data-source-select]').select_option(index=1);page.locator('[data-source-run]').click()
    expect(page.locator('.source-results article')).to_have_count(50,timeout=20000);assert page.locator('.source-results img').count()==0
    page.locator('[data-source-next]').click();expect(page.locator('.source-results article')).to_have_count(1)
    page.screenshot(path=str(out/f'result-{width}.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.reload(wait_until='networkidle');expect(page.locator('[data-source-select] option')).to_have_count(2)
    page.locator('[data-source-select]').select_option(index=1)
    expect(page.locator('[data-source-history-open]').first).to_be_enabled(timeout=15000)
    expect(page.locator('.source-results')).to_have_count(0)
    page.locator('[data-source-history-open]').first.click()
    expect(page.locator('.source-results article')).to_have_count(50,timeout=15000)
    page.screenshot(path=str(out/f'history-{width}.png'),full_page=True)
    page.request.get(ready['origin']+'/qa/revoke');page.locator('[data-source-refresh]').click();expect(page.locator('.source-results')).to_have_count(0,timeout=10000)
    expect(page.locator('[data-source-status]')).to_contain_text('숨겼습니다')
    page.screenshot(path=str(out/f'revoked-{width}.png'),full_page=True);assert errors==[],errors
    results.append({'width':width,'fullCount':51,'visiblePages':[50,1],'reloadHistoryRevalidated':True,'injectionNodes':0,'revokedContentHidden':True,'overflow':False,'pageErrors':errors});page.close()
   metrics=browser.new_page();evidence=metrics.request.get(ready['origin']+'/qa/metrics').json();metrics.close()
  finally:browser.close()
 (out/'result.json').write_text(json.dumps({'actualCoreHTTP':True,'actualMission':True,'actualSQLite':True,'syntheticProvider':True,'productionActivation':False,'cases':results,'execution':evidence},ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'passed':len(results),'evidence':evidence}))
finally:
 child.stdin.write('stop\n');child.stdin.flush()
 try:child.wait(timeout=15)
 except subprocess.TimeoutExpired:child.kill();child.wait()
