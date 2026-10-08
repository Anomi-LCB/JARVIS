import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
a=argparse.ArgumentParser();a.add_argument('--node',required=True);a.add_argument('--output',required=True);args=a.parse_args();out=Path(args.output);out.mkdir(exist_ok=False);results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-provider-removal-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/provider-removal-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for view,width in [('desktop',1440),('mobile',390)]:
     if view=='mobile':
      child.stdin.write('restart\n');child.stdin.flush();reply=json.loads(child.stdout.readline());assert reply['status']=='restarted' and reply['externalCalls']==0
     for kind,count in [('api',3),('agents',1)]:
      page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
      page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
      page.goto(ready['url']+'/src/ui/connections/'+kind+'.html',wait_until='networkidle')
      if view=='desktop':
       expect(page.locator('[data-remove]')).to_have_count(count,timeout=15000)
       for remaining in range(count-1,-1,-1):
        page.locator('[data-remove]').first.click();expect(page.locator('[data-remove]')).to_have_count(remaining,timeout=15000)
      expect(page.locator('[data-remove]')).to_have_count(0);expect(page.locator('body')).to_contain_text('로컬 키 삭제는 제공자 계정의 권한 철회를 대신하지 않습니다')
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');assert not errors
      public=page.evaluate("async()=>{const r=await fetch('/api/core/integrations');return await r.json();}")
      assert not any(x['connectorId'].startswith('jarvis-model-') if kind=='api' else x['connectorId']=='jarvis-openai-agents' for x in public['connections'])
      assert 'synthetic-private-' not in json.dumps(public)
      page.screenshot(path=str(out/(view+'-'+kind+'-removed.png')),full_page=True);results.append({'view':view,'kind':kind,'localDpapiDeletionObserved':True,'afterRestart':view=='mobile','providerGrantRevocationNotClaimed':True,'pageErrors':errors});page.close()
   finally:browser.close()
  assert b'synthetic-private-' not in Path(root,'credentials.dpapi.json').read_bytes()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps({'flows':results,'actualDpapi':True,'syntheticProviders':True,'realProviderCalls':0,'productionActivation':False},ensure_ascii=False,indent=2),encoding='utf-8')
