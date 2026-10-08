#!/usr/bin/env python3
"""Run a bounded, allowlisted HWPX MCP integration smoke test."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY = ROOT / "config" / "hwpx-mcp-policy.json"
DEFAULT_REPORT = ROOT / "artifacts" / "verification" / "hwpx-mcp-primitive-smoke.json"
DEFAULT_ARTIFACT_DIR = ROOT / "artifacts" / "verification" / "hwpx-mcp-smoke"
SOURCE_AFFECTING_ENV = ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")
REQUIRED_PACKAGE_ENTRIES = {
    "mimetype",
    "Contents/content.hpf",
    "Contents/section0.xml",
    "META-INF/manifest.xml",
}

anyio: Any = None
ClientSession: Any = None
StdioServerParameters: Any = None
stdio_client: Any = None


def sanitized_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    for name in SOURCE_AFFECTING_ENV:
        env.pop(name, None)
    return env


def ensure_mcp_dependencies() -> None:
    global anyio, ClientSession, StdioServerParameters, stdio_client
    try:
        import anyio as anyio_module
        from mcp import ClientSession as client_session
        from mcp.client.stdio import StdioServerParameters as server_parameters
        from mcp.client.stdio import stdio_client as stdio_client_function
    except ModuleNotFoundError:
        if os.environ.get("JARVIS_HWPX_SMOKE_BOOTSTRAPPED") == "1":
            raise
        env = sanitized_environment()
        env["JARVIS_HWPX_SMOKE_BOOTSTRAPPED"] = "1"
        completed = subprocess.run(
            [
                "uv",
                "run",
                "--no-project",
                "--with",
                "mcp==1.14.0",
                "--with",
                "anyio==4.10.0",
                "python",
                __file__,
                *sys.argv[1:],
            ],
            env=env,
            check=False,
        )
        raise SystemExit(completed.returncode)
    anyio = anyio_module
    ClientSession = client_session
    StdioServerParameters = server_parameters
    stdio_client = stdio_client_function


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected an object in {path}")
    return payload


def default_mcp_config(policy: dict[str, Any]) -> Path:
    plugin = policy["plugin"]
    return (
        Path.home()
        / ".codex"
        / "plugins"
        / "cache"
        / "hwpx"
        / plugin["pluginName"]
        / plugin["pluginVersion"]
        / ".mcp.json"
    )


def select_server(config: dict[str, Any]) -> dict[str, Any]:
    servers = config.get("mcpServers")
    server = servers.get("hwpx") if isinstance(servers, dict) else None
    if not isinstance(server, dict):
        raise RuntimeError("installed MCP config is missing the 'hwpx' server")
    return server


def validate_policy(policy: dict[str, Any], server: dict[str, Any]) -> None:
    plugin = policy.get("plugin") or {}
    routing = policy.get("routing") or {}
    limits = policy.get("limits") or {}
    allowed = routing.get("allowedTools") or []
    quarantined = [entry.get("name") for entry in routing.get("quarantinedTools") or []]
    if policy.get("defaultDeny") is not True:
        raise RuntimeError("HWPX MCP policy must default-deny unknown tools")
    if not allowed or not all(isinstance(name, str) for name in allowed):
        raise RuntimeError("HWPX MCP policy has no valid allowlist")
    if set(allowed) & set(quarantined):
        raise RuntimeError("a quarantined HWPX MCP tool is also allowlisted")
    if limits.get("advancedProfileEnabled") is not False:
        raise RuntimeError("advanced HWPX MCP profile must remain disabled")
    if server.get("command") != "uvx":
        raise RuntimeError("installed HWPX MCP launcher is not uvx")
    args = server.get("args") or []
    expected_pins = {
        f"{plugin['corePackage']}[preview]=={plugin['coreVersion']}",
        f"{plugin['serverPackage']}[mcp,oracle]=={plugin['serverVersion']}",
    }
    if not expected_pins.issubset(set(args)):
        raise RuntimeError("installed HWPX MCP package pins differ from JARVIS policy")
    env = server.get("env") or {}
    if env.get("HWPX_AUTOMATION_ADVANCED") != "0":
        raise RuntimeError("installed HWPX MCP advanced profile is unexpectedly enabled")
    if env.get("HWPX_AUTOMATION_AUTOBACKUP") != "1":
        raise RuntimeError("installed HWPX MCP automatic backup is disabled")


def structured(result: Any) -> dict[str, Any]:
    if bool(getattr(result, "isError", False)):
        raise RuntimeError("MCP tool returned an error")
    payload = getattr(result, "structuredContent", None)
    if isinstance(payload, dict):
        return payload
    for content in getattr(result, "content", ()):
        text = getattr(content, "text", None)
        if not isinstance(text, str):
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def mcp_error_code(error: BaseException) -> str | None:
    nested = getattr(error, "error", None)
    data = getattr(nested, "data", None)
    if isinstance(data, dict) and isinstance(data.get("errorCode"), str):
        return data["errorCode"]
    message = str(error)
    return "WORKSPACE_OUTSIDE_ROOT" if "WORKSPACE_OUTSIDE_ROOT" in message else None


def result_error_code(result: Any) -> str | None:
    if not bool(getattr(result, "isError", False)):
        return None
    for content in getattr(result, "content", ()):
        text = getattr(content, "text", None)
        if isinstance(text, str) and "WORKSPACE_OUTSIDE_ROOT" in text:
            return "WORKSPACE_OUTSIDE_ROOT"
    return "TOOL_EXECUTION_FAILED"


def expand_plugin_root(value: str, config_path: Path) -> str:
    return value.replace("${CLAUDE_PLUGIN_ROOT}", str(config_path.resolve().parent))


async def run_smoke(
    policy: dict[str, Any],
    config_path: Path,
    artifact_dir: Path,
) -> dict[str, Any]:
    config = load_json(config_path)
    server = select_server(config)
    validate_policy(policy, server)

    routing = policy["routing"]
    limits = policy["limits"]
    allowed = set(routing["allowedTools"])
    timeout = timedelta(milliseconds=int(limits["toolTimeoutMs"]))
    artifact_dir.mkdir(parents=True, exist_ok=True)
    document = artifact_dir / "jarvis-hwpx-mcp-smoke.hwpx"
    document.unlink(missing_ok=True)
    for stale_backup in artifact_dir.glob(f"{document.name}.bak*"):
        stale_backup.unlink(missing_ok=True)

    command = expand_plugin_root(str(server["command"]), config_path)
    command_args = [expand_plugin_root(str(value), config_path) for value in server.get("args", [])]
    env = sanitized_environment()
    env.update({
        key: expand_plugin_root(str(value), config_path)
        for key, value in (server.get("env") or {}).items()
    })
    env.update({
        "HWPX_AUTOMATION_WORKSPACE_ROOTS": json.dumps([str(artifact_dir.resolve())]),
        "HWPX_AUTOMATION_WORKFLOW_STORE": str(artifact_dir / "workflow.sqlite3"),
        "HWPX_AUTOMATION_ADVANCED": "0",
        "LOG_LEVEL": "ERROR",
    })

    params = StdioServerParameters(
        command=command,
        args=command_args,
        env=env,
        cwd=artifact_dir,
    )
    invocation_order: list[str] = []

    async with stdio_client(params, errlog=sys.stderr) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            listed = await session.list_tools()
            available = {tool.name for tool in listed.tools}
            missing = sorted(allowed - available)
            if missing:
                raise RuntimeError(f"allowlisted HWPX MCP tools are unavailable: {missing}")

            async def call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
                if name not in allowed:
                    raise RuntimeError(f"policy blocked non-allowlisted tool: {name}")
                invocation_order.append(name)
                return structured(
                    await session.call_tool(
                        name,
                        arguments,
                        read_timeout_seconds=timeout,
                    )
                )

            health = await call("mcp_server_health", {})
            if health.get("toolSurface", {}).get("status") != "ok":
                raise RuntimeError("HWPX MCP health reported a degraded tool surface")

            await call(
                "create_document",
                {
                    "filename": str(document),
                    "title": "JARVIS 한글 제어 검증",
                    "author": "JARVIS",
                },
            )
            await call(
                "add_table",
                {
                    "filename": str(document),
                    "rows": 3,
                    "cols": 2,
                    "data": [
                        ["검증 항목", "결과"],
                        ["한글 표 작성", "정상"],
                        ["MCP 연결", "정상"],
                    ],
                    "idempotency_key": "jarvis-hwpx-smoke-table-v1",
                },
            )
            await call(
                "add_paragraph",
                {
                    "filename": str(document),
                    "text": "JARVIS HWPX MCP 한글 제어 검증 완료",
                    "idempotency_key": "jarvis-hwpx-smoke-paragraph-v1",
                },
            )
            await call(
                "add_paragraph",
                {
                    "filename": str(document),
                    "text": "가상 연락처 010-1234-5678 / smoke@example.com",
                    "idempotency_key": "jarvis-hwpx-smoke-pii-v1",
                },
            )
            text_receipt = await call(
                "get_document_text",
                {"filename": str(document), "mask": True},
            )
            masked_text = str(text_receipt.get("text", ""))
            if "JARVIS HWPX MCP 한글 제어 검증 완료" not in masked_text:
                raise RuntimeError("Korean paragraph round-trip verification failed")
            if "010-1234-5678" in masked_text or "smoke@example.com" in masked_text:
                raise RuntimeError("default PII masking exposed fixture data")
            if "010-****-****" not in masked_text:
                raise RuntimeError("default phone-number masking was not applied")

            denied_root = Path(tempfile.mkdtemp(prefix="jarvis-hwpx-denied-"))
            denied_path = denied_root / "outside-denied.hwpx"
            denial_code: str | None = None
            try:
                try:
                    denied_result = await session.call_tool(
                        "create_document",
                        {"filename": str(denied_path)},
                        read_timeout_seconds=timeout,
                    )
                except Exception as error:
                    denial_code = mcp_error_code(error)
                else:
                    denial_code = result_error_code(denied_result)
                if denial_code != "WORKSPACE_OUTSIDE_ROOT" or denied_path.exists():
                    raise RuntimeError("workspace-root escape was not fail-closed")
            finally:
                try:
                    denied_root.rmdir()
                except OSError:
                    pass

            tool_surface = {
                "reportedStatus": health.get("toolSurface", {}).get("status"),
                "availableCount": len(available),
                "allowlistedAvailable": sorted(allowed & available),
                "quarantinedPresentButNotInvoked": sorted(
                    {
                        entry["name"] for entry in routing["quarantinedTools"]
                    }
                    & available
                ),
            }

    if not document.is_file():
        raise RuntimeError("HWPX MCP did not create the expected artifact")
    backups = sorted(artifact_dir.glob(f"{document.name}.bak*"))
    if limits["automaticBackupEnabled"] and not backups:
        raise RuntimeError("HWPX MCP did not create an automatic backup")
    if document.stat().st_size > int(limits["maximumOutputBytes"]):
        raise RuntimeError("HWPX MCP artifact exceeded the configured size limit")
    if not zipfile.is_zipfile(document):
        raise RuntimeError("created HWPX artifact is not an OPC package")
    with zipfile.ZipFile(document) as package:
        entries = set(package.namelist())
        missing_entries = sorted(REQUIRED_PACKAGE_ENTRIES - entries)
        if missing_entries:
            raise RuntimeError(f"created HWPX package is incomplete: {missing_entries}")

    body = document.read_bytes()
    return {
        "status": "passed",
        "document": {
            "relativePath": document.relative_to(ROOT).as_posix(),
            "size": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "requiredPackageEntriesPresent": True,
            "koreanRoundTrip": True,
            "piiMasking": True,
            "automaticBackupCount": len(backups),
        },
        "workspaceBoundary": {
            "outsideWriteDenied": True,
            "errorCode": "WORKSPACE_OUTSIDE_ROOT",
        },
        "toolSurface": tool_surface,
        "invokedTools": invocation_order,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--mcp-config", type=Path)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started = datetime.now(timezone.utc)
    report: dict[str, Any]
    try:
        policy = load_json(args.policy.resolve())
        config_path = (args.mcp_config or default_mcp_config(policy)).resolve()
        if not config_path.is_file():
            raise RuntimeError(f"installed HWPX MCP config not found: {config_path}")
        result = anyio.run(
            run_smoke,
            policy,
            config_path,
            args.artifact_dir.resolve(),
        )
        report = {
            "reportVersion": "jarvis-hwpx-mcp-primitive-smoke-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "durationMs": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
            "policyVersion": policy["policyVersion"],
            "plugin": policy["plugin"],
            **result,
        }
    except Exception as error:
        report = {
            "reportVersion": "jarvis-hwpx-mcp-primitive-smoke-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "durationMs": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
            "status": "failed",
            "errorType": type(error).__name__,
            "error": str(error)[:500],
        }

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("status") == "passed" else 1


if __name__ == "__main__":
    ensure_mcp_dependencies()
    raise SystemExit(main())
