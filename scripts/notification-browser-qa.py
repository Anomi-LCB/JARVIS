import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-notification-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/knowledge-browser-product.mjs'),root,'notifications'],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for name,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('[data-notification-inbox]',timeout=30000)
     page.locator('[data-notification-inbox] summary').click();assert page.locator('[data-notification-id]').count()==20
     total=21 if name=='desktop' else 20
     if page.locator('[data-notifications-more]').count():page.locator('[data-notifications-more]').click()
     expect(page.locator('[data-notification-id]')).to_have_count(total,timeout=30000)
     ids=page.locator('[data-notification-id]').evaluate_all('(rows)=>rows.map(row=>row.dataset.notificationId)');assert len(set(ids))==total
     page.locator('[data-notification-detail]').first.click();page.wait_for_selector('[data-notification-detail-panel]',timeout=30000)
     expect(page.locator('[data-notification-detail-panel]')).to_contain_text('PRIVATE_SYNTHETIC_NOTIFICATION');expect(page.locator('[data-notification-detail-panel]')).to_contain_text('fixture:notification-ui')
     page.screenshot(path=str(out/(name+'-detail.png')),full_page=True)
     page.locator('[data-notification-close]').click();assert page.locator('[data-notification-detail-panel]').count()==0
     before=page.locator('[data-notification-seen]').count()
     page.locator('[data-notification-seen]').first.click();expect(page.locator('[data-notification-inbox] summary')).to_contain_text(f'미확인 {20 if name=="desktop" else 19}',timeout=30000)
     assert 'PRIVATE_SYNTHETIC_NOTIFICATION' not in page.locator('body').inner_text()
     page.reload(wait_until='networkidle');expect(page.locator('[data-notification-inbox] summary')).to_contain_text(f'미확인 {20 if name=="desktop" else 19}',timeout=30000)
     page.locator('[data-notification-inbox] summary').click();page.screenshot(path=str(out/(name+'.png')),full_page=True)
     page.locator('[data-notification-detail]').first.click();page.wait_for_selector('[data-notification-detail-panel]',timeout=30000)
     expect(page.locator('[data-notification-detail-panel]')).to_contain_text('진행 중');expect(page.locator('[data-notification-detail-panel]')).to_contain_text('후속 확인 대기')
     with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/dismiss'),timeout=30000) as dismissal:page.locator('[data-notification-dismiss]').click()
     receipt=dismissal.value.json();assert receipt['dismissed'] and not receipt['commitmentCompletionVerified']
     page.wait_for_selector('[data-notification-detail-panel]',state='detached',timeout=30000)
     expect(page.locator('[data-notification-inbox] summary')).to_contain_text(f'미확인 {20 if name=="desktop" else 19}',timeout=30000)
     expect(page.locator('[role="status"]')).to_contain_text('원래 일은 진행 중',timeout=30000)
     page.screenshot(path=str(out/(name+'-dismissed.png')),full_page=True)
     if name=='mobile':
      page.locator('[data-notification-detail]').first.click();page.wait_for_selector('[data-deadline-change]',timeout=30000)
      page.locator('#ws-deadline').fill('2030-01-15T14:30')
      lost=[]
      def lose_deadline(route):
       response=route.fetch();lost.append(json.loads(route.request.post_data));assert response.status==200
       route.abort()
      page.route('**/api/core/personal-operations/commitments/*/deadline',lose_deadline,times=1)
      page.locator('[data-deadline-change] button').click()
      expect(page.locator('[data-deadline-change] button')).to_be_enabled(timeout=30000)
      assert lost and page.locator('#ws-deadline').input_value()=='2030-01-15T14:30'
      assert page.evaluate("sessionStorage.getItem('jarvis.workspace.deadline-change')")==lost[0]['changeId']
      page.reload(wait_until='networkidle');page.wait_for_selector('[data-deadline-reconcile]',timeout=30000)
      with page.expect_response(lambda r:r.request.method=='GET' and '/deadline-changes/' in r.url,timeout=30000) as reconciliation:page.locator('[data-deadline-reconcile]').click()
      changed=reconciliation.value.json();assert changed['revision']==2 and not changed['executionAuthority']
      expect(page.locator('[role="status"]')).to_contain_text('이전 기한 변경이 저장',timeout=30000)
      assert page.evaluate("sessionStorage.getItem('jarvis.workspace.deadline-change')") is None
      page.screenshot(path=str(out/'mobile-deadline-recovered.png'),full_page=True)
      page.locator('[data-notification-inbox] summary').click()
      with page.expect_response(lambda r:r.request.method=='GET' and '/notifications/' in r.url,timeout=30000) as selected:page.locator('[data-notification-detail]').first.click()
      current=selected.value.json();page.wait_for_selector('[data-deadline-change]',timeout=30000)
      competing=page.request.post(ready['url']+'/api/core/personal-operations/commitments/'+current['commitmentId']+'/deadline',data={'dueAt':'2031-01-01T00:00:00Z','expectedRevision':current['revision'],'changeId':'browser-competing-change'})
      assert competing.status==200
      page.locator('#ws-deadline').fill('2032-01-01T09:00')
      with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/deadline'),timeout=30000) as conflict:page.locator('[data-deadline-change] button').click()
      assert conflict.value.status==409
      expect(page.locator('[role="alert"]')).to_contain_text('다른 작업에서 기한을 변경',timeout=30000)
      page.wait_for_selector('[data-notification-detail-panel]',state='detached',timeout=30000)

     page.route('**/api/core/personal-operations/notifications?*',lambda r:r.abort());page.locator('[data-refresh]').click();page.wait_for_selector('[data-notifications-unavailable]',timeout=30000);assert page.locator('[data-notification-inbox]').count()==0
     assert not errors;results.append({'view':name,'deadlineChanged':name=='mobile','lostResponseReconciledWithoutWrite':name=='mobile','revisionConflictBlocked':name=='mobile','reloadReceiptRecovered':name=='mobile','pagedWithoutDuplicates':True,'itemsObserved':total,'selectedDeadlineDetail':True,'noticeDismissedWithoutCompletion':True,'detailClosed':True,'acknowledged':True,'reloadPreserved':True,'unavailableDistinct':True,'privateTitleHidden':True,'pageErrors':errors});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
