"""Read-only UI and generated HTML smoke; no command is submitted."""
import json, sys
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1]
spec=spec_from_file_location('browser_baseline',Path(__file__).with_name('control-center-browser-qa.py'))
baseline=module_from_spec(spec);spec.loader.exec_module(baseline)
out=root/'artifacts/complex-command-audit/2026-09-03-report'
report={'checks':[],'errors':[],'externalReportRequests':[]}
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=baseline.resolve_chrome(''),headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    page.add_init_script("localStorage.setItem('jarvis.autoOwnerEnabled','0')")
    page.on('pageerror',lambda e: report['errors'].append(str(e)))
    page.goto('http://127.0.0.1:41730/',wait_until='domcontentloaded')
    page.wait_for_selector('[data-command]')
    report['checks'].append({'check':'제어센터 로드·명령 버튼·한 개의 주 제목','pass':page.locator('[data-command]').count()>0 and page.locator('h1').count()==1})
    page.screenshot(path=str(out/'control-center.png'),full_page=True)
    page.on('request',lambda req: report['externalReportRequests'].append(req.url) if req.url.startswith(('http:','https:')) else None)
    page.goto((root/'artifacts/complex-command-audit/2026-09-03-fixed-v2/19/workspace/scores.html').as_uri(),wait_until='load')
    table=page.locator('table').inner_text()
    report['checks'].append({'check':'실제 HTML 표 렌더링','pass':all(t in table for t in ['김하늘','이지민','박서준','90','80','100'])})
    report['checks'].append({'check':'HTML 외부 자원 요청 없음','pass':not report['externalReportRequests']})
    page.screenshot(path=str(out/'scores-report.png'),full_page=True)
    browser.close()
report['checks'].append({'check':'브라우저 JavaScript 오류 없음','pass':not report['errors']})
(out/'browser-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
sys.exit(0 if all(c['pass'] for c in report['checks']) else 1)
