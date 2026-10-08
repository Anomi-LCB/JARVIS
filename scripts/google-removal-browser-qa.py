import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output);out.mkdir(exist_ok=False);results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-google-removal-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/google-removal-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for view,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url']+'/src/ui/connections/accounts.html',wait_until='networkidle')
     control=page.locator('[data-google-collection-control]');expect(control).to_contain_text('Google 자체 접근 권한')
     if view=='desktop':
      expect(page.locator('[data-google-remove]')).to_have_count(1,timeout=15000);page.locator('[data-google-remove]').click();expect(page.locator('[data-google-remove]')).to_have_count(0,timeout=15000);expect(control).to_contain_text('수집 중지됨',timeout=10000)
      child.stdin.write('restart\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='restarted' and reply['externalCalls']==0 and reply['providerCalls']==0
      page.reload(wait_until='networkidle')
     expect(control).to_contain_text('수집 중지됨',timeout=15000);expect(page.locator('[data-google-remove]')).to_have_count(0);expect(page.locator('body')).to_contain_text('이 보호 저장소에 등록된 Google 연결이 없습니다.');expect(page.locator('[data-google-pause] button')).to_be_disabled()
     reply=page.evaluate("async()=>{const r=await fetch('/api/core/personal-google/sync',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return {status:r.status,body:await r.json()};}")
     assert reply['status']==200 and reply['body']['status']=='collection-paused'
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
     page.screenshot(path=str(out/(view+'-paused.png')),full_page=True);results.append({'view':view,'pausedAfterRestart':True,'manualSyncRemainsPaused':True,'localDpapiCredentialsRemoved':True,'providerGrantRevocationNotClaimed':True,'pageErrors':errors,'realGoogleAccountTested':False});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
