import argparse
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--full-page', action='store_true')
args = parser.parse_args()
output = Path(args.output)
candidates = [Path(os.environ.get('PROGRAMFILES', '')) / 'Google/Chrome/Application/chrome.exe', Path(os.environ.get('PROGRAMFILES(X86)', '')) / 'Microsoft/Edge/Application/msedge.exe']
chrome = next(str(path) for path in candidates if path.is_file())
document = {'format': 'jarvis-selected-conversations-v1', 'provider': 'chatgpt', 'conversations': [
    {'id': 'chosen', 'messages': [{'id': 'm1', 'speaker': 'user', 'text': '자료 <img src=x onerror=alert(1)> 원문 대조', 'spokenAt': '2026-09-30T00:00:00Z'}]},
    {'id': 'excluded', 'messages': [{'id': 'm2', 'speaker': 'assistant', 'text': '자료 제외 대상', 'spokenAt': '2026-09-30T00:00:00Z'}]}
]}
checks, errors = [], []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=chrome, headless=True, args=['--disable-background-networking'])
    try:
        page = browser.new_page(locale='ko-KR', viewport={'width': 1280, 'height': 1000})
        if args.full_page:
            page.add_init_script("sessionStorage.setItem('jarvis.coreAdminToken', " + json.dumps(os.environ['JARVIS_QA_RAW_TOKEN']) + ");")
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(args.url)
        panel = page.locator('[data-selected-conversations]')
        panel.locator('summary').click()
        panel.locator('[data-archive-file]').set_input_files({'name': 'fixture.json', 'mimeType': 'application/json', 'buffer': json.dumps(document, ensure_ascii=False).encode()})
        expect(panel.locator('[data-archive-select]')).to_have_count(2)
        expect(panel.locator('[data-archive-preview]')).to_be_disabled()
        checks.append('explicit selection required')
        panel.locator('[data-archive-select="0"]').check()
        panel.locator('[data-archive-preview]').click()
        expect(panel.locator('[data-archive-commit]')).to_be_visible()
        panel.locator('[data-archive-select="1"]').check()
        expect(panel.locator('[data-archive-commit]')).to_have_count(0)
        panel.locator('[data-archive-select="1"]').uncheck()
        checks.append('selection change invalidates preview')
        panel.locator('[data-archive-preview]').click()
        panel.locator('[data-archive-commit]').click()
        expect(panel.locator('[role="status"]')).to_contain_text('1개 저장')
        panel.locator('[name="query"]').fill('자료')
        panel.locator('[data-archive-search] button').click()
        expect(panel.locator('[data-archive-withdraw]')).to_have_count(1)
        expect(panel).not_to_contain_text('자료 제외 대상')
        assert panel.locator('img').count() == 0
        checks += ['actual SQLite commit and scoped search', 'unselected conversation excluded', 'quoted HTML rendered as text']
        panel.screenshot(path=str(output / 'desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        panel.screenshot(path=str(output / 'mobile.png'))
        checks.append('390px layout has no horizontal overflow')
        panel.locator('[data-archive-withdraw]').click()
        expect(panel.locator('[role="status"]')).to_contain_text('철회했습니다')
        expect(panel.locator('[data-archive-withdraw]')).to_have_count(0)
        checks.append('withdrawal removes next search result')
        panel.locator('[data-archive-file]').set_input_files({'name': 'bad.json', 'mimeType': 'application/json', 'buffer': b'{broken'})
        expect(panel.locator('[role="status"]')).to_contain_text('처리하지 못했습니다')
        expect(panel.locator('[data-archive-commit]')).to_have_count(0)
        checks.append('invalid file error with no stale commit')
        if errors:
            safe_errors = [error.replace(os.environ.get('JARVIS_QA_RAW_TOKEN', '__no_token__'), '[REDACTED]')[:500] for error in errors]
            (output / 'page-errors.json').write_text(json.dumps(safe_errors, ensure_ascii=False, indent=2), encoding='utf-8')
        assert not errors
        checks.append('no browser page errors')
        (output / 'report.json').write_text(json.dumps({'status': 'passed', 'observedAt': datetime.now(timezone.utc).isoformat(), 'url': args.url, 'execution': 'isolated full Control Center + four service processes; synthetic input only' if args.full_page else 'isolated component + real authenticated Core HTTP + temporary SQLite; synthetic input only', 'checks': checks, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        print('Browser checks passed:', len(checks))
    finally:
        browser.close()
