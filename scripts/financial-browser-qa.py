import argparse,json,os,subprocess,tempfile,importlib.util,hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);parser.add_argument('--ofx',action='store_true');parser.add_argument('--file-picker',action='store_true');args=parser.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
with tempfile.TemporaryDirectory(prefix='jarvis-finance-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/knowledge-browser-product.mjs'),root],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready';workspace=Path(root)/'workspace'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for name,width in [('desktop',1440),('mobile',390)]:
     source=json.dumps({'transactions':[{'id':'one','accountRef':'test','paymentRef':'p1','kind':'charge','amountMinor':700,'currency':'KRW','category':'자료','source':'synthetic'}],'receipts':[],'budgets':[{'id':'b','category':'자료','currency':'KRW','limitMinor':600}]},ensure_ascii=False)
     if args.ofx:
      xml='<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>KRW</CURDEF><BANKACCTFROM><BANKID>test</BANKID><ACCTID>A</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261001</DTPOSTED><TRNAMT>-700</TRNAMT><FITID>one</FITID></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'
      txid='financial_'+hashlib.sha256(json.dumps(['test','A','one'],separators=(',',':')).encode()).hexdigest()
      source=json.dumps({'xml':xml,'currencyExponents':{'KRW':0},'classifications':[{'transactionId':txid,'sourceSha256':hashlib.sha256(xml.encode()).hexdigest(),'kind':'charge','category':'자료','paymentRef':'p'}],'receipts':[],'budgets':[{'id':'b','category':'자료','currency':'KRW','limitMinor':600}]},ensure_ascii=False)
     (workspace/(name+'.json')).write_text(source,encoding='utf-8')
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     if args.file_picker:
      selected=workspace/(name+'.ofx');selected.write_text(xml,encoding='utf-8')
      page.goto(ready['url']+'/src/ui/workspace/financial-import.html',wait_until='networkidle')
      page.locator('#ofx-file').set_input_files(str(selected));page.locator('#import-form button').click();page.wait_for_selector('#class-form',timeout=30000)
      page.locator('[name="kind-0"]').select_option('charge');page.locator('[name="category-0"]').fill('자료');page.locator('[name="paymentRef-0"]').fill('p');page.locator('#class-form button').click();expect(page.locator('#result pre')).to_contain_text('| 자료 | KRW | 700 | 0 | 700 | 미설정 | 미확인 |',timeout=30000)
      expect(page.locator('#result pre')).to_contain_text('receipt-missing')
      page.locator('[name="receiptAmount-0"]').fill('700');page.locator('[name="receiptSource-0"]').fill('synthetic-receipt');page.locator('[name="budgetCategory"]').fill('자료');page.locator('[name="budgetCurrency"]').fill('KRW');page.locator('[name="budgetLimit"]').fill('600');page.locator('#class-form button').click();expect(page.locator('#result pre')).to_contain_text('| 자료 | KRW | 700 | 0 | 700 | 600 | 예 |',timeout=30000);expect(page.locator('#result pre')).to_contain_text('일치 1건')
      page.evaluate("localStorage.setItem('jarvis.workspace.preferences',JSON.stringify({autoLocal:false}))")
      page.locator('[data-save-mission]').click();expect(page.locator('#save-status')).to_contain_text('저장하지 못했습니다',timeout=30000)
      page.evaluate("localStorage.setItem('jarvis.workspace.preferences',JSON.stringify({autoLocal:true}))")
      with page.expect_response(lambda r:r.request.method=='POST' and '/missions/' in r.url and r.url.endswith('/run'),timeout=60000) as saved_run:page.locator('[data-save-mission]').click()
      saved_mission=saved_run.value.json();assert saved_mission['status']=='COMPLETED'
      page.wait_for_selector('[data-saved-financial-report]',timeout=30000);expect(page.locator('[data-saved-financial-report] pre')).to_contain_text('| 자료 | KRW | 700 | 0 | 700 | 600 | 예 |')
      (out/(name+'-saved-mission.json')).write_text(json.dumps(saved_mission,ensure_ascii=False,indent=2),encoding='utf-8')
      assert len(list(workspace.glob('financial-input-*.json')))==(1 if name=='desktop' else 3)
      assert page.locator('[data-save-mission]').is_disabled()
      page.screenshot(path=str(out/(name+'-saved.png')),full_page=True)
      page.locator('#class-form button').click();expect(page.locator('#result pre')).to_contain_text('일치 1건',timeout=30000)
      lost_runs=[]
      def lose_run_response(route):
       response=route.fetch();lost_runs.append(response.json());route.abort()
      page.route('**/api/core/missions/*/run',lose_run_response)
      before_saved=len(list(workspace.glob('financial-input-*.json')))
      page.locator('[data-save-mission]').click();page.wait_for_selector('[data-save-recover]',timeout=60000)
      assert len(lost_runs)==1 and lost_runs[0]['status']=='COMPLETED'
      page.unroute('**/api/core/missions/*/run',lose_run_response)
      page.locator('[data-save-recover]').click();page.wait_for_selector('[data-saved-financial-report]',timeout=30000)
      assert len(list(workspace.glob('financial-input-*.json')))==before_saved+1
      page.screenshot(path=str(out/(name+'-response-recovery.png')),full_page=True)

      command=page.locator('[data-rerun-command]').input_value();assert 'jarvis-financial-input.json' in command and 'OFX 금융자료를 대사해' in command
      with page.expect_download() as bundle_download:page.locator('[data-download-bundle]').click()
      bundle_path=out/(name+'-input.json');bundle_download.value.save_as(str(bundle_path));saved=json.loads(bundle_path.read_text(encoding='utf-8'));assert saved['receipts'][0]['amountMinor']==700;assert saved['budgets'][0]['limitMinor']==600;assert saved['xml']==xml
      with page.expect_download() as report_download:page.locator('[data-download-report]').click()
      report_path=out/(name+'-report.md');report_download.value.save_as(str(report_path));assert '| 자료 | KRW | 700 | 0 | 700 | 600 | 예 |' in report_path.read_text(encoding='utf-8')
      reused=workspace/(name+'-reused.json');reused.write_bytes(bundle_path.read_bytes());before=reused.read_bytes()
      task_page=browser.new_page(viewport={'width':width,'height':1000});task_page.on('pageerror',lambda e:errors.append(str(e)));task_page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort());runs=[];task_page.on('response',lambda r:runs.append(r) if r.request.method=='POST' and '/missions/' in r.url and r.url.endswith('/run') else None)
      task_page.goto(ready['url'],wait_until='networkidle');task_page.wait_for_selector('#ws-command');task_page.locator('#ws-command').fill(f"'{name}-reused.json' OFX 금융자료를 대사해 '{name}-reused.md'에 저장하고 다시 읽어 확인해줘");task_page.locator('form[data-command] button.primary').click();task_page.wait_for_selector('[data-verified-financial-report]',timeout=60000)
      assert len(runs)==1;mission=runs[0].json();assert mission['status']=='COMPLETED';(out/(name+'-reused-mission.json')).write_text(json.dumps(mission,ensure_ascii=False,indent=2),encoding='utf-8')
      assert (workspace/(name+'-reused.md')).read_text(encoding='utf-8')==report_path.read_text(encoding='utf-8');assert reused.read_bytes()==before
      task_page.locator('[data-refresh]').click();task_page.wait_for_selector('[data-verified-financial-report]',timeout=30000);task_page.screenshot(path=str(out/(name+'-reused.png')),full_page=True);task_page.close()
      page.locator('[name="receiptAmount-0"]').fill('699');page.locator('#class-form button').click();expect(page.locator('#result pre')).to_contain_text('amount-mismatch',timeout=30000)
      page.locator('[name="category-0"]').fill('다른 범주');assert page.locator('#result pre').count()==0
      assert not errors;page.screenshot(path=str(out/(name+'.png')),full_page=True);results.append({'view':name,'filePicker':True,'automaticSettingRespected':True,'savedMissionCompleted':True,'lostRunRecoveredWithoutDuplicate':True,'classified':True,'missingReceiptVisible':True,'enteredReceiptMatched':True,'mismatchDetected':True,'budgetCompared':True,'bundleDownloaded':True,'reportDownloaded':True,'downloadedBundleMissionCompleted':True,'regeneratedReportEqualsDownload':True,'editHidesOldResult':True,'pageErrors':errors});page.close();continue
     page.goto(ready['url'],wait_until='networkidle');page.wait_for_selector('#ws-command');page.locator('#ws-command').fill(f"'{name}.json' {'OFX ' if args.ofx else ''}금융자료를 대사해 '{name}.md'에 저장하고 다시 읽어 확인해줘");page.locator('form[data-command] button.primary').click()
     page.wait_for_selector('[data-verified-financial-report]',timeout=60000);page.locator('[data-verified-financial-report] summary').click();expect(page.locator('[data-verified-financial-report] pre')).to_contain_text('| 자료 | KRW | 700 | 0 | 700 | 600 | 예 |')
     original=(workspace/(name+'.md')).read_bytes()
     (workspace/(name+'.md')).write_text('PRIVATE_TAMPERED_REPORT',encoding='utf-8')
     page.locator('[data-refresh]').click();page.wait_for_selector('[data-financial-report-unavailable]',timeout=30000)
     assert page.locator('[data-verified-financial-report]').count()==0
     assert 'PRIVATE_TAMPERED_REPORT' not in page.locator('body').inner_text()
     (workspace/(name+'.md')).write_bytes(original);page.locator('[data-refresh]').click();page.wait_for_selector('[data-verified-financial-report]',timeout=30000)
     (workspace/(name+'.json')).write_text(source+' ',encoding='utf-8');page.locator('[data-refresh]').click();page.wait_for_selector('[data-financial-report-unavailable]',timeout=30000)
     assert page.locator('[data-verified-financial-report]').count()==0
     (workspace/(name+'.json')).write_text(source,encoding='utf-8');page.locator('[data-refresh]').click();page.wait_for_selector('[data-verified-financial-report]',timeout=30000)
     assert (workspace/(name+'.md')).read_bytes()==original
     assert (workspace/(name+'.json')).read_text(encoding='utf-8')==source;assert not errors,errors
     page.screenshot(path=str(out/(name+'.png')),full_page=True);results.append({'view':name,'format':'ofx' if args.ofx else 'canonical','verified':True,'outputTamperHidden':True,'sourceChangeHidden':True,'restoredReverified':True,'pageErrors':errors});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')

