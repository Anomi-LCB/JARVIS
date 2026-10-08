import argparse, json, os, subprocess, importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True)
parser.add_argument('--output', default='artifacts/cancelled-review-ui-20261008-browser')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qa', repo / 'scripts/control-center-browser-qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
out = repo / args.output
out.mkdir(exist_ok=True)
env = {k: v for k, v in os.environ.items() if k.upper() in ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']}
results = []
child = subprocess.Popen([str(Path(args.node).resolve()), str(repo / 'tests/fixtures/cancelled-review-browser.mjs')],
    cwd=repo, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
try:
    line = child.stdout.readline()
    if not line:
        raise RuntimeError(child.stderr.read())
    ready = json.loads(line)
    assert ready['status'] == 'ready'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=qa.resolve_chrome(''), headless=True)
        try:
            for name, width, advanced in [('desktop', 1440, False), ('mobile', 390, False), ('advanced', 1440, True)]:
                child.stdin.write('reset\n'); child.stdin.flush()
                assert json.loads(child.stdout.readline())['status'] == 'reset'
                page = browser.new_page(viewport={'width': width, 'height': 1000})
                errors, mutations = [], []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('request', lambda r: mutations.append(r.url) if r.method == 'POST' and '/missions/' in r.url else None)
                page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(ready['url'] + '/') else route.abort())
                page.add_init_script("localStorage.setItem('jarvis.executionMode', 'mission');")
                page.goto(ready['url'] + ('/?advanced=1' if advanced else ''), wait_until='networkidle')
                if not advanced:
                    page.locator('[data-page="tasks"]').click()
                    page.locator('[data-task="' + ready['missionId'] + '"]').first.click()
                panel = page.locator('[data-cancellation-review]')
                try:
                    panel.wait_for(timeout=30000)
                except Exception:
                    page.screenshot(path=str(out / (name + '-failure.png')), full_page=True)
                    (out / (name + '-failure.json')).write_text(json.dumps({'errors': errors, 'text': page.locator('body').inner_text()[:12000]}, ensure_ascii=False), encoding='utf-8')
                    raise
                assert panel.locator('[data-mission-resume]').count() == 0
                button = panel.get_by_role('button', name='실행 결과 확인', exact=True)
                with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/cancellation-review'), timeout=30000) as first:
                    button.click()
                body = first.value.json()
                assert first.value.status == 200 and body['items'][0]['status'] == 'verified-executed', json.dumps({'status': first.value.status, 'body': body}, ensure_ascii=False)
                assert body['executionAuthority'] is False and body['effectsChanged'] is False
                expect(panel).to_contain_text('실행 결과 확인됨')
                page.screenshot(path=str(out / (name + '-verified.png')), full_page=True)
                child.stdin.write('mutate\n'); child.stdin.flush()
                assert json.loads(child.stdout.readline())['status'] == 'mutate'
                with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/cancellation-review'), timeout=30000) as second:
                    button.click()
                assert second.value.status == 200 and second.value.json()['items'][0]['status'] == 'unresolved'
                expect(panel).to_contain_text('실행 결과 미확인')
                colors = panel.evaluate('(el) => ({background:getComputedStyle(el).backgroundColor, text:getComputedStyle(el).color, display:getComputedStyle(el).display})')
                if advanced:
                    assert colors == {'background': 'rgb(255, 255, 255)', 'text': 'rgb(22, 43, 64)', 'display': 'block'}, colors
                    assert panel.locator('li').first.evaluate('(el)=>getComputedStyle(el).display') == 'block'
                expect(panel).not_to_contain_text('실행 결과 확인됨')
                expect(panel).to_contain_text('중복될 수 있습니다')
                assert all(url.endswith('/cancellation-review') for url in mutations), mutations
                assert len(mutations) == 2 and not errors, errors
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
                page.screenshot(path=str(out / (name + '-changed.png')), full_page=True)
                results.append({'view': name, 'realCorePcG': True, 'verifiedThenChanged': True,
                    'reviewRequests': len(mutations), 'reexecutionRequests': 0, 'pageErrors': errors, 'horizontalOverflow': False, 'panelColors': colors})
                page.close()
        finally:
            browser.close()
finally:
    if child.poll() is None:
        try:
            child.stdin.write('stop\n'); child.stdin.flush()
        except OSError:
            child.terminate()
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.terminate(); child.wait(timeout=5)
(out / 'report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(results, ensure_ascii=False))
