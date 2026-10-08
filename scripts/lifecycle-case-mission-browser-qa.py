import argparse, importlib.util, json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
args=argparse.ArgumentParser();args.add_argument('--node',required=True);args.add_argument('--output-dir',default='artifacts/lifecycle-case-mission-ui-20261008-browser');args=args.parse_args()
repo=Path.cwd();out=repo/args.output_dir;out.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']}
child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/lifecycle-case-mission-browser.mjs')],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
results=[]
try:
 ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
  try:
   for name,width in [('desktop',1440),('mobile',390)]:
    page=browser.new_page(viewport={'width':width,'height':1050});errors=[];creates=[];runs=[];lost=[False];page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(ready['url']+'/') else route.abort())
    def track_create(route):
     if route.request.method=='POST':creates.append(route.request.post_data_json)
     route.continue_()
    def lose_run(route):
     if route.request.method!='POST':route.continue_();return
     runs.append(route.request.post_data_json);response=route.fetch();assert response.status==200
     if not lost[0]:lost[0]=True;route.abort('failed')
     else:route.fulfill(response=response)
    page.route('**/api/core/missions',track_create);page.route('**/api/core/missions/*/run',lose_run)
    page.goto(ready['url']+'/src/ui/workspace/lifecycle-cases.html');expect(page.locator('#case-list article')).to_have_count(1)
    expect(page.locator('#case-mission-submit')).to_be_disabled();page.get_by_role('button',name='기록 보기',exact=True).click();expect(page.locator('#case-mission-submit')).to_be_enabled()
    original=page.locator('#case-mission-objective').input_value();page.locator('#case-mission-objective').fill(original+' 메일로 보내.');page.locator('#case-mission-submit').click();expect(page.locator('#case-mission-message')).to_contain_text('추가 지시를 생략');assert len(creates)==0
    page.locator('#case-mission-objective').fill(original);page.locator('#case-mission-submit').click();expect(page.locator('#case-mission-message')).to_contain_text('새 요청은 보류');assert len(creates)==1 and len(runs)==1
    page.reload();expect(page.locator('#case-mission-reconcile')).to_be_visible();page.locator('#case-mission-reconcile').click()
    try:expect(page.locator('#case-mission-message')).to_contain_text('현재 원장으로 검증')
    except Exception:
     print('synthetic-recovery-failed',page.locator('#case-mission-message').inner_text(),flush=True)
     raise
    expect(page.locator('#case-mission-result h3')).to_have_text('합성 배송 조회');assert len(creates)==1 and len(runs)==1
    expect(page.locator('#case-mission-result')).to_contain_text('공급자 확인: 미검증');page.screenshot(path=str(out/(name+'-verified.png')),full_page=True)
    page.get_by_role('button',name='기록 보기',exact=True).click();page.get_by_role('button',name='취소 의사 기록',exact=True).click();expect(page.locator('#case-detail')).to_contain_text('취소 의사만 기록됨');page.locator('#case-mission-refresh').click();expect(page.locator('#case-mission-message')).to_contain_text('현재 결과는 미검증');expect(page.locator('#case-mission-result')).to_be_empty()
    assert creates[0]['authorization']['grants']==['read_only'];assert creates[0]['metadata']['longTermMemory'] is False
    overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth');assert not errors and not overflow
    page.screenshot(path=str(out/(name+'-changed.png')),full_page=True)
    # Now lose the create response: reconciliation must show CREATED without running it.
    create_lost=[False]
    def lose_create(route):
     if route.request.method!='POST':route.continue_();return
     creates.append(route.request.post_data_json);response=route.fetch();assert response.status==201
     if not create_lost[0]:create_lost[0]=True;route.abort('failed')
     else:route.fulfill(response=response)
    page.route('**/api/core/missions',lose_create)
    page.get_by_role('button',name='기록 보기',exact=True).click();page.locator('#case-mission-submit').click();expect(page.locator('#case-mission-message')).to_contain_text('새 요청은 보류');assert len(creates)==2 and len(runs)==1
    page.reload();page.locator('#case-mission-reconcile').click();expect(page.locator('#case-mission-message')).to_contain_text('등록됐지만 실행되지');expect(page.locator('#case-mission-continue')).to_be_visible();assert len(creates)==2 and len(runs)==1
    page.locator('#case-mission-continue').click();expect(page.locator('#case-mission-message')).to_contain_text('현재 원장으로 검증');assert len(creates)==2 and len(runs)==2
    assert not errors and not page.evaluate('document.documentElement.scrollWidth>innerWidth')
    results.append({'view':name,'realCoreSqliteMissionEBG':True,'configuredService':ready.get('configuredService',False),'lostRunAfterCompletion':True,'reloadReconcileNoRedispatch':True,'lostCreateNoImplicitRun':True,'explicitContinueCreated':True,'missionCreates':len(creates),'missionRuns':len(runs),'intents':2,'changedSourceClearsContent':True,'unsupportedTailCreates':0,'grants':['read_only'],'pageErrors':errors,'horizontalOverflow':overflow});page.close()
  finally:browser.close()
finally:
 child.stdin.write('stop\n');child.stdin.flush();child.communicate(timeout=30)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
