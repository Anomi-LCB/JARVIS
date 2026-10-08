#!/usr/bin/env python3
"""Run privacy-minimized browser QA against the local JARVIS Control Center."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from urllib.parse import urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
READ_ONLY_COMMAND = "\ud604\uc7ac \uc791\uc5c5 \ud3f4\ub354\uc758 \ud30c\uc77c \ubaa9\ub85d\uc744 \ubcf4\uc5ec\uc918"
DESKTOP_VIEWPORT = {"width": 1440, "height": 1000}
MOBILE_VIEWPORT = {"width": 390, "height": 844}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="JARVIS Control Center browser QA")
    parser.add_argument("--url", default="http://127.0.0.1:41730/")
    parser.add_argument("--output-dir", default="artifacts/browser-qa/control-center-final")
    parser.add_argument("--chrome-path", default="")
    parser.add_argument("--skip-command", action="store_true")
    return parser.parse_args()


def validate_local_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("Control Center QA accepts loopback HTTP(S) URLs only.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Control Center QA URL must not contain credentials, query data, or fragments.")
    return value


def resolve_chrome(explicit_path: str) -> str:
    candidates = [
        explicit_path,
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise FileNotFoundError("A supported system Chrome or Edge executable was not found.")


def safe_url(value: str) -> str:
    parsed = urlparse(value)
    return f"{parsed.scheme}://{parsed.hostname}:{parsed.port or (443 if parsed.scheme == 'https' else 80)}{parsed.path}"


def layout_snapshot(page) -> dict:
    return page.evaluate(
        """
        () => {
          const root = document.documentElement;
          const visible = (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const clippedControls = [...document.querySelectorAll('button, input, select, textarea, [role="button"]')]
            .filter(visible)
            .filter((node) => node.scrollWidth > node.clientWidth + 4 || node.scrollHeight > node.clientHeight + 4)
            .map((node) => ({
              tag: node.tagName.toLowerCase(),
              id: node.id || null,
              name: node.getAttribute('name') || null,
              ariaLabel: node.getAttribute('aria-label') || null
            }))
            .slice(0, 20);
          const outsideViewportControls = [...document.querySelectorAll('button, input, select, textarea, [role="button"]')]
            .filter(visible)
            .filter((node) => {
              const rect = node.getBoundingClientRect();
              return rect.right < -1 || rect.left > innerWidth + 1;
            })
            .map((node) => ({
              tag: node.tagName.toLowerCase(),
              id: node.id || null,
              ariaLabel: node.getAttribute('aria-label') || null
            }))
            .slice(0, 20);
          return {
            viewport: { width: innerWidth, height: innerHeight },
            document: { width: root.scrollWidth, height: root.scrollHeight },
            horizontalOverflowPx: Math.max(0, root.scrollWidth - innerWidth),
            clippedControls,
            outsideViewportControls,
            mainVisible: visible(document.querySelector('main#app')),
            commandInputVisible: visible(document.querySelector('#command-input')),
            submitVisible: visible(document.querySelector('#command-console button[type="submit"]')),
            routinePanelVisible: visible(document.querySelector('.routine-control-panel')),
            routineSubmitDisabled: Boolean(document.querySelector('.routine-form button[type="submit"]')?.disabled),
            routineAuthRequired: (document.querySelector('.routine-panel-heading')?.innerText || '').includes('Core 관리자 토큰'),
            routineSafetyScopeVisible: (document.querySelector('.routine-scope')?.innerText || '').includes('물리 기기')
          };
        }
        """
    )


def model_provider_snapshot(page) -> list[dict]:
    """Return only the provider label, readiness label, and model/key-presence summary."""
    return page.locator(".model-provider-readiness li").evaluate_all(
        "nodes => nodes.map(node => ({ provider: node.querySelector('strong')?.innerText ?? '', "
        "state: node.querySelector('span')?.innerText ?? '', detail: node.querySelector('small')?.innerText ?? '' }))"
    )


def install_observers(page, sink: dict) -> None:
    page.on(
        "console",
        lambda message: sink["consoleErrors"].append(message.type)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: sink["pageErrors"].append(type(error).__name__))
    page.on(
        "requestfailed",
        lambda request: sink["requestFailures"].append(
            {"method": request.method, "url": safe_url(request.url)}
        ),
    )
    page.on(
        "response",
        lambda response: sink["httpFailures"].append(
            {"status": response.status, "url": safe_url(response.url)}
        )
        if response.status >= 400
        else None,
    )


def wait_until_command_idle(page, timeout_ms: int = 20_000) -> None:
    page.wait_for_function(
        """
        () => {
          const submit = document.querySelector('#command-console button[type="submit"]');
          return Boolean(submit && !submit.disabled && !/\ucc98\ub9ac \uc911/.test(submit.textContent || ''));
        }
        """,
        timeout=timeout_ms,
    )


def apply_screenshot_redaction(page) -> int:
    return page.evaluate(
        """
        () => {
          const selectors = ['.task-result', '.task-approval', '.live-task-list', '.attention-list'];
          let count = 0;
          for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
              if (node.querySelector(':scope > .qa-privacy-mask')) continue;
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              node.style.position = 'relative';
              const mask = document.createElement('div');
              mask.className = 'qa-privacy-mask';
              mask.setAttribute('aria-hidden', 'true');
              Object.assign(mask.style, {
                position: 'absolute', inset: '0', zIndex: '2147483647',
                display: 'grid', placeItems: 'center', background: '#101214',
                color: '#b9c2cc', border: '1px solid #39414a', fontSize: '12px',
                fontFamily: 'system-ui, sans-serif', letterSpacing: '0'
              });
              mask.textContent = 'QA \uac1c\uc778\uc815\ubcf4 \ubcf4\ud638 \ub9c8\uc2a4\ud06c';
              node.appendChild(mask);
              count += 1;
            }
          }
          return count;
        }
        """
    )


def exercise_desktop(page, output_dir: Path, skip_command: bool) -> dict:
    flow = {
        "refresh": False,
        "modeSwitch": False,
        "readOnlyCommandSubmitted": False,
        "approvalHandled": False,
        "resultVisible": False,
    }
    page.locator("[data-refresh-live]").first.click()
    page.wait_for_timeout(350)
    flow["refresh"] = True

    page.locator('[data-execution-mode="mission"]').click()
    page.locator('[data-execution-mode="task"]').click()
    flow["modeSwitch"] = True

    if not skip_command:
        page.locator("#command-input").fill(READ_ONLY_COMMAND)
        page.locator('#command-console button[type="submit"]').click()
        wait_until_command_idle(page)
        flow["readOnlyCommandSubmitted"] = True
        approval = page.locator('[data-task-decision="approve"]')
        if approval.count() > 0 and approval.first.is_visible():
            approval.first.click()
            flow["approvalHandled"] = True
            wait_until_command_idle(page)
        try:
            page.wait_for_selector(".task-result, [data-open-task]", state="visible", timeout=12_000)
            flow["resultVisible"] = True
        except PlaywrightTimeoutError:
            flow["resultVisible"] = False

    flow["screenshotRedactedNodes"] = apply_screenshot_redaction(page)
    page.screenshot(path=str(output_dir / "desktop.png"), full_page=True)
    return flow


def run_view(browser, url: str, output_dir: Path, name: str, viewport: dict, skip_command: bool) -> dict:
    context = browser.new_context(viewport=viewport, locale="ko-KR", color_scheme="light")
    page = context.new_page()
    observations = {
        "consoleErrors": [],
        "pageErrors": [],
        "requestFailures": [],
        "httpFailures": [],
    }
    install_observers(page, observations)
    started = perf_counter()
    response = page.goto(url, wait_until="domcontentloaded", timeout=20_000)
    page.wait_for_selector("main#app", state="visible", timeout=15_000)
    page.wait_for_selector("#command-input", state="visible", timeout=15_000)
    page.wait_for_timeout(750)
    initial_layout = layout_snapshot(page)
    model_providers = model_provider_snapshot(page)
    flow = None
    if name == "desktop":
        flow = exercise_desktop(page, output_dir, skip_command)
    else:
        page.locator('[data-execution-mode="mission"]').click()
        page.locator('[data-execution-mode="task"]').click()
        apply_screenshot_redaction(page)
        page.screenshot(path=str(output_dir / "mobile.png"), full_page=True)
    final_layout = layout_snapshot(page)
    elapsed_ms = round((perf_counter() - started) * 1000, 3)
    result = {
        "name": name,
        "statusCode": response.status if response else None,
        "elapsedMs": elapsed_ms,
        "initialLayout": initial_layout,
        "finalLayout": final_layout,
        "modelProviders": model_providers,
        "flow": flow,
        **observations,
    }
    context.close()
    return result


def view_passed(view: dict, require_command: bool) -> bool:
    layouts = [view["initialLayout"], view["finalLayout"]]
    layout_ready = all(
        item["mainVisible"]
        and item["commandInputVisible"]
        and item["submitVisible"]
        and item["horizontalOverflowPx"] <= 1
        and not item["clippedControls"]
        and not item["outsideViewportControls"]
        for item in layouts
    )
    errors_clean = not any(
        view[key]
        for key in ("consoleErrors", "pageErrors", "requestFailures", "httpFailures")
    )
    flow_ready = True
    if view["name"] == "desktop":
        flow = view["flow"] or {}
        flow_ready = flow.get("refresh") is True and flow.get("modeSwitch") is True
        if require_command:
            flow_ready = flow_ready and flow.get("readOnlyCommandSubmitted") is True and flow.get("resultVisible") is True
    return view["statusCode"] == 200 and layout_ready and errors_clean and flow_ready


def main() -> int:
    args = parse_args()
    url = validate_local_url(args.url)
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    chrome_path = resolve_chrome(args.chrome_path)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=chrome_path,
                headless=True,
                args=["--disable-extensions", "--no-first-run", "--disable-background-networking"],
            )
            try:
                desktop = run_view(browser, url, output_dir, "desktop", DESKTOP_VIEWPORT, args.skip_command)
                mobile = run_view(browser, url, output_dir, "mobile", MOBILE_VIEWPORT, True)
            finally:
                browser.close()
    except (PlaywrightError, OSError, ValueError) as error:
        print(f"Control Center browser QA failed to start: {type(error).__name__}", file=sys.stderr)
        return 2

    require_command = not args.skip_command
    checks = [
        {"id": "desktop-browser-flow", "passed": view_passed(desktop, require_command)},
        {"id": "mobile-browser-layout", "passed": view_passed(mobile, False)},
        {
            "id": "routine-panel-safe-without-core-credentials",
            "passed": all(
                view["initialLayout"]["routinePanelVisible"]
                and view["initialLayout"]["routineSubmitDisabled"]
                and view["initialLayout"]["routineAuthRequired"]
                and view["initialLayout"]["routineSafetyScopeVisible"]
                for view in (desktop, mobile)
            ),
        },
        {"id": "model-provider-diagnostic-rendered",
         "passed": [row.get("provider") for row in desktop["modelProviders"]] == ["xAI", "Meta Muse", "Google Gemini"]
         and all("secret" not in json.dumps(row, ensure_ascii=False).lower() for row in desktop["modelProviders"])},
        {
            "id": "privacy-minimized-report",
            "passed": READ_ONLY_COMMAND not in json.dumps([desktop, mobile], ensure_ascii=False),
        },
    ]
    report = {
        "reportVersion": "jarvis-control-center-browser-qa-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "passed" if all(check["passed"] for check in checks) else "failed",
        "checks": checks,
        "views": [desktop, mobile],
        "artifacts": {
            "desktopScreenshot": "desktop.png",
            "mobileScreenshot": "mobile.png",
        },
        "privacy": {
            "rawCommandsIncluded": False,
            "responseBodiesIncluded": False,
            "consoleMessagesIncluded": False,
            "credentialsIncluded": False,
            "screenshotContentRedacted": True,
        },
    }
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "reportPath": str(report_path)}, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
