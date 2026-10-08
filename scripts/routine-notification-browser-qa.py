import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-routine-notice-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/knowledge-browser-product.mjs'),root,'routine-notifications'],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for index,(name,width) in enumerate([('desktop',1440),('mobile',390)]):
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('[data-notification-inbox]',timeout=30000)
     page.locator('[data-notification-inbox] summary').click();expect(page.locator('[data-notification-id]')).to_have_count(6)
     ids=page.locator('[data-notification-id]').evaluate_all('(rows)=>rows.map(row=>row.dataset.notificationId)');assert len(set(ids))==6
     body=page.locator('[data-notification-inbox]').inner_text()
     for word in ['예약 작업이 완료','예약 작업이 실패','준비 조건','추가 조치','실행 전 예약을 취소','실행 시기를 놓쳤','예약 시각:']:assert word in body
     assert 'PRIVATE_ROUTINE_OBJECTIVE' not in body
     assert page.locator('[data-notification-detail]').count()==0
     with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/seen')) as receipt:page.locator('[data-notification-seen]').first.click()
     assert receipt.value.status==200 and not receipt.value.json()['userReadVerified']
     expect(page.locator('[data-notification-inbox] summary')).to_contain_text('미확인 '+str(5-index))
     page.reload(wait_until='networkidle');expect(page.locator('[data-notification-inbox] summary')).to_contain_text('미확인 '+str(5-index))
     page.locator('[data-notification-inbox] summary').click();expect(page.locator('[data-notification-id]')).to_have_count(6)
     assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
     page.screenshot(path=str(out/(name+'.png')),full_page=True)
     page.route('**/api/core/personal-operations/notifications?*',lambda r:r.abort());page.locator('[data-refresh]').click();page.wait_for_selector('[data-notifications-unavailable]',timeout=30000)
     assert not errors
     results.append({'view':name,'width':width,'url':ready['url'],'sixDistinctStates':True,'scheduledTimeVisible':True,'rows':6,'duplicateRows':0,'acknowledgementPersisted':True,'unavailableDistinct':True,'privateObjectiveHidden':True,'horizontalOverflow':False,'pageErrors':errors});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
