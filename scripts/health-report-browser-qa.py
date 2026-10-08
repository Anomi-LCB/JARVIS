"""Actual UI/Core/remote B/G health report; synthetic records, no response mocks."""
import argparse,hashlib,importlib.util,json,os,subprocess,tempfile
from pathlib import Path
from datetime import datetime,timezone
from urllib.request import urlopen
from urllib.error import HTTPError
from urllib.parse import quote
from playwright.sync_api import sync_playwright,expect
spec=importlib.util.spec_from_file_location('qa',Path(__file__).with_name('control-center-browser-qa.py'));qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
repo=Path(__file__).resolve().parent.parent;out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
record={'recordId':'one','metric':'heart_rate','value':70,'unit':'bpm','observedAt':'2026-02-20T12:00:00Z','source':'synthetic-watch','sensorId':'A','dataOrigin':'test.app','recordingMethod':2}
results=[];task_ids=[]
with tempfile.TemporaryDirectory(prefix='jarvis-health-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}}
 env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/discovered-summary-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready',ready
  workspace=Path(root)/'workspace'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True,args=['--disable-extensions','--disable-background-networking'])
   try:
    for name,viewport,bad in [('desktop',{'width':1440,'height':1000},False),('mobile-conflict',{'width':390,'height':844},True)]:
     source=json.dumps({'records':[record,dict(record,value=90)] if bad else [record]},ensure_ascii=False)
     (workspace/(name+'.json')).write_text(source,encoding='utf-8')
     objective=f"'{name}.json' 건강 기록을 '2026-02-20'부터 '2026-02-20'까지 요약해 '{name}.md'에 저장하고 다시 읽어 확인해줘"
     page=browser.new_page(viewport=viewport);errors=[];responses=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     page.on('response',lambda r:responses.append(r) if r.request.method=='POST' and '/missions/' in r.url and r.url.endswith('/run') else None)
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('#ws-command',timeout=20000)
     page.locator('#ws-command').fill(objective);page.locator('form[data-command] button.primary').click()
     expect(page.locator('form[data-command] button.primary')).to_be_enabled(timeout=60000)
     assert len(responses)==1,len(responses)
     result=responses[0].json();(out/(name+'-mission.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
     if bad:
      assert result['status']!='COMPLETED',result['status'];assert not (workspace/(name+'.md')).exists()
      page.wait_for_selector('[data-workflow-failure]');assert '기록 ID' in page.locator('[data-workflow-failure]').inner_text()
     else:
      assert result['status']=='COMPLETED',result['status']
      report=(workspace/(name+'.md')).read_text(encoding='utf-8');assert '| 2026-02-20 | 1 | 70 | 70 | 70 | 없음 | 없음 |' in report
      assert '진단·치료 권고가 아닙니다' in report
      (out/'generated-report.md').write_text(report,encoding='utf-8')
      task_ids.extend(a['taskId'] for w in result['waves'] for a in w['actions'] if a.get('status')=='succeeded')
      assert any(o['toolName']=='workflow.execute' and o['verification']['status']=='passed' for o in result['observations'])
      page.wait_for_selector('[data-verified-health-report]');page.locator('[data-verified-health-report] summary').click()
      assert page.locator('[data-verified-health-report] table').count()==1
      assert '70' in page.locator('[data-verified-health-report] table').inner_text()
      try:urlopen(ready['coreUrl']+'/missions/'+quote(result['missionId'],safe='')+'/verified-health-report');raise AssertionError('unauthenticated health report accepted')
      except HTTPError as error:assert error.code in [401,403]
     assert (workspace/(name+'.json')).read_text(encoding='utf-8')==source
     overflow=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)');assert overflow==0;assert not errors,errors
     page.screenshot(path=str(out/(name+'.png')),full_page=True)
     if not bad:
      (workspace/(name+'.md')).write_text(report.replace('| 70 |','| 999 |'),encoding='utf-8')
      page.locator('.ws-task-header .ws-actions button').first.click();page.wait_for_selector('[data-health-report-unavailable]')
      assert page.locator('[data-verified-health-report]').count()==0
      page.screenshot(path=str(out/(name+'-changed.png')),full_page=True)
     results.append({'view':name,'status':result['status'],'horizontalOverflowPx':overflow,'pageErrors':errors,'responseMocked':False})
     page.close()
   finally:browser.close()
  packets=(Path(root)/'audit'/'packets.jsonl').read_bytes();assert task_ids and all(x.encode() in packets for x in task_ids)
  (out/'report.json').write_text(json.dumps({'observedAt':datetime.now(timezone.utc).isoformat(),'results':results,'isolatedServices':ready['services'],'successfulTaskIdsMatchedRemoteJournal':len(task_ids),'packetJournalSha256':hashlib.sha256(packets).hexdigest()},ensure_ascii=False,indent=2),encoding='utf-8')
 finally:
  if child.poll() is None:child.stdin.write('stop\n');child.stdin.flush();child.wait(timeout=20)
print(json.dumps({'passed':len(results),'responseMocked':False}))
