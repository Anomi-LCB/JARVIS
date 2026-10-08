"""Read-only browser checks for the v2 re-audit fixes; faults are browser-local."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('baseline_qa', Path(__file__).with_name('control-center-browser-qa.py'))
baseline = module_from_spec(spec)
spec.loader.exec_module(baseline)
out = Path('artifacts/browser-qa/control-center-reaudit-v2')
out.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'layouts': [], 'pageErrors': []}

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=baseline.resolve_chrome(''), headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script("localStorage.setItem('jarvis.autoOwnerEnabled', '0')")
    page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
    posts = []
    page.on('request', lambda request: posts.append(request.url) if request.method == 'POST' else None)
    page.goto('http://127.0.0.1:41730/')
    page.wait_for_selector('[data-command]')
    assert page.locator('h1').count() == 1
    # Intercept task creation so one-click submission never operates the real PC.
    def mock_task(route):
        if route.request.method == 'POST':
            route.fulfill(status=503, content_type='application/json', body='{"error":{"message":"QA injected failure"}}')
        else:
            route.continue_()
    page.route('**/api/core/tasks', mock_task)
    with page.expect_request(lambda request: request.method == 'POST' and request.url.endswith('/api/core/tasks')):
        page.locator('[data-command]').first.click()
    page.wait_for_selector('[data-command]:not([disabled])')
    assert len(posts) == 1, posts
    assert page.locator('.command-preview').count() == 0
    report['checks'].append('Quick request submits once immediately; task creation is intercepted for safety')
    page.locator('[data-execution-mode="mission"]').click()
    assert page.locator('[data-execution-mode="mission"]').get_attribute('aria-pressed') == 'true'
    assert page.locator('[data-execution-mode="mission"]').evaluate('(el) => el === document.activeElement')
    page.locator('[data-execution-mode="task"]').click()
    report['checks'].append('Execution mode exposes selected state and preserves keyboard focus')
    page.route('**/api/local/support-bundle*', lambda route: route.abort())
    page.locator('.system-diagnostics').evaluate('(el) => el.open = true')
    page.locator('[data-run-support-diagnostic]').click()
    page.wait_for_selector('#support-failure-title')
    assert '자동 진단을 완료하지 못했습니다' in page.locator('.support-diagnostic').inner_text()
    assert 'CONNECTION_UNCONFIRMED' in page.locator('.support-diagnostic').text_content()
    report['checks'].append('Failed diagnostic replaces pre-run state with actionable failure')
    page.unroute('**/api/local/support-bundle*')
    page.locator('[data-run-support-diagnostic]').click()
    page.wait_for_selector('[data-run-support-diagnostic]:not([disabled])')
    assert page.locator('#support-failure-title').count() == 0
    assert '진단 실행 전' not in page.locator('.support-diagnostic').inner_text()
    report['checks'].append('Diagnostic retry recovers against the real gateway')
    for width in [360, 390, 768, 1024, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        snapshot = baseline.layout_snapshot(page)
        report['layouts'].append({'surface': 'control', 'width': width, **snapshot})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
        page.screenshot(path=str(out / f'control-{width}.png'), full_page=True)

    skills = browser.new_page(viewport={'width': 1440, 'height': 1000})
    skills.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
    skills.route('**/skill-center/status', lambda route: route.abort())
    skills.goto('http://127.0.0.1:41730/src/ui/skill-center/index.html')
    skills.wait_for_selector('.connection-error')
    assert skills.locator('.skill-row').count() > 0
    assert skills.locator('[data-activate-profile]').is_disabled()
    assert skills.locator('h1').count() == 1
    report['checks'].append('Real catalog remains available when status request alone fails')
    for width in [360, 390, 768, 1024, 1440]:
        skills.set_viewport_size({'width': width, 'height': 1000})
        report['layouts'].append({'surface': 'skills', 'width': width, 'scrollWidth': skills.evaluate('document.documentElement.scrollWidth')})
        assert skills.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
        skills.screenshot(path=str(out / f'skills-{width}.png'), full_page=True)
    skills.unroute('**/skill-center/status')
    skills.locator('[data-refresh]').first.click()
    skills.wait_for_selector('.runtime-indicator.ready')
    assert not skills.locator('.connection-error').count()
    report['checks'].append('Skill status recovers without reloading the page')
    skills.route('**/api/core/skill-center/**', lambda route: route.abort())
    skills.reload()
    skills.wait_for_selector('.error-state')
    assert 'Failed to fetch' not in skills.locator('body').inner_text()
    assert skills.locator('h1').count() == 1
    skills.set_viewport_size({'width': 360, 'height': 800})
    assert skills.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    skills.screenshot(path=str(out / 'skills-first-load-failure.png'), full_page=True)
    report['checks'].append('Fresh offline tab provides recovery instructions with no invented cache')
    assert not report['pageErrors'], report['pageErrors']
    browser.close()

(out / 'reaudit-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': len(report['checks']), 'layouts': len(report['layouts']), 'pageErrors': report['pageErrors']}))
