import argparse,importlib.util,json,os,subprocess,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--output',required=True);args=p.parse_args()
repo=Path(__file__).resolve().parent.parent;out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
rows=[]
for name,viewport in [('desktop',{'width':1440,'height':1000}),('mobile',{'width':390,'height':844})]:
 stderr=(out/(name+'-stderr.txt')).open('x',encoding='utf-8')
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/read-role-editor-browser.mjs')],cwd=repo,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  def observed():
   with urllib.request.urlopen(ready['control'],timeout=10) as r:return json.load(r)
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True,args=['--disable-extensions','--disable-background-networking'])
   try:
    page=browser.new_page(viewport=viewport);errors=[];requests=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('request',lambda request:requests.append(request.post_data_json) if request.method=='POST' and '/goal-revisions' in request.url else None)
    page.goto(ready['url']+'/#tasks',wait_until='networkidle');page.locator('[data-task="'+ready['missionId']+'"]').first.click()
    page.locator('details').filter(has=page.locator('form[data-revision]')).locator('summary').click()
    before=observed();assert before['reads']==1 and before['writes']==0
    roles=page.locator('[data-criterion-role]');assert roles.count()==2
    assert roles.evaluate_all('(es)=>es.map(e=>e.value)')==['output','output']
    page.locator('#ws-revision').fill("'source.txt'를 읽어; 'protected.txt'를 읽어; 'protected.txt'는 삭제하지 마")
    roles.nth(0).select_option('input');roles.nth(1).select_option('input')
    page.screenshot(path=str(out/(name+'-editor.png')),full_page=True)
    page.locator('form[data-revision] button').click();page.locator('[data-resume]').wait_for()
    revised=observed()['mission'];assert revised['goalContract']['revision']==2
    assert revised['successCriteria'][0]['verificationSpec']==before['mission']['successCriteria'][0]['verificationSpec']
    assert revised['goalRevisionHistory'][0]['successCriteria']==before['mission']['successCriteria']
    assert len(requests)==1 and [c['artifactRole'] for c in requests[0]['successCriteria']]==['input','input']
    page.locator('[data-resume]').click();page.wait_for_function('() => !document.querySelector("[data-resume]")')
    final=observed();assert final['mission']['status']=='COMPLETED',final['mission']['stopReason']
    assert final['reads']==3 and final['writes']==0 and final['mission']['authorization']['grants']==['read_only']
    assert not errors,errors
    overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth+1');assert not overflow
    page.screenshot(path=str(out/(name+'-completed.png')),full_page=True)
    rows.append({'view':name,'actualCoreEBGSqlite':True,'status':'COMPLETED','reads':final['reads'],'writes':0,'revisionRequests':len(requests),'pageErrors':errors,'overflow':overflow,'originalGoalCompleted':False,'explicitlyRevisedGoalCompleted':True})
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush();child.wait(timeout=30);stderr.close()
(out/'report.json').open('x',encoding='utf-8').write(json.dumps(rows,ensure_ascii=False,indent=2))
print(json.dumps(rows,ensure_ascii=False))
