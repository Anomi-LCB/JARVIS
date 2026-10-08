"""Measure trusted input to a captured raster in an isolated actual product UI; never submit commands."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import importlib.util
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
_spec = importlib.util.spec_from_file_location('existing_browser_qa', Path(__file__).with_name('control-center-browser-qa.py'))
_qa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_qa)
resolve_chrome = _qa.resolve_chrome


def distribution(values):
    values = sorted(values)
    return {"samples": len(values), "p50Ms": values[math.ceil(len(values)*.5)-1], "p95Ms": values[math.ceil(len(values)*.95)-1], "maxMs": max(values)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    env = {k: v for k, v in os.environ.items() if k.upper() in {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'}}
    results = []
    with tempfile.TemporaryDirectory(prefix='jarvis-input-latency-') as root:
        env.update({'TEMP': root, 'TMP': root, 'USERPROFILE': root, 'LOCALAPPDATA': root, 'APPDATA': root})
        child = subprocess.Popen([str(Path(args.node).resolve()), str(repository/'tests/fixtures/input-latency-product.mjs'), root], cwd=repository, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            ready = json.loads(child.stdout.readline())
            if ready['status'] != 'ready' or len(ready['services']) != 4:
                raise RuntimeError('actual product startup failed')
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=resolve_chrome(''), headless=True, args=['--disable-extensions', '--no-first-run', '--disable-background-networking'])
                try:
                    for view, viewport in [('desktop', {'width':1440,'height':1000}), ('mobile', {'width':390,'height':844})]:
                        page = browser.new_page(viewport=viewport)
                        errors = []
                        page.on('pageerror', lambda error: errors.append(type(error).__name__))
                        page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(ready['url']+'/') else route.abort())
                        page.goto(ready['url'], wait_until='networkidle')
                        input_box = page.locator('#ws-command')
                        input_box.wait_for(state='visible')
                        input_box.scroll_into_view_if_needed()
                        page.evaluate("""() => { document.addEventListener('beforeinput', e => { if(e.target.id==='ws-command')window.inputSample={started:e.timeStamp,handlerStarted:performance.now(),trusted:e.isTrusted}; }, true); }""")
                        samples = []
                        for index in range(50):
                            input_box.fill('')
                            input_box.focus()
                            box = input_box.bounding_box()
                            scroll = page.evaluate('({x:window.scrollX,y:window.scrollY})')
                            clip = {**box, 'x':box['x']+scroll['x'], 'y':box['y']+scroll['y']}
                            page.evaluate('window.inputSample=null')
                            page.keyboard.insert_text('가')
                            page.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
                            # Capture the already located rectangle, without Locator's extra actionability/stability wait.
                            png = page.screenshot(clip=clip)
                            observation = page.evaluate("""() => ({elapsedMs:performance.now()-window.inputSample.started,queueDelayMs:window.inputSample.handlerStarted-window.inputSample.started,trusted:window.inputSample.trusted,value:document.querySelector('#ws-command').value})""")
                            passed = observation['trusted'] and observation['value']=='가' and png.startswith(b'\x89PNG\r\n\x1a\n')
                            samples.append({'index':index,'elapsedMs':observation['elapsedMs'],'queueDelayMs':observation['queueDelayMs'],'trusted':observation['trusted'],'valuePreserved':observation['value']=='가','rasterSha256':hashlib.sha256(png).hexdigest(),'passed':passed})
                            if index == 49:
                                (output/(view+'-input.png')).write_bytes(png)
                        results.append({'view':view,'viewport':viewport,'samples':samples,'latency':distribution([s['elapsedMs'] for s in samples]),'pageErrors':errors})
                        page.close()
                    browser_version = browser.version
                finally:
                    browser.close()
            result = {'observedAt':datetime.now(timezone.utc).isoformat(),'browser':browser_version,'browserMode':'system Chromium headless','services':ready['services'],'metric':'trusted beforeinput → two animation frames → captured input PNG completion → browser observation; conservative raster upper bound including automation and encoding','views':results,'passed':all(v['latency']['p95Ms']<=200 and not v['pageErrors'] and all(s['passed'] for s in v['samples']) for v in results),'commandSubmissions':0,'externalCalls':0,'cost':'미측정','limitations':['한 Windows PC·시스템 Chrome headless·합성 단일 문자·각 화면50회다.','실제 물리 키보드/IME 조합·OS compositor/디스플레이 광자 지연은 측정하지 않았다.','스크린샷은 입력값을 포함하는 raster 생성 완료의 보수적 상한이며 이벤트 렌더링 전용 시간을 분리하지 않는다.','로컬 업무 실행 종단 시간은 별도 고정 명령 평가에서 측정한다.']}
            (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps({'output':str(output),'passed':result['passed'],'views':[{ 'view':v['view'],**v['latency']} for v in results]},ensure_ascii=False))
        finally:
            if child.poll() is None:
                child.stdin.write('stop\n')
                child.stdin.flush()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    # Only the tree created by this fixture; never target another runtime.
                    subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
                    child.wait(timeout=5)
        return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

