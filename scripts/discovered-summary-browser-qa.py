"""Real UI requests to isolated Core and remote B; no mocked API responses."""
import argparse,hashlib,importlib.util,json,os,subprocess,tempfile
from pathlib import Path
from datetime import datetime,timezone
from urllib.request import urlopen
from urllib.error import HTTPError
from urllib.parse import quote
from playwright.sync_api import sync_playwright
spec=importlib.util.spec_from_file_location('qa',Path(__file__).with_name('control-center-browser-qa.py'));qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
repo=Path(__file__).resolve().parent.parent;out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
source='장비 도입 기록: 견적 금액은 450000원이고 결제는 하지 않았다. 공급 업체는 다음 주 납품이 가능할 것으로 예상하지만 확정일은 제시하지 않았다. 승인 여부: 미승인. 실제 지출액은 0원이다.'
results=[];remote_task_ids=[]
with tempfile.TemporaryDirectory(prefix='jarvis-discovery-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}}
 env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/discovered-summary-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready',ready
  workspace=Path(root)/'workspace'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True,args=['--disable-extensions','--disable-background-networking'])
   try:
    for name,viewport,duplicate in [('desktop',{'width':1440,'height':1000},False),('mobile-duplicate',{'width':390,'height':844},True)]:
     folder=workspace/name; (folder/'nested').mkdir(parents=True); (folder/'nested'/'source.txt').write_text(source,encoding='utf-8')
     if duplicate:(folder/'source.txt').write_text(source,encoding='utf-8')
     objective=f"'{name}' 폴더에서 'source.txt' 파일을 찾아 항목 '실제 지출액'의 '원' 단위 숫자, '승인 여부'의 승인 상태, '확정일'의 미정 여부를 정리해 '{name}/result.json'에 JSON으로 저장하고 다시 읽어 확인해줘"
     page=browser.new_page(viewport=viewport);errors=[];responses=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.on('response',lambda r:responses.append(r) if r.request.method=='POST' and '/missions/' in r.url and r.url.endswith('/run') else None)
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('#ws-command',timeout=20000)
     if page.locator('form[data-command] button.primary').is_disabled():
      (out/(name+'-disabled.txt')).write_text(page.locator('body').inner_text(),encoding='utf-8')
      page.screenshot(path=str(out/(name+'-disabled.png')),full_page=True)
     page.locator('#ws-command').fill(objective);page.locator('form[data-command] button.primary').click()
     page.wait_for_function("() => !document.querySelector('form[data-command] button.primary').disabled",timeout=45000)
     assert len(responses)==1,len(responses)
     result=responses[0].json();(out/(name+'-mission.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
     try:
      urlopen(ready['coreUrl']+'/missions/'+quote(result['missionId'],safe='')+'/verified-fields',timeout=5);raise AssertionError('Anonymous preview was allowed')
     except HTTPError as denied:assert denied.code in [401,403]
     if duplicate:
      assert result['status']!='COMPLETED',result['status'];assert not (folder/'result.json').exists()
      assert page.locator('[data-workflow-failure]').count()==1
      assert '대상 개수' in page.locator('[data-workflow-failure]').inner_text()
     else:
      assert result['status']=='COMPLETED',json.dumps({'status':result.get('status'),'reason':result.get('stopReason'),'observations':result.get('observations')},ensure_ascii=False)
      actual=json.loads((folder/'result.json').read_text(encoding='utf-8'));assert actual['facts']=={'field1':'0','field2':'미승인','field3':'미정'}
      assert any(o.get('verification',{}).get('status')=='passed' for o in result.get('observations',[]) if o.get('toolName')=='workflow.execute')
      remote_task_ids.extend(a['taskId'] for w in result['waves'] for a in w['actions'] if a.get('status')=='succeeded')
      assert page.locator('.ws-task-header .ws-actions button').first.bounding_box()['height']<=48
      page.wait_for_selector('[data-verified-fields]');assert page.locator('[data-verified-fields] dt').count()==3
      assert '미승인' in page.locator('[data-verified-fields]').inner_text()
     assert (folder/'nested'/'source.txt').read_text(encoding='utf-8')==source
     overflow=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)')
     page.screenshot(path=str(out/(name+'.png')),full_page=True)
     assert overflow==0,overflow;assert not errors,errors
     if not duplicate:
      actual['facts']['field1']='999';(folder/'result.json').write_text(json.dumps(actual,ensure_ascii=False),encoding='utf-8')
      page.locator('.ws-task-header .ws-actions button').first.click();page.wait_for_selector('[data-field-summary-unavailable]')
      assert page.locator('[data-verified-fields]').count()==0
      page.screenshot(path=str(out/(name+'-changed.png')),full_page=True)
     results.append({'view':name,'status':result['status'],'resultPresent':(folder/'result.json').exists(),'horizontalOverflowPx':overflow,'pageErrors':errors,'responseMocked':False})
     page.close()
   finally:browser.close()
  packet=Path(root)/'audit'/'packets.jsonl';assert packet.exists(),'Remote B packet journal missing'
  packet_bytes=packet.read_bytes();assert remote_task_ids and all(task_id.encode() in packet_bytes for task_id in remote_task_ids)
  (out/'report.json').write_text(json.dumps({'observedAt':datetime.now(timezone.utc).isoformat(),'results':results,'isolatedServices':ready['services'],'remoteBJournalPresent':True,'successfulTaskIdsMatchedRemoteJournal':len(remote_task_ids),'packetJournalSha256':hashlib.sha256(packet_bytes).hexdigest()},ensure_ascii=False,indent=2),encoding='utf-8')
 finally:
  if child.poll() is None:child.stdin.write('stop\n');child.stdin.flush();child.wait(timeout=20)
print(json.dumps({'passed':len(results),'responseMocked':False}))
