import argparse, importlib.util, json, os, subprocess, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
args=argparse.ArgumentParser();args.add_argument('--node',required=True);args.add_argument('--package-dir');args.add_argument('--output-dir',default='artifacts/microsoft-limit-extension-20261008-browser');args.add_argument('--view',choices=['desktop','mobile'],default='desktop');args=args.parse_args()
repo=Path.cwd();out=repo/args.output_dir;out.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']}
child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/microsoft-mission-browser.mjs')]+([str(Path(args.package_dir).resolve())] if args.package_dir else [''])+['pages'],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
results=[]
try:
 line=child.stdout.readline()
 if not line:raise RuntimeError(child.stderr.read())
 ready=json.loads(line);assert ready['status']=='ready';assert ready['packaged']==bool(args.package_dir)
 def control(path):return json.loads(urllib.request.urlopen(ready['control']+path).read())
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
  try:
   for name,width in [(args.view,1440 if args.view=='desktop' else 390)]:
    control('/restore');page=browser.new_page(viewport={'width':width,'height':1050});errors=[];creates=[];runs=[];decisions=[];lost=[False];page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(ready['url']+'/') else route.abort())
    def track_create(route):
     if route.request.method=='POST':creates.append(route.request.post_data_json)
     route.continue_()
    def lose_run(route):
     if route.request.method!='POST':route.continue_();return
     runs.append(route.request.post_data_json);response=route.fetch();assert response.status==200
     value=response.json();print(json.dumps({'runStatus':value.get('status'),'reason':value.get('stopReason'),'error':value.get('lastError'),'observations':value.get('observations')},ensure_ascii=False),flush=True)
     if not lost[0]:lost[0]=True;route.abort('failed')
     else:route.fulfill(response=response)
    page.route('**/api/core/missions/*/gates/*/decision',lambda route:(decisions.append(route.request.post_data_json),route.continue_()));page.route('**/api/core/missions',track_create);page.route('**/api/core/missions/*/run',lose_run)
    page.goto(ready['url']+'/src/ui/connections/microsoft.html');expect(page.locator('[data-ms-select] option')).to_have_count(2)
    expect(page.locator('[data-ms-submit]')).to_be_disabled();page.locator('[data-ms-select]').select_option('synthetic-ui');expect(page.locator('[data-ms-submit]')).to_be_enabled()
    page.locator('[data-ms-scope]').select_option('pages');page.locator('[data-ms-limit]').fill('0');expect(page.locator('[data-ms-submit]')).to_be_disabled()
    page.locator('[data-ms-limit]').fill('51');expect(page.locator('[data-ms-submit]')).to_be_disabled();page.locator('[data-ms-limit]').fill('4');expect(page.locator('[data-ms-submit]')).to_be_enabled()
    held=[];page.route('**/api/core/personal-inbox/microsoft/progress',lambda route:held.append(route))
    page.locator('[data-ms-submit]').click();expect(page.locator('[data-ms-cancel]')).to_be_visible();page.locator('[data-ms-cancel]').click();expect(page.locator('[data-ms-status]')).to_contain_text('등록하기 전에 수집을 중단')
    assert len(held)==1 and len(creates)==0
    held[0].fulfill(status=200,json={'version':'personal-source-cursor-v1','provider':'outlook','present':False,'paginationComplete':None,'nextCursor':None});page.unroute('**/api/core/personal-inbox/microsoft/progress');page.locator('[data-ms-limit]').fill('4')
    original=page.locator('[data-ms-objective]').input_value();assert '전체 페이지' in original
    page.locator('[data-ms-objective]').fill(original+' 메일로 보내.');page.locator('[data-ms-submit]').click();expect(page.locator('[data-ms-status]')).to_contain_text('추가 지시를 생략');assert len(creates)==0
    page.locator('[data-ms-objective]').fill(original);page.locator('[data-ms-submit]').click();expect(page.locator('[data-ms-status]')).to_contain_text('새 요청은 보류');assert len(creates)==1 and len(runs)==1
    page.reload();page.locator('[data-ms-reconcile]').click();expect(page.locator('[data-ms-approve]')).to_be_visible();assert len(creates)==1 and len(runs)==1
    expect(page.locator('[data-ms-scope]')).to_have_value('pages');expect(page.locator('[data-ms-limit]')).to_have_value('4');expect(page.locator('[data-ms-limit]')).to_be_disabled()
    expect(page.locator('[data-ms-approval-scope]')).to_contain_text('최대 4페이지');page.screenshot(path=str(out/(name+'-approval.png')),full_page=True)
    graph_before=control('/stats')['graphCalls'];page.locator('[data-ms-approve]').click();expect(page.locator('[data-ms-status]')).to_contain_text('현재 저장 결과와 권한');expect(page.locator('[data-ms-results] article')).to_have_count(2)
    expect(page.locator('[data-ms-results]')).to_contain_text('현재 검증된 전체 페이지 · 3페이지');expect(page.locator('[data-ms-results]')).to_contain_text('스냅샷')
    expect(page.locator('[data-ms-results] h3').first).to_contain_text('<img src=x');assert page.locator('[data-ms-results] img').count()==0
    assert len(creates)==1 and len(runs)==2 and len(decisions)==1 and creates[0]['authorization']['grants']==['read_only','high_impact']
    assert creates[0]['budgets']=={'maxWaves':4,'maxActions':4};assert creates[0]['microsoftCollection']['maxPages']==4;assert control('/stats')['graphCalls']-graph_before==3
    before=control('/stats')['calls'];page.reload();page.locator('[data-ms-reconcile]').click();expect(page.locator('[data-ms-results] article')).to_have_count(2);assert control('/stats')['calls']==before
    page.evaluate("Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))")
    expect(page.locator('[data-ms-results]')).to_be_empty();expect(page.locator('[data-ms-status]')).to_contain_text('화면을 떠나')
    assert control('/stats')['calls']==before and len(creates)==1 and len(runs)==2
    page.evaluate("Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))")
    page.locator('[data-ms-reconcile]').click();expect(page.locator('[data-ms-results] article')).to_have_count(2)
    page.screenshot(path=str(out/(name+'-verified.png')),full_page=True)
    control('/revoke');page.locator('[data-ms-reconcile]').click()
    expect(page.locator('[data-ms-results]')).to_be_empty();expect(page.locator('[data-ms-status]')).to_contain_text('미검증')
    assert control('/stats')['calls']==before
    control('/restore');page.locator('[data-ms-reset]').click();expect(page.locator('[data-ms-scope]')).to_be_enabled()
    page.locator('[data-ms-limit]').fill('1');graph_before=control('/stats')['graphCalls'];page.locator('[data-ms-submit]').click();expect(page.locator('[data-ms-approve]')).to_be_visible();expect(page.locator('[data-ms-approval-scope]')).to_contain_text('최대 1페이지');page.locator('[data-ms-approve]').click()
    expect(page.locator('[data-ms-status]')).to_contain_text('전체 수집 완료가 아닙니다');expect(page.locator('[data-ms-progress]')).to_contain_text('1페이지 처리');expect(page.locator('[data-ms-results]')).to_be_empty();assert page.locator('[data-ms-resume]').count()==0
    assert control('/stats')['graphCalls']-graph_before==1 and len(creates)==2 and len(decisions)==2
    page.screenshot(path=str(out/(name+'-page-limit.png')),full_page=True)
    expect(page.locator('[data-ms-extend]')).to_be_visible();page.locator('[data-ms-extend-limit]').fill('1');expect(page.locator('[data-ms-extend]')).to_be_disabled()
    page.locator('[data-ms-extend-limit]').fill('51');expect(page.locator('[data-ms-extend]')).to_be_disabled();page.locator('[data-ms-extend-limit]').fill('3')
    extensions=[]
    def lose_extension(route):
     extensions.append(route.request.post_data_json);response=route.fetch();assert response.status==200;assert response.json()['microsoftCollectionPageLimit']==3;route.abort('failed')
    page.route('**/api/core/missions/*/extend-microsoft-collection',lose_extension)
    graph_extension=control('/stats')['graphCalls'];page.locator('[data-ms-extend]').click();expect(page.locator('[data-ms-status]')).to_contain_text('新 요청은 보류'.replace('新','새'))
    assert len(extensions)==1 and extensions[0]['expectedMaxPages']==1 and extensions[0]['maxPages']==3 and control('/stats')['graphCalls']==graph_extension
    page.reload();page.locator('[data-ms-reconcile]').click();expect(page.locator('[data-ms-status]')).to_contain_text('한도 변경을 저장');expect(page.locator('[data-ms-resume]')).to_be_visible()
    page.locator('[data-ms-resume]').click();expect(page.locator('[data-ms-approval-scope]')).to_contain_text('최대 3페이지');expect(page.locator('[data-ms-approve]')).to_be_visible()
    assert control('/stats')['graphCalls']==graph_extension and len(creates)==2 and len(decisions)==2
    page.screenshot(path=str(out/(name+'-extended-approval.png')),full_page=True)
    page.locator('[data-ms-approve]').click();expect(page.locator('[data-ms-results]')).to_contain_text('현재 검증된 전체 페이지 · 3페이지');expect(page.locator('[data-ms-results] article')).to_have_count(2)
    assert control('/stats')['graphCalls']-graph_extension==2 and len(creates)==2 and len(decisions)==3
    before=control('/stats')['calls'];page.reload();page.locator('[data-ms-reconcile]').click();expect(page.locator('[data-ms-results] article')).to_have_count(2);assert control('/stats')['calls']==before
    page.screenshot(path=str(out/(name+'-extended-verified.png')),full_page=True)
    overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth');assert not errors and not overflow
    results.append({'view':name,'realConfiguredCoreSqliteEBGMission':True,'syntheticProvider':True,'threePagesIncludingEmptyVerified':True,'scopedApprovalsForThreePages':1,'pageLimitStopsWithoutFalseCompletion':True,'sameMissionLimitExtensionRequiresFreshScope':True,'lostAmendmentRecoveredWithoutDuplicateCollection':True,'initialRequestLimitPreserved':True,'cancelDuringMockedProgressResponseCreatesNoMission':True,'originalRequestAndLimitRestoredAfterReload':True,'lostRunReconciledNoDuplicateCreate':True,'reloadResultNoProviderCall':True,'backgroundClearsContentNoExecution':True,'revokedClearsContent':True,'untrustedTitleEscaped':True,'creates':len(creates),'runs':len(runs),'pageErrors':errors,'horizontalOverflow':overflow});page.close()
  finally:browser.close()
finally:
 if child.poll() is None:
  child.stdin.write('stop\n');child.stdin.flush()
 child.communicate(timeout=30)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
