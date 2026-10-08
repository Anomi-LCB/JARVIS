import argparse,io,json,os,zipfile
from pathlib import Path
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--output',default='artifacts/local-runtime-20261007-memory-ui');args=parser.parse_args()
out=Path(args.output);out.mkdir(exist_ok=False)
chrome=next(p for p in [Path(os.environ.get('PROGRAMFILES',''))/'Google/Chrome/Application/chrome.exe',Path(os.environ.get('PROGRAMFILES(X86)',''))/'Microsoft/Edge/Application/msedge.exe'] if p.is_file())
data=[{'id':f'operator-view-{i}','title':f'운영화면 자료 {i}','current_node':'m','mapping':{'m':{'id':'m','parent':None,'message':{'id':f'm{i}','author':{'role':'user'},'create_time':1790985600,'content':{'content_type':'text','parts':[f'선택한 화면 자료 {i}']}}}},'private':'NEVER_SEND_RAW_EXPORT'} for i in range(501)]
archive=io.BytesIO()
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('conversations.json',json.dumps(data,ensure_ascii=False));z.writestr('user.json','NEVER_SEND_ACCOUNT')
checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=str(chrome),headless=True,args=['--disable-background-networking'])
    try:
        for width in [1440,390]:
            page=browser.new_page(viewport={'width':width,'height':1000},locale='ko-KR')
            errors=[];requests=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.on('request',lambda request:requests.append(request) if '/memory/selected-conversations/' in request.url else None)
            page.goto('http://127.0.0.1:41730/#memory')
            panel=page.locator('[data-workspace-conversation-import] [data-selected-conversations]')
            expect(panel).to_be_visible();panel.locator('summary').click()
            panel.locator('[data-archive-file]').set_input_files({'name':'operator-synthetic-export.zip','mimeType':'application/zip','buffer':archive.getvalue()})
            expect(panel.locator('[data-archive-select]')).to_have_count(50)
            expect(panel).to_contain_text('읽은 파일: operator-synthetic-export.zip');assert len(requests)==0
            panel.locator('[data-archive-select="0"]').check()
            panel.locator('[data-archive-choice-next]').click();panel.locator('[data-archive-choice-previous]').click()
            expect(panel.locator('[data-archive-select="0"]')).to_be_checked()
            form=panel.locator('[data-archive-choice-search]');form.locator('input').fill('운영화면 자료 500');form.locator('button').click()
            expect(panel.locator('[data-archive-select]')).to_have_count(1);panel.locator('[data-archive-select="500"]').check()
            assert len(requests)==0
            with page.expect_response(lambda response:'/memory/selected-conversations/preview' in response.url) as pending_response:
                panel.locator('[data-archive-preview]').click()
            response=pending_response.value
            if not response.ok:
                value=response.json();diagnostic={'http':response.status,'code':value.get('error',{}).get('code'),'visible':panel.locator('[role=status]').inner_text()}
                (out/'preview-failure.json').write_text(json.dumps(diagnostic,ensure_ascii=False),encoding='utf-8');raise AssertionError(diagnostic)
            expect(panel.locator('[data-archive-commit]')).to_be_visible()
            assert len(requests)==1
            body=json.loads(requests[0].post_data)
            assert [c['id'] for c in body['document']['conversations']]==['operator-view-0','operator-view-500']
            assert not any(marker in requests[0].post_data for marker in ['NEVER_SEND_RAW_EXPORT','NEVER_SEND_ACCOUNT'])
            assert requests[0].url.endswith('/preview')
            panel.screenshot(path=str(out/f'preview-{width}.png'))
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert not errors,errors
            # Do not commit synthetic conversations to the user's actual memory.
            checks.append({'width':width,'productionWorkspace':True,'productionCorePreview':True,'parsedConversations':501,'visible':50,'selected':2,'selectedRequests':1,'commits':0,'privateSent':False,'pageErrors':errors})
            page.close()
    finally:browser.close()
(out/'report.json').write_text(json.dumps({'observedAt':datetime.now(timezone.utc).isoformat(),'status':'passed','checks':checks,'scope':'live source runtime, full primary workspace, real Core preview only; installed EXE not tested'},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'status':'passed','views':2,'memoryCommits':0},ensure_ascii=False))
