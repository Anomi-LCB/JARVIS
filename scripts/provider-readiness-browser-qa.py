from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def find_chrome() -> str:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    raise FileNotFoundError("Chrome or Edge is required for isolated provider readiness browser QA.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    parsed = urlparse(args.url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Only an isolated loopback UI is allowed.")
    raw_token = os.environ.get("JARVIS_QA_RAW_TOKEN", "")
    requests: list[dict] = []
    console_errors: list[str] = []
    page_errors: list[str] = []
    request_failures: list[dict] = []
    checks: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=find_chrome(), headless=True, args=["--disable-background-networking", "--disable-extensions"])
        try:
            context = browser.new_context(locale="ko-KR", viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            page.add_init_script(f"sessionStorage.setItem('jarvis.coreAdminToken', {json.dumps(raw_token)});")
            page.on("request", lambda request: requests.append({"url": request.url, "method": request.method}))
            page.on("console", lambda message: console_errors.append(message.text.replace(raw_token, "[REDACTED]")[:300]) if message.type == "error" else None)
            page.on("pageerror", lambda error: page_errors.append(type(error).__name__))
            page.on("requestfailed", lambda request: request_failures.append({"method": request.method, "path": urlparse(request.url).path, "error": (request.failure or "")[:160]}))
            page.goto(args.url, wait_until="domcontentloaded", timeout=20_000)
            page.locator("main#app").wait_for(state="visible", timeout=15_000)
            panel = page.locator(".diagnostic-readiness .integration-readiness")
            panel.wait_for(state="visible", timeout=15_000)
            diagnostics = page.locator(".system-diagnostics")
            if diagnostics.get_attribute("open") is None:
                diagnostics.locator(":scope > summary").click()
            panel.scroll_into_view_if_needed()
            panel.locator("li").nth(3).wait_for(state="visible", timeout=10_000)
            rows = panel.locator("li").evaluate_all("nodes => nodes.map(node => ({provider: node.querySelector('strong')?.innerText || '', state: node.querySelector('span')?.innerText || '', detail: node.querySelector('small')?.innerText || ''}))")
            by_provider = {row["provider"]: row for row in rows}
            expected = {
                "xAI": "인증 거부",
                "Meta": "권한 거부",
                "Gemini": "읽기 검증 성공",
                "OpenAI Agents": "아직 제공자 읽기 검증을 하지 않았습니다.",
            }
            for provider, state in expected.items():
                ok = provider in by_provider and state in by_provider[provider]["state"]
                checks.append({"id": f"visible-status-{provider.lower().replace(' ', '-')}", "passed": ok})
                if not ok:
                    raise AssertionError(f"Unexpected provider readiness row for {provider}.")
            body = page.locator("body").inner_text()
            fixture_keys = [f"synthetic-{provider}-key-never-transmitted" for provider in ("xai", "meta", "gemini", "openai-agents")]
            checks.append({"id": "no-synthetic-api-keys-rendered", "passed": not any(key in body for key in fixture_keys)})
            if checks[-1]["passed"] is False:
                raise AssertionError("A synthetic fixture key appeared in the rendered page.")
            integration_requests = [request for request in requests if urlparse(request["url"]).path == "/api/core/integrations"]
            checks.append({"id": "browser-read-through-local-auth-proxy", "passed": bool(integration_requests) and all(request["method"] == "GET" for request in integration_requests)})
            if checks[-1]["passed"] is False:
                raise AssertionError("The browser did not load integration readiness using GET through the local proxy.")
            external_requests = [request for request in requests if not (urlparse(request["url"]).hostname in {"127.0.0.1", "localhost", "::1"})]
            checks.append({"id": "no-external-browser-requests", "passed": not external_requests})
            if external_requests:
                raise AssertionError("Unexpected external browser request was observed.")
            flow = {
                "status": "passed",
                "checks": checks,
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "failedApiRequests": [item for item in requests if item["url"].startswith(args.url) and "/api/core/integrations" in item["url"] and item["method"] != "GET"],
                "requestFailures": request_failures,
                "providerTargetsContacted": 0,
            }
            if page_errors:
                raise AssertionError("A browser page exception was observed.")
            context.close()
        finally:
            browser.close()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(flow, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": flow["status"], "checks": checks}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
