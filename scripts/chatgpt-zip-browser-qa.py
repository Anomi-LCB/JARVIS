import argparse,io,json,os,subprocess,zipfile
from pathlib import Path
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser();parser.add_argument('--output',default='artifacts/chatgpt-zip-20261007-browser');args=parser.parse_args()
out=Path(args.output)
out.mkdir(exist_ok=False)
node=Path('artifacts/bundled-node-runtime-20261003/package/runtime/node.exe').resolve()
env=os.environ.copy()
for key in list(env):
    if any(word in key.upper() for word in ['API_KEY','ACCESS_TOKEN','SECRET']):env.pop(key,None)
env.update(JARVIS_TEST_MODE='1',JARVIS_LLM_INTENT='0',JARVIS_LLM_PLANNER='0',JARVIS_LLM_CONTENT='0')
child=subprocess.Popen([str(node),'tests/fixtures/chatgpt-export-ui-browser.mjs'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=env,creationflags=subprocess.CREATE_NO_WINDOW)
checks=[]
try:
    first=child.stdout.readline()
    if not first:raise RuntimeError('fixture exited before URL: '+child.stderr.read())
    url=json.loads(first)['url']
    chrome=next(p for p in [Path(os.environ.get('PROGRAMFILES',''))/'Google/Chrome/Application/chrome.exe',Path(os.environ.get('PROGRAMFILES(X86)',''))/'Microsoft/Edge/Application/msedge.exe'] if p.is_file())
    conversations=[{'id':str(i),'title':f'연구 대화 {i}','private':'UNSELECTED_SYNTHETIC_PRIVATE','current_node':'m','mapping':{'m':{'id':'m','parent':None,'message':{'id':f'm{i}','author':{'role':'user'},'create_time':1790985600,'content':{'content_type':'text','parts':[f'선택한 연구 {i}']}}}}} for i in range(501)]
    conversations[-1]['padding']='x'*(5*1024*1024)
    def archive(parts):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as z:
            for name,value in parts:z.writestr(name,value)
        return stream.getvalue()
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=str(chrome),headless=True,args=['--disable-background-networking'])
        try:
            for width in [1440,390]:
                for i,conversation in enumerate(conversations):
                    conversation['id']=f'{width}-{i}'
                    conversation['mapping']['m']['message']['content']['parts']=[f'QA{width} 선택한 연구 {i}']
                payload=archive([('conversations-001.json',json.dumps(conversations[:250],ensure_ascii=False)),('conversations-002.json',json.dumps(conversations[250:],ensure_ascii=False)),('user.json','UNSELECTED_SYNTHETIC_PRIVATE')])
                page=browser.new_page(viewport={'width':width,'height':1000},locale='ko-KR')
                errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(url)
                panel=page.locator('[data-selected-conversations]');panel.locator('summary').click()
                panel.locator('[data-archive-file]').set_input_files({'name':'official-format-synthetic.zip','mimeType':'application/zip','buffer':payload})
                expect(panel.locator('[data-archive-select]')).to_have_count(50)
                expect(panel).to_contain_text('전체 501개')
                before=page.request.get(url+'check').json();assert before['requestCount']==len(checks)*5
                panel.locator('[data-archive-select="0"]').check()
                panel.locator('[data-archive-choice-next]').click()
                expect(panel.locator('[data-archive-select="50"]')).to_be_visible()
                panel.locator('[data-archive-choice-previous]').click()
                expect(panel.locator('[data-archive-select="0"]')).to_be_checked()
                search=panel.locator('[data-archive-choice-search]');search.locator('input').fill('연구 대화 500');search.locator('button').click()
                expect(panel.locator('[data-archive-select]')).to_have_count(1)
                panel.locator('[data-archive-select="500"]').check()
                panel.locator('[data-archive-preview]').click();expect(panel.locator('[data-archive-commit]')).to_be_visible()
                page.screenshot(path=str(out/f'preview-{width}.png'),full_page=True)
                panel.locator('[data-archive-commit]').click();expect(panel.locator('[role="status"]')).to_contain_text('2개')
                panel.locator('[name="query"]').fill(f'QA{width}');panel.locator('[data-archive-search] button').click()
                expect(panel.locator('[data-archive-withdraw]')).to_have_count(2)
                panel.locator('[data-archive-withdraw]').first.click();expect(panel.locator('[data-archive-withdraw]')).to_have_count(1)
                after=page.request.get(url+'check').json();assert not after['unselectedSent']
                # Only explicit selected preview/commit/query/withdraw/refresh reaches Core.
                assert after['requestCount']-before['requestCount']==5
                bad=archive([('user.json','[]')]);panel.locator('[data-archive-file]').set_input_files({'name':'bad.zip','mimeType':'application/zip','buffer':bad})
                expect(panel.locator('[role="status"]')).to_contain_text('대화 JSON을 확인할 수 없는 ZIP')
                expect(panel.locator('[data-archive-commit]')).to_have_count(0)
                assert page.request.get(url+'check').json()['requestCount']==after['requestCount']
                assert not errors,errors
                assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'), 'horizontal overflow'
                checks.append({'width':width,'choices':501,'visiblePerPage':50,'parsedJsonBytes':len(json.dumps(conversations,ensure_ascii=False).encode()),'selectedOnly':True,'zipPrivateSent':False,'initialNetworkRequests':0,'pageErrors':errors})
                page.close()
        finally:browser.close()
    (out/'report.json').write_text(json.dumps({'status':'passed','observedAt':datetime.now(timezone.utc).isoformat(),'execution':'real browser component, real authenticated Core HTTP, temporary F SQLite, Python standard ZIP, synthetic content','checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','checks':checks},ensure_ascii=False))
finally:
    if child.poll() is None:
        try:child.stdin.write('stop\n');child.stdin.flush()
        except OSError:pass
        try:child.wait(timeout=20)
        except subprocess.TimeoutExpired:child.kill();child.wait()
    (out/'fixture-stderr.txt').write_text(child.stderr.read(),encoding='utf-8')
