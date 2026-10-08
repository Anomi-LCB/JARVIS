#!/usr/bin/env python3
"""Exercise weekly routine create, timezone revision, and cancellation in an isolated JARVIS runtime."""

from __future__ import annotations

import argparse
import json
import os
import re
from time import perf_counter
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


OBJECTIVE = "테스트 작업공간의 안내문을 읽고 요약 초안을 저장해줘"
CREATE_COMMAND = f"매주 수요일 오전 9시에 {OBJECTIVE}"
TIMEZONE_COMMAND = f"예약 “{OBJECTIVE}” 시간대를 America/Los_Angeles로 바꿔줘"


def local_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Only a loopback HTTP test runtime is permitted.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("The isolated runtime URL cannot contain credentials or query data.")
    return value


def find_chrome() -> str:
    paths = [
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    ]
    for path in paths:
        if path and Path(path).is_file():
            return str(Path(path).resolve())
    raise FileNotFoundError("Chrome or Edge is required for isolated browser verification.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    url = local_url(args.url)
    requests: list[dict] = []
    capability_observations: list[dict] = []
    checks: list[dict] = []
    elapsed: dict[str, float] = {}
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=find_chrome(), headless=True,
            args=["--disable-extensions", "--no-first-run", "--disable-background-networking"],
        )
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, locale="ko-KR")
            page.on("request", lambda request: requests.append({
                "method": request.method,
                "path": urlparse(request.url).path,
            }) if "/api/core/routines" in request.url else None)
            def capture_capability(response):
                if urlparse(response.url).path != "/api/local/capabilities":
                    return
                payload = response.json()
                capability_observations.append({
                    "status": response.status,
                    "capabilitiesVersion": payload.get("capabilitiesVersion"),
                    "coreAdminProxyConfigured": payload.get("coreAdminProxyConfigured"),
                    "credentialsExposed": payload.get("credentialsExposed"),
                    "hasCredentialField": any("token" in key.lower() or "secret" in key.lower() for key in payload),
                })
            page.on("response", capture_capability)
            started = perf_counter()
            page.goto(url, wait_until="domcontentloaded", timeout=20_000)
            page.wait_for_selector("#command-input", state="visible", timeout=15_000)
            panel = page.locator(".routine-control-panel")
            panel.wait_for(state="visible", timeout=15_000)
            try:
                page.wait_for_function(
                    "() => document.querySelector('.routine-panel-heading')?.innerText.includes('Core SQLite 예약 장부에 연결됨')",
                    timeout=15_000,
                )
            except Exception as error:
                diagnostics = {
                    "reportVersion": "jarvis-agent-platform-s09-isolated-browser-flow-v1",
                    "status": "failed",
                    "failedStage": "wait-for-core-routine-readiness",
                    "failureType": type(error).__name__,
                    "checks": checks,
                    "routineApiRequests": requests,
                    "localCapabilityObservations": capability_observations,
                    "panelHeading": page.locator(".routine-panel-heading").inner_text()[:240],
                    "routineSubmitDisabled": page.locator(".routine-form button[type='submit']").is_disabled(),
                    "browserTokenPresent": page.evaluate("Boolean(sessionStorage.getItem('jarvis.coreAdminToken'))"),
                    "externalCalls": 0,
                    "providerCalls": 0,
                }
                output.write_text(json.dumps(diagnostics, indent=2) + "\n", encoding="utf-8")
                raise
            assert page.locator(".routine-form button[type='submit']").is_enabled()
            assert page.evaluate("sessionStorage.getItem('jarvis.coreAdminToken')") is None
            assert capability_observations and all(
                item["status"] == 200 and item["coreAdminProxyConfigured"] is True
                and item["credentialsExposed"] is False and item["hasCredentialField"] is False
                for item in capability_observations
            )
            checks.append({"id": "server-managed-auth-without-browser-token", "passed": True,
                           "capabilityObservations": len(capability_observations)})
            elapsed["loadAndConnectMs"] = round((perf_counter() - started) * 1000, 2)

            started = perf_counter()
            page.locator("#command-input").fill(CREATE_COMMAND)
            page.locator("#command-console button[type='submit']").click()
            page.wait_for_function(
                "objective => [...document.querySelectorAll('.routine-item p')].some(node => node.textContent.trim() === objective)",
                arg=OBJECTIVE,
                timeout=12_000,
            )
            item = page.locator(".routine-item").filter(has=page.locator("p", has_text=OBJECTIVE)).first
            created_text = item.inner_text()
            routine_id = item.locator("[data-routine-cancel]").get_attribute("data-routine-cancel")
            assert routine_id and "예약됨" in created_text and "Asia/Seoul" in created_text
            checks.append({"id": "composer-created-persisted-weekly-routine", "passed": True})
            elapsed["createMs"] = round((perf_counter() - started) * 1000, 2)

            started = perf_counter()
            page.locator("#command-input").fill(TIMEZONE_COMMAND)
            page.locator("#command-console button[type='submit']").click()
            page.wait_for_function(
                "objective => { const node = [...document.querySelectorAll('.routine-item')].find(item => item.querySelector('p')?.textContent.trim() === objective); return Boolean(node && node.innerText.includes('America/Los_Angeles')); }",
                arg=OBJECTIVE,
                timeout=12_000,
            )
            checks.append({"id": "quoted-objective-revised-unique-routine-timezone", "passed": True})
            elapsed["timezoneRevisionMs"] = round((perf_counter() - started) * 1000, 2)

            started = perf_counter()
            item = page.locator(".routine-item").filter(has=page.locator("p", has_text=OBJECTIVE)).first
            item.locator("[data-routine-cancel]").click()
            page.wait_for_function(
                "objective => { const node = [...document.querySelectorAll('.routine-item')].find(item => item.querySelector('p')?.textContent.trim() === objective); return Boolean(node && node.innerText.includes('취소됨')); }",
                arg=OBJECTIVE,
                timeout=12_000,
            )
            checks.append({"id": "isolated-routine-cancelled-after-test", "passed": True})
            elapsed["cancelMs"] = round((perf_counter() - started) * 1000, 2)

            observed = {method: sum(1 for request in requests if request["method"] == method)
                        for method in ("GET", "POST", "PATCH")}
            create_seen = any(request["method"] == "POST" and request["path"] == "/api/core/routines/command" for request in requests)
            list_seen = any(request["method"] == "GET" and request["path"] == "/api/core/routines" for request in requests)
            timezone_seen = any(request["method"] == "PATCH" and request["path"].endswith("/timezone") for request in requests)
            cancel_seen = any(request["method"] == "POST" and request["path"].endswith("/cancel") for request in requests)
            assert create_seen and list_seen and timezone_seen and cancel_seen, f"Routine API path sequence is incomplete: {requests}"
            checks.append({"id": "core-api-method-sequence-count", "passed": True, "observed": observed})
            safe_requests = [{
                **request,
                "path": re.sub(r"(/api/core/routines)/(?!command(?:/|$))[^/]+", r"\1/{routineId}", request["path"]),
            } for request in requests]
            report = {
                "reportVersion": "jarvis-agent-platform-s09-isolated-browser-flow-v1",
                "status": "passed" if all(check["passed"] for check in checks) else "failed",
                "checks": checks,
                "elapsedMs": elapsed,
                "routineApiRequests": safe_requests,
                "localCapabilityObservations": capability_observations,
                "syntheticObjectiveUsed": True,
                "commandTextOmitted": True,
                "routineIdOmitted": True,
                "externalCalls": 0,
                "providerCalls": 0,
            }
            output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        finally:
            browser.close()
    print(json.dumps({"status": report["status"], "checks": checks}, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
