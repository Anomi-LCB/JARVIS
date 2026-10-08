import argparse, importlib.util, json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
args=argparse.ArgumentParser();args.add_argument('--node',required=True);args=args.parse_args()
repo=Path.cwd();out=repo/'artifacts/lifecycle-case-reload-20261008-browser';out.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']}
child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/lifecycle-case-browser.mjs')],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
results=[]
try:
 ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
  try:
   for name,width in [('desktop',1440),('mobile',390)]:
    page=browser.new_page(viewport={'width':width,'height':1050});errors=[];bodies=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(ready['url']+'/') else route.abort())
    def lose_response(route):
     if route.request.method!='POST':route.continue_();return
     bodies.append(route.request.post_data_json);response=route.fetch();assert response.status==200
     if len(bodies)==1:route.abort('failed')
     else:route.fulfill(response=response)
    page.route('**/api/core/personal-operations/cases',lose_response)
    page.goto(ready['url']+'/src/ui/workspace/lifecycle-cases.html');expect(page.locator('#case-list article')).to_have_count(20)
    form=page.locator('#case-create');form.locator('[name=title]').fill('불명 응답 복구 '+name);form.locator('[name=accountRef]').fill('합성');form.locator('[name=providerRef]').fill('lost-'+name);form.get_by_role('button',name='기록 등록').click()
    expect(page.locator('#case-message')).to_contain_text('새 기록은 보류');expect(page.locator('#case-retry')).to_be_visible();expect(form.get_by_role('button')).to_be_disabled()
    page.reload();expect(page.locator('#case-message')).to_contain_text('이전 기록 요청의 결과가 미확인');expect(page.locator('#case-retry')).to_be_visible();expect(page.locator('#case-create button')).to_be_disabled()
    page.locator('#case-retry').click();expect(page.locator('#case-detail h2')).to_have_text('불명 응답 복구 '+name);expect(page.locator('#case-retry')).to_be_hidden();expect(page.locator('#case-create button')).to_be_enabled()
    assert len(bodies)==2 and bodies[0]==bodies[1] and bodies[0]['expectedStoreId']
    matching=page.locator('#case-list article').filter(has=page.get_by_role('heading',name='불명 응답 복구 '+name,exact=True));expect(matching).to_have_count(1)
    page.reload();expect(page.locator('#case-retry')).to_be_hidden();expect(page.locator('#case-create button')).to_be_enabled()
    overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth');assert not errors and not overflow
    page.screenshot(path=str(out/(name+'.png')),full_page=False)
    results.append({'view':name,'realCoreSqlite':True,'lostAfterServerCommit':True,'sameRequestAfterReload':True,'posts':2,'duplicates':0,'externalCalls':0,'pageErrors':errors,'horizontalOverflow':overflow});page.close()
  finally:browser.close()
finally:
 child.stdin.write('stop\n');child.stdin.flush();child.communicate(timeout=30)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
