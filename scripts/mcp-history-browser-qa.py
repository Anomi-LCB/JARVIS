import argparse,json,os,subprocess,tempfile,importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
repo=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('qa',repo/'scripts/control-center-browser-qa.py');qa=importlib.util.module_from_spec(spec);spec.loader.exec_module(qa)
parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();out=Path(args.output);out.mkdir(exist_ok=False)
results=[]
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from threading import Thread
class MCP(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  rpc=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  result={'tools':[{'name':'sum','inputSchema':{'type':'object','properties':{'a':{'type':'integer'},'b':{'type':'integer'}},'required':['a','b'],'additionalProperties':False}}]} if rpc['method']=='tools/list' else {'content':[{'type':'text','text':str(rpc['params']['arguments']['a']+rpc['params']['arguments']['b'])}]}
  raw=json.dumps({'jsonrpc':'2.0','id':rpc['id'],'result':result}).encode();self.send_response(200);self.send_header('content-type','application/json');self.send_header('content-length',str(len(raw)));self.end_headers();self.wfile.write(raw)
mcp=ThreadingHTTPServer(('127.0.0.1',0),MCP);Thread(target=mcp.serve_forever,daemon=True).start()

with tempfile.TemporaryDirectory(prefix='jarvis-notification-ui-') as root:
 env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'}};env.update({k:root for k in ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']})
 child=subprocess.Popen([str(Path(args.node).resolve()),str(repo/'tests/fixtures/knowledge-browser-product.mjs'),root,'mcp-history'],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  ready=json.loads(child.stdout.readline());assert ready['status']=='ready'
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=qa.resolve_chrome(''),headless=True)
   try:
    for name,width in [('desktop',1440),('mobile',390)]:
     page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(ready['url']+'/') else r.abort())
     if name=='desktop':
      api=ready['url']+'/api/core/integrations/mcp';created=page.request.post(api,data={'label':'격리 계산 서버','endpoint':'http://127.0.0.1:'+str(mcp.server_port)+'/mcp','protocolVersion':'2026-07-28'});assert created.status==201;connection=created.json()['id']
      assert page.request.post(api+'/'+connection+'/probe',data={}).status==200
      assert page.request.post(api+'/'+connection+'/permissions',data={'tools':['sum']}).status==200
      called=page.request.post(api+'/'+connection+'/call',data={'tool':'sum','arguments':{'a':2,'b':3},'expectedText':'5','requestId':'history_browser_00000001'});assert called.status==200 and called.json()['status']=='expectation-matched'
      for n in range(2,26):
       reply=page.request.post(api+'/'+connection+'/call',data={'tool':'sum','arguments':{'a':2,'b':3},'expectedText':'5','requestId':'history_browser_'+str(n).zfill(8)});assert reply.status==200 and reply.json()['status']=='expectation-matched'
     page.goto(ready['url']+'/src/ui/connections/mcp.html',wait_until='networkidle')
     expect(page.locator('[data-mcp-readiness]')).to_contain_text('미등록',timeout=30000)
     expect(page.locator('[data-mcp-readiness]')).to_contain_text('설치 확인 필요')
     expect(page.locator('[data-mcp-readiness]')).to_contain_text('허용됨')
     expect(page.locator('.call-result')).to_contain_text('재시작 후 조회한 호출 기록',timeout=30000)
     expect(page.locator('.call-result')).to_contain_text('history_browser_00000025')
     page.reload(wait_until='networkidle');expect(page.locator('.call-result')).to_contain_text('원문 결과는 저장하지 않습니다',timeout=30000)
     page.locator('[data-mcp-history]').click();page.wait_for_selector('[data-mcp-history-id]',timeout=30000);expect(page.locator('[data-mcp-history-id]')).to_have_count(20,timeout=30000);page.locator('[data-mcp-history]').click();expect(page.locator('[data-mcp-history-id]')).to_have_count(25,timeout=30000);expect(page.locator('[data-mcp-history-panel]')).to_contain_text('history_browser_00000001');ids=page.locator('[data-mcp-history-id]').evaluate_all('(rows)=>rows.map(r=>r.dataset.mcpHistoryId)');assert len(set(ids))==25
     page.screenshot(path=str(out/(name+'-history.png')),full_page=True)
     assert not errors;results.append({'view':name,'readinessDistinguished':True,'persistedCallVisible':True,'pagedCallsWithoutDuplicates':25,'reloadPreserved':True,'privateArgumentsAbsent':True,'pageErrors':errors});page.close()
   finally:browser.close()
 finally:
  child.stdin.write('stop\n');child.stdin.flush()
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
mcp.shutdown();mcp.server_close()
(out/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
