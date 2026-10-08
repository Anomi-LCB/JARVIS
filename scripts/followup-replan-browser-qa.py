import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);parser.add_argument('--source-change',action='store_true');args=parser.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-notification-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/knowledge-browser-product.mjs'),root,'followup-source-replan' if args.source_change else 'followup-replan'],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for name,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('[data-notification-inbox]',timeout=30000)
     page.locator('[data-notification-inbox] summary').click()
     found=False
     for button in page.locator('[data-notification-detail]').all():
      button.click();page.wait_for_selector('[data-notification-detail-panel]',timeout=30000)
      if page.locator('[data-followup-replan]').count():found=True;break
      page.locator('[data-notification-close]').click()
     assert found
     if args.source_change:expect(page.locator('[data-followup-source-status]')).to_contain_text('수락 후 변경됨')
     page.locator('#ws-replan-objective').fill('작업 폴더 자료를 다시 확인해 '+name)
     page.locator('#ws-replan-criteria').fill('파일 목록을 검증한다\n원본 파일을 변경하지 않는다')
     lost=[]
     def lose_replan(route):
      response=route.fetch();assert response.status==200;lost.append(response.json());
      if args.source_change:assert len(route.request.post_data_json['expectedSourceHash'])==64
      route.abort()
     page.route('**/api/core/personal-operations/followups/*/replan',lose_replan,times=1)
     page.locator('[data-followup-replan] button').click()
     expect(page.locator('[data-followup-replan] button')).to_be_enabled(timeout=30000)
     assert lost and page.locator('#ws-replan-objective').input_value()=='작업 폴더 자료를 다시 확인해 '+name
     assert page.locator('#ws-replan-criteria').input_value()=='파일 목록을 검증한다\n원본 파일을 변경하지 않는다'
     if name=='desktop':
      earlier=page.evaluate("sessionStorage.getItem('jarvis.workspace.replan-request')")
      page.locator('#ws-replan-objective').fill('다른 요청으로 바꿈')
      page.locator('[data-followup-replan] button').click()
      expect(page.locator('[role="alert"]')).to_contain_text('이전 재계획 결과를 확인',timeout=30000)
      assert page.evaluate("sessionStorage.getItem('jarvis.workspace.replan-request')")==earlier
      page.locator('#ws-replan-objective').fill('작업 폴더 자료를 다시 확인해 '+name)
     assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
     page.screenshot(path=str(out/(name+'-retry.png')),full_page=True)
     if name=='mobile':
      page.reload(wait_until='networkidle');page.wait_for_selector('[data-replan-reconcile]',timeout=30000)
      assert '작업 폴더 자료를 다시 확인해 mobile' not in page.evaluate('JSON.stringify(sessionStorage)')
      page.locator('[data-replan-reconcile]').click();expect(page.locator('[role="status"]')).to_contain_text('같은 요청의 새 계획을 찾았습니다',timeout=30000)
      assert page.evaluate("sessionStorage.getItem('jarvis.workspace.replan-request')") is None
     else:
      with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/replan'),timeout=30000) as response:page.locator('[data-followup-replan] button').click()
      mission=response.value.json();assert response.value.status==200 and mission['status']=='CREATED' and mission['missionId']==lost[0]['missionId']
      expect(page.locator('[role="status"]')).to_contain_text('아직 실행하지 않았습니다',timeout=30000)
     assert not errors;results.append({'view':name,'replanCreatedWithoutExecution':True,'lostResponseInputPreserved':True,'retrySameMission':name=='desktop','reloadReadOnlyRecovery':name=='mobile','pageErrors':errors,'reviewedSourceVersion':args.source_change});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
