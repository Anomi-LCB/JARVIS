"""Exercise automatic owner renewal in the UI using intercepted authority and task requests."""
import json
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
from playwright.sync_api import sync_playwright

spec = spec_from_file_location('qa', Path(__file__).with_name('control-center-browser-qa.py'))
qa = module_from_spec(spec)
spec.loader.exec_module(qa)
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=qa.resolve_chrome(''), headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    state = {'active': False, 'recentAudit': [{'eventType': 'owner_session.expired'}]}
    calls = []
    commands = []
    def respond(route, body):
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    def owner(route):
        path = route.request.url.split('?')[0]
        if path.endswith('/activate'):
            calls.append('activate')
            state.update({'success': True, 'active': True, 'session': {'sessionId': 'qa-session', 'expiresAt': '2099-09-02T12:00:00Z'}, 'recentAudit': []})
        elif path.endswith('/revoke'):
            calls.append('revoke')
            state.update({'success': True, 'active': False, 'session': None, 'recentAudit': [{'eventType': 'owner_session.revoked'}]})
        respond(route, state)
    def task(route):
        if route.request.method == 'POST':
            commands.append(route.request.post_data_json)
            route.fulfill(status=503, content_type='application/json', body='{"error":{"message":"QA stops before execution"}}')
        else:
            route.continue_()
    page.route('**/api/core/owner-session**', owner)
    page.route('**/api/core/tasks', task)
    page.goto('http://127.0.0.1:41730/')
    page.wait_for_selector('[data-command]:not([disabled])')
    assert calls == []
    checks.append('No authorization request on page load')
    with page.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/tasks')):
        page.locator('[data-command]').first.click()
    page.wait_for_selector('[data-command]:not([disabled])')
    assert calls == ['activate']
    assert commands[0]['options']['ownerSessionId'] == 'qa-session'
    checks.append('One click renews expired authorization and submits the command with its session')
    page.locator('[data-owner-session-toggle]').click()
    page.wait_for_selector('[data-owner-session-toggle][aria-checked="false"]')
    assert page.evaluate("localStorage.getItem('jarvis.autoOwnerEnabled')") == '0'
    page.reload()
    page.wait_for_selector('[data-owner-session-toggle][aria-checked="false"]')
    with page.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/tasks')):
        page.locator('[data-command]').first.click()
    page.wait_for_selector('[data-command]:not([disabled])')
    assert calls == ['activate', 'revoke']
    assert commands[-1]['options']['ownerSessionId'] is None
    checks.append('Opt-out survives reload and subsequent command stays supervised')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    folder = Path('artifacts/browser-qa/owner-command-session')
    folder.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(folder / 'mobile.png'), full_page=True)
    assert not errors, errors
    (folder / 'report.json').write_text(json.dumps({'checks': checks, 'pageErrors': errors, 'realTasksExecuted': 0}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
print(json.dumps({'passed': len(checks), 'pageErrors': errors, 'realTasksExecuted': 0}))
