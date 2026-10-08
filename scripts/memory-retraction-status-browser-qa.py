import json, subprocess, os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
out=Path('artifacts/memory-retraction-status-20261003-browser');out.mkdir(exist_ok=True)
proc=subprocess.Popen(['node','tests/fixtures/memory-retraction-status-browser.mjs'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
try:
    ready=json.loads(proc.stdout.readline());errors=[];checks=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,channel='chrome')
        page=browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda error:errors.append(str(error)))
        requests=[]
        page.on('request',lambda request:requests.append(request.url) if request.url.endswith('/memory/status') else None)
        page.goto(ready['url']);page.locator('summary').click()
        expect(page.get_by_role('status')).to_contain_text('아직 저장하지 못한 기억')
        expect(page.locator('body')).to_contain_text('저장 대기: 1건')
        assert 'SYNTHETIC_NOT_FOR_SCREEN' not in page.locator('body').inner_text()
        checks.append('actual_sqlite_pending_count_without_payload')
        expect(page.locator('[data-memory-retractions]')).to_contain_text('연결이 준비되지 않았습니다')
        checks.append('retraction_connection_missing_is_explicit')
        page.request.post(ready['url']+'fixture/retraction-setup')
        page.get_by_role('button',name='상태 다시 확인',exact=True).click()
        expect(page.locator('[data-memory-retractions]')).to_contain_text('아직 확인하지 않았습니다')
        checks.append('connected_not_observed_is_not_complete')
        initial=len(requests)
        page.wait_for_timeout(500)
        assert len(requests)-initial<=1,'rerender causes request loop'
        checks.append('no_render_refresh_loop')
        page.request.post(ready['url']+'fixture/start')
        expect(page.get_by_role('status')).to_contain_text('현재 저장 대기는 없습니다',timeout=10000)
        expect(page.locator('body')).to_contain_text('Core 자동 재처리가 실행 중')
        checks.append('core_timer_replay_and_open_panel_auto_refresh')
        expect(page.locator('[data-memory-retractions]')).to_contain_text('전달 대기: 1건',timeout=12000)
        assert 'SYNTHETIC_RETRACTION_PRIVATE' not in page.locator('body').inner_text()
        checks.append('durable_retraction_retry_pending_auto_refresh')
        page.request.post(ready['url']+'fixture/retraction-ack')
        expect(page.locator('[data-memory-retractions]')).to_contain_text('삭제 반영 대기는 없었습니다',timeout=12000)
        checks.append('timer_success_clears_pending_without_resubmission')
        page.request.post(ready['url']+'fixture/retraction-fail')
        expect(page.locator('[data-memory-retractions]')).to_contain_text('상태를 확인할 수 없습니다',timeout=12000)
        assert '전달 대기: 0건' not in page.locator('body').inner_text()
        checks.append('withdrawal_failure_is_unknown_not_zero')
        page.request.post(ready['url']+'fixture/retraction-recover')
        expect(page.locator('[data-memory-retractions]')).to_contain_text('삭제 반영 대기는 없었습니다',timeout=12000)
        checks.append('withdrawal_recovery_auto_refresh')
        page.request.post(ready['url']+'fixture/fail')
        page.get_by_role('button',name='상태 다시 확인',exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('지금은 상태를 확인할 수 없습니다')
        assert '저장 대기: 0건' not in page.locator('body').inner_text()
        checks.append('unavailable_not_zero_or_success')
        page.request.post(ready['url']+'fixture/recover')
        page.get_by_role('button',name='상태 다시 확인',exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('현재 저장 대기는 없습니다')
        page.screenshot(path=str(out/'desktop.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        overflow=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)')
        assert overflow==0
        page.screenshot(path=str(out/'mobile.png'),full_page=True)
        checks.append('recovery_mobile_layout_no_overflow')
        page.locator('summary').click()
        expect(page.locator('details')).not_to_have_attribute('open','')
        closed=len(requests);page.wait_for_timeout(5500)
        assert len(requests)==closed,'closed panel keeps polling'
        checks.append('closed_panel_stops_polling')
        assert not errors,errors
        browser.close()
    result={'mode':'isolated-Chrome-Core-SQLite-daemon','passed':len(checks),'checks':checks,'pageErrors':errors,'horizontalOverflowPx':overflow,'syntheticDataOnly':True,'productionModified':False}
    (out/'browser.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
finally:
    stdout,stderr=proc.communicate('close\n',timeout=15)
    assert proc.returncode==0,stderr[-1800:]
