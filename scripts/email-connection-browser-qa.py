import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output);out.mkdir(exist_ok=False);results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-email-connection-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/email-connection-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for view,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url']+'/src/ui/connections/email.html',wait_until='networkidle')
     control=page.locator('[data-email-status]');expect(control).to_have_text('설정 있음 · 연결 확인 전' if view=='desktop' else '이 프로그램에서 사용 중지됨')
     expect(page.locator('[data-email-probe]')).to_be_enabled()
     page.locator('[data-email-probe]').click();expect(control).to_have_text('연결 확인됨',timeout=10000)
     expect(page.get_by_text('특정 발신자의 발송 허용·수신함 도착은 아직',exact=False)).to_be_visible()
     page.locator('[data-email-pause]').click();expect(control).to_have_text('이 프로그램에서 사용 중지됨',timeout=10000)
     expect(page.locator('[data-email-pause]')).to_be_disabled()
     page.reload(wait_until='networkidle');expect(control).to_have_text('이 프로그램에서 사용 중지됨')
     page.locator('[data-email-probe]').click();expect(control).to_have_text('연결 확인됨',timeout=10000)
     page.locator('[data-email-pause]').click();expect(control).to_have_text('이 프로그램에서 사용 중지됨',timeout=10000)
     child.stdin.write('unavailable\n');child.stdin.flush();assert json.loads(child.stdout.readline())['unavailable']
     page.reload(wait_until='networkidle');expect(page.locator('[data-connection-unavailable]')).to_be_visible();assert page.locator('[data-email-probe]').count()==0;assert page.locator('[data-email-status]').count()==0
     child.stdin.write('available\n');child.stdin.flush();assert not json.loads(child.stdout.readline())['unavailable']
     page.reload(wait_until='networkidle');expect(control).to_have_text('이 프로그램에서 사용 중지됨')
     assert page.locator('input').count()==0
     assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
     page.screenshot(path=str(out/(view+'-paused.png')),full_page=True)
     results.append({'view':view,'verifiedThenPaused':True,'pauseAfterReload':True,'resumedByExplicitVerify':True,'credentialFields':0,'failedObservationHidesActions':True,'pageErrors':errors,'realSMTPTested':False});page.close()
    child.stdin.write('counts\n');child.stdin.flush();counts=json.loads(child.stdout.readline());assert counts=={'checks':4,'sends':0,'externalCalls':0};results.append(counts)
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')

