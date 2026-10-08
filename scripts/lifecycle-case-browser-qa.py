import argparse, importlib.util, json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
args=argparse.ArgumentParser();args.add_argument('--node',required=True);args=args.parse_args()
repo=Path.cwd();out=repo/'artifacts/lifecycle-case-ui-20261008-browser';out.mkdir(exist_ok=True)
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
    page=browser.new_page(viewport={'width':width,'height':1050});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(ready['url']+'/') else route.abort())
    page.goto(ready['url']+'/src/ui/workspace/lifecycle-cases.html')
    expect(page.locator('#case-list article')).to_have_count(20);page.locator('#case-more').click();expect(page.locator('#case-list article')).to_have_count(21 if name=='desktop' else 22)
    form=page.locator('#case-create');form.locator('[name=kind]').select_option('return');form.locator('[name=title]').fill('브라우저 반품 '+name);form.locator('[name=accountRef]').fill('합성');form.locator('[name=providerRef]').fill('browser-'+name);form.get_by_role('button',name='기록 등록').click()
    expect(page.locator('#case-detail h2')).to_have_text('브라우저 반품 '+name)
    obs=page.locator('[data-case-observation]');obs.locator('[name=status]').select_option('refunded');obs.locator('[name=observedAt]').fill('2026-10-06T12:00');obs.locator('[name=receiptRef]').fill('합성 증빙');obs.get_by_role('button',name='제공된 상태 저장').click();expect(page.locator('#case-detail summary')).to_have_text('제공된 기록 이력 (1건)')
    page.get_by_role('button',name='취소 의사 기록').click();expect(page.locator('#case-detail')).to_contain_text('외부 취소 요청 미발송');page.get_by_role('button',name='공식 창구 안내 준비').click();expect(page.locator('#case-detail summary')).to_have_text('제공된 기록 이력 (3건)')
    link=page.get_by_role('link',name='공식 창구 열기');assert link.get_attribute('href')=='https://help.shopify.com/en/manual/orders/refund-cancel-order/returns'
    page.locator('#case-detail summary').click();assert page.locator('#case-detail').inner_text().count('공급자 미검증')==3
    overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth');page.screenshot(path=str(out/(name+'.png')),full_page=True)
    page.reload();expect(page.locator('#case-list article')).to_have_count(20);page.locator('#case-list article').filter(has=page.get_by_role('heading',name='브라우저 반품 '+name,exact=True)).get_by_role('button').click();expect(page.locator('#case-detail summary')).to_have_text('제공된 기록 이력 (3건)')
    assert not errors and not overflow
    results.append({'view':name,'realCoreSqlite':True,'events':3,'providerVerified':False,'externalCalls':0,'reloadPersisted':True,'pageErrors':errors,'horizontalOverflow':overflow});page.close()
  finally:browser.close()
finally:
 child.stdin.write('stop\n');child.stdin.flush();child.communicate(timeout=30)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(results,ensure_ascii=False))
