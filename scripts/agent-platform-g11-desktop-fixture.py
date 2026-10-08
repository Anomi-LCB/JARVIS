#!/usr/bin/env python3
"""Run a loopback-only Chromium settings fixture whose controls change position."""
from __future__ import annotations

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "apps" / "pc-agent" / "fixtures" / "g11-settings-fixture"
FIXTURE_CONFIG = ROOT / "packages" / "core" / "fixtures" / "g11-desktop-settings.json"


def find_chrome() -> str:
    paths = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    for path in paths:
        if str(path) not in {".", ""} and path.is_file():
            return str(path.resolve())
    raise FileNotFoundError("Chrome or Edge is required for isolated fixture evaluation.")


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/" or set(parse_qs(parsed.query)) - {"layout"}:
            self.send_error(404)
            return
        layout = parse_qs(parsed.query).get("layout", [""])[0]
        if layout not in {"before", "after"}:
            self.send_error(400)
            return
        body = (FIXTURE_DIR / "index.html").read_bytes().replace(b'<body>', f'<body data-layout="{layout}">'.encode())
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> int:
    evidence_path = os.environ.get("JARVIS_G11_ORACLE_EVIDENCE_PATH")
    artifact_dir = os.environ.get("JARVIS_G11_ARTIFACT_DIR")
    if not evidence_path or not artifact_dir:
        raise ValueError("G11 evidence and screenshot output paths are required.")
    config_bytes = FIXTURE_CONFIG.read_bytes()
    config = json.loads(config_bytes.decode("utf-8"))
    fixture_html = (FIXTURE_DIR / "index.html").read_bytes()
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    browser = None
    requests: list[dict[str, object]] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=find_chrome(), headless=True,
                args=["--disable-extensions", "--no-first-run", "--disable-background-networking"])
            context = browser.new_context(viewport={"width": 1200, "height": 900}, locale="ko-KR", service_workers="block")
            page = context.new_page()
            page.on("request", lambda request: requests.append({"url": request.url, "method": request.method}))
            base = f"http://127.0.0.1:{server.server_port}/"
            page.goto(f"{base}?layout={config['layoutBefore']}", wait_until="domcontentloaded")
            target = page.get_by_role("checkbox", name=config["targetAccessibleName"])
            unrelated = page.get_by_role("checkbox", name=config["unrelatedSettingAccessibleName"])
            save = page.get_by_role("button", name=config["saveButtonAccessibleName"])
            assert target.count() == 1 and save.count() == 1 and unrelated.count() == 1
            assert target.is_checked() is False and unrelated.is_checked() is False
            target_box_before = save.bounding_box()
            target.check()
            save.click()
            assert page.get_by_role("status").inner_text() == "저장됨"
            local_before = page.evaluate("key => localStorage.getItem(key)", config["storageKey"])
            assert local_before == config["expectedPersistedValue"]
            before_path = Path(artifact_dir) / "layout-before.png"
            page.screenshot(path=str(before_path), full_page=True)

            page.goto(f"{base}?layout={config['layoutAfter']}", wait_until="domcontentloaded")
            target_after = page.get_by_role("checkbox", name=config["targetAccessibleName"])
            unrelated_after = page.get_by_role("checkbox", name=config["unrelatedSettingAccessibleName"])
            save_after = page.get_by_role("button", name=config["saveButtonAccessibleName"])
            target_box_after = save_after.bounding_box()
            assert target_after.is_checked() is True and unrelated_after.is_checked() is False
            assert abs(target_box_after["y"] - target_box_before["y"]) >= config["layoutShiftMinimumPx"]
            assert page.get_by_role("status").inner_text() == "저장됨"
            local_after = page.evaluate("key => localStorage.getItem(key)", config["storageKey"])
            assert local_after == config["expectedPersistedValue"]
            target_state_after = target_after.is_checked()
            unrelated_state_after = unrelated_after.is_checked()
            saved_status_after = page.get_by_role("status").inner_text()
            after_path = Path(artifact_dir) / "layout-after.png"
            page.screenshot(path=str(after_path), full_page=True)
            context.close()
            browser.close()
            browser = None
        evidence = {
            "schemaVersion": 1,
            "scenarioId": "G11",
            "fixtureId": config["fixtureId"],
            "fixtureConfigSha256": hashlib.sha256(config_bytes).hexdigest(),
            "fixtureHtmlSha256": hashlib.sha256(fixture_html).hexdigest(),
            "layoutBefore": config["layoutBefore"],
            "layoutAfter": config["layoutAfter"],
            "accessibleTargetCount": 1,
            "accessibleSaveButtonCount": 1,
            "targetStateBefore": False,
            "targetStateAfter": target_state_after,
            "unrelatedStateBefore": False,
            "unrelatedStateAfter": unrelated_state_after,
            "savedStatusBeforeReload": "저장됨",
            "savedStatusAfterReload": saved_status_after,
            "persistedValueBeforeReload": local_before,
            "persistedValueAfterReload": local_after,
            "saveButtonYBefore": round(target_box_before["y"], 2),
            "saveButtonYAfter": round(target_box_after["y"], 2),
            "screenshotBeforeSha256": hashlib.sha256(before_path.read_bytes()).hexdigest(),
            "screenshotAfterSha256": hashlib.sha256(after_path.read_bytes()).hexdigest(),
            "screenshotBeforePath": before_path.resolve().relative_to(ROOT).as_posix(),
            "screenshotAfterPath": after_path.resolve().relative_to(ROOT).as_posix(),
            "requests": requests,
            "onlyLoopbackRequests": all(urlparse(str(item["url"])).hostname == "127.0.0.1" for item in requests),
            "externalWrites": sum(item["method"] not in {"GET", "HEAD"} for item in requests),
            "browser": "chromium-via-installed-chrome-or-edge",
            "productNativeUIAutomation": False,
        }
        Path(evidence_path).write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": "passed", "scenarioId": "G11", "requests": len(requests),
            "layoutShiftPx": round(abs(target_box_after["y"] - target_box_before["y"]), 2),
            "evidence": str(Path(evidence_path).resolve())}, ensure_ascii=False))
        return 0
    finally:
        if browser:
            browser.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
