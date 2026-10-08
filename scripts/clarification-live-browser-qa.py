"""Actual workspace + configured Core/E/PC/G + SQL. Only planner is scripted."""
import argparse,importlib.util,json,os,subprocess,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);parser.add_argument('--reproduce',action='store_true');parser.add_argument('--ui-package');parser.add_argument('--revise',action='store_true');parser.add_argument('--deny',action='store_true');parser.add_argument('--restart',action='store_true');parser.add_argument('--deferred-answer',action='store_true');parser.add_argument('--crash',action='store_true');args=parser.parse_args()
repo=Path(__file__).resolve().parent.parent;out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=False)
spec=importlib.util.spec_from_file_location('qa',Path(__file__).with_name('control-center-browser-qa.py'));qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}}
rows=[]
for name,viewport in [('desktop',{'width':1440,'height':1000}),('mobile',{'width':390,'height':844})]:
 stderr=(out/(name+'-fixture-stderr.txt')).open('w',encoding='utf-8')
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/('tests/fixtures/clarification-restart-browser.mjs' if args.restart else 'tests/fixtures/clarification-live-browser.mjs'))]+([args.ui_package] if args.ui_package else []),cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  def observed():
   with urllib.request.urlopen(ready['control'],timeout=5) as r:return json.load(r)
  def restarted(crash=False):
   with urllib.request.urlopen(urllib.request.Request(ready['control']+('/crash' if crash else '/restart'),data=b'',method='POST'),timeout=50) as r:return json.load(r)
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True,args=['--disable-extensions','--disable-background-networking'])
   try:
    page=browser.new_page(viewport=viewport);errors=[];decisions=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('request',lambda request:decisions.append(request.post_data_json) if '/gates/' in request.url and request.method=='POST' else None)
    page.goto(ready['url']+'/#tasks',wait_until='networkidle')
    page.locator('[data-task="'+ready['missionId']+'"]').first.click()
    inputs=page.locator('textarea[name="clarificationAnswer"]');inputs.first.wait_for();assert inputs.count()==2
    assert observed()['reads']==1 and observed()['writes']==0
    inputs.nth(0).fill('항목 전체');inputs.nth(1).fill('검증 보고')
    page.locator('[data-refresh]').click();page.wait_for_function('() => !document.querySelector("[data-refresh]").disabled')
    values=inputs.evaluate_all('(elements)=>elements.map(e=>e.value)')
    if args.reproduce:
     rows.append({'view':name,'draftsAfterRefresh':values,'expected':['항목 전체','검증 보고'],'lost':values!=['항목 전체','검증 보고'],'reads':observed()['reads'],'writes':observed()['writes']});continue
    assert values==['항목 전체','검증 보고'],values
    assert len(decisions)==0 and observed()['reads']==1 and observed()['writes']==0
    if args.restart:
     before=observed();after=restarted(args.crash)
     if args.crash:assert len(after['failedTakeovers'])==1 and after['failedTakeovers'][0]['beforeExpiry']
     assert after['pid']!=before['pid'] and after['keySha256']==before['keySha256'] and after['authority']['token']==before['authority']['token']+1
     assert after['mission']['pendingGates']==before['mission']['pendingGates'] and after['mission']['authorization']==before['mission']['authorization']
     page.locator('[data-refresh]').click();page.wait_for_function('() => !document.querySelector("[data-refresh]").disabled')
     assert inputs.evaluate_all('(elements)=>elements.map(e=>e.value)')==['항목 전체','검증 보고']
     assert observed()['reads']==1 and observed()['writes']==0 and len(decisions)==0
    if args.deny:
     page.locator('[data-deny]').click();page.wait_for_function('() => document.querySelectorAll("form[data-gate]").length===0')
     current=observed();assert current['mission']['status']=='CANCELLED' and current['writes']==0 and current['content'] is None,current
     assert len(decisions)==1 and decisions[0]['decision']=='reject' and 'answers' not in decisions[0]
     page.reload(wait_until='networkidle');page.locator('[data-task="'+ready['missionId']+'"]').first.click()
     assert not page.locator('form[data-gate]').count() and observed()['reads']==1 and observed()['writes']==0
     page.screenshot(path=str(out/(name+'-cancelled.png')),full_page=True)
     assert not errors
     rows.append({'view':name,'actualCoreEBGSQL':True,'status':'CANCELLED','reads':1,'writes':0,'answerRequests':0,'rejectRequests':1,'reloadNoExecution':True,'pageErrors':errors});continue
    if args.revise:
     old_gate=observed()['mission']['pendingGates'][0]['gateId']
     page.locator('details').filter(has=page.locator('form[data-revision]')).locator('summary').click()
     page.locator('#ws-revision').fill("'source.txt'를 읽어; 'result.txt' 파일을 저장해")
     page.locator('form[data-revision] button').click()
     page.locator('[data-review-criteria]').wait_for();assert not page.locator('[data-resume]').count()
     unreviewed=observed();assert unreviewed['mission']['stopReason']=='goal-revision-criteria-review' and unreviewed['writes']==0
     prior_spec=unreviewed['mission']['successCriteria'][0]['verificationSpec']
     page.locator('[data-review-criteria]').click();page.locator('input[name="confirmExistingCriteria"]').check()
     page.locator('form[data-revision] button').click()
     page.wait_for_function('() => document.querySelector("[data-resume]") !== null')
     page.locator('[data-resume]').click();inputs.first.wait_for()
     assert inputs.evaluate_all('(elements)=>elements.map(e=>e.value)')==['','']
     revised=observed();assert revised['mission']['goalContract']['revision']==3 and revised['mission']['pendingGates'][0]['gateId']!=old_gate
     assert revised['mission']['successCriteria'][0]['verificationSpec']==prior_spec
     assert revised['writes']==0 and len(decisions)==0
     inputs.nth(0).fill('항목 전체');inputs.nth(1).fill('검증 보고')
    inputs.nth(1).fill('');page.locator('form[data-gate] button.primary').click();assert len(decisions)==0
    inputs.nth(1).fill('검증 보고');page.screenshot(path=str(out/(name+'-waiting.png')),full_page=True)
    if args.deferred_answer:
     assert args.restart and not args.revise
     pending=observed()['mission']['pendingGates'][0]
     result=page.evaluate("""async ({missionId,gateId})=>{const form=document.querySelector('form[data-gate]');const answers=[...form.querySelectorAll('textarea')].map(i=>i.value);
       const response=await fetch('/api/core/missions/'+encodeURIComponent(missionId)+'/gates/'+encodeURIComponent(gateId)+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'approve',answers,resume:false})});return response.json();}""",{'missionId':ready['missionId'],'gateId':pending['gateId']})
     assert result['status']=='PAUSED' and observed()['writes']==0,result
     saved=observed();restored=restarted();assert restored['pid']!=saved['pid'] and restored['mission']['gates']==saved['mission']['gates']
     page.locator('[data-refresh]').click();page.wait_for_function('() => document.querySelector("[data-resume]") !== null')
     assert not page.locator('form[data-gate]').count()
     page.locator('[data-resume]').click()
    else:page.locator('form[data-gate] button.primary').click()
    page.wait_for_function('() => document.querySelectorAll("form[data-gate]").length===0 && !document.querySelector("[data-resume]")')
    current=observed();assert current['mission']['status']=='COMPLETED',current
    assert current['reads']==1 and current['writes']==1 and current['content']=='검증 보고\n항목 전체\n합성 자료: 관측 3건',current
    assert len(decisions)==1 and decisions[0]['answers']==['항목 전체','검증 보고'],decisions
    if args.restart:
     completed=current;restored=restarted();assert restored['pid']!=completed['pid'] and restored['keySha256']==completed['keySha256']
     assert restored['mission']['status']=='COMPLETED' and restored['reads']==1 and restored['writes']==1 and restored['content']==current['content']
    page.reload(wait_until='networkidle');page.locator('[data-task="'+ready['missionId']+'"]').first.click();page.wait_for_timeout(150)
    assert observed()['reads']==1 and observed()['writes']==1 and not page.locator('form[data-gate]').count()
    overflow=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)');assert overflow==0 and not errors,(overflow,errors)
    page.screenshot(path=str(out/(name+'-completed.png')),full_page=True)
    rows.append({'view':name,'actualCoreEBGSQL':True,'actualCorePidRestart':args.restart,'actualCrash':args.crash,'failedTakeovers':observed().get('failedTakeovers',[]),'answerStoredBeforeRestart':args.deferred_answer,'processHistory':observed().get('history',[]),'answersPreservedOnRefresh':True,'revisionDraftCleared':args.revise,'missingAnswerRequests':0,'answerRequests':1,'status':current['mission']['status'],'reads':1,'writes':1,'reloadNoExecution':True,'horizontalOverflowPx':overflow,'pageErrors':errors})
   except Exception:
    (out/(name+'-failure-state.json')).write_text(json.dumps(observed(),ensure_ascii=False,indent=2),encoding='utf-8')
    page.screenshot(path=str(out/(name+'-failure.png')),full_page=True)
    raise
   finally:browser.close()
 finally:
  if child.poll() is None:
   child.stdin.write('stop\n');child.stdin.flush()
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:child.kill();child.wait(timeout=10)
  stderr.close()
(out/'result.json').write_text(json.dumps({'views':rows,'scope':'actual HTTP/UI/Core/E/PC/G/SQLite; scripted planner, synthetic file, no API interception or UI injection; '+('separate Core PID restart verified; no SCM or OS reboot' if args.restart else 'not a separate Core PID restart')+'; not installed build','cost':'미측정'},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(rows,ensure_ascii=False))
