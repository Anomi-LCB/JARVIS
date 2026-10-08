from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

from docx import Document
from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}


def qn(local: str) -> str:
    return f"{{{W_NS}}}{local}"


def pct(value, digits=4):
    if value is None:
        return "계산 불가"
    return f"{float(value) * 100:.{digits}f}%"


def read_required(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except FileNotFoundError as exc:
        raise SystemExit(f"Required QA input is missing: {path}") from exc


def main(docx_path: Path, report_data_path: Path, output_path: Path) -> None:
    issues: list[str] = []
    docx_bytes = read_required(docx_path)
    try:
        data = json.loads(read_required(report_data_path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Invalid report data: {report_data_path}: {exc}") from exc
    report_payload = dict(data)
    report_payload.pop("generatedAt", None)
    declared_report_sha256 = report_payload.pop("reportSha256", None)
    actual_report_sha256 = hashlib.sha256(
        json.dumps(report_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if declared_report_sha256 != actual_report_sha256:
        issues.append(f"Report data SHA-256 mismatch: {declared_report_sha256} != {actual_report_sha256}")

    expected_ids = [f"A{index:02d}" for index in range(1, 51)]
    commands = data.get("corpus", {}).get("commands", [])
    if [item.get("id") for item in commands] != expected_ids:
        issues.append("Report data does not contain A01-A50 in order")

    try:
        with zipfile.ZipFile(docx_path) as archive:
            corrupt_member = archive.testzip()
            names = set(archive.namelist())
            document_xml = archive.read("word/document.xml")
            core_xml = archive.read("docProps/core.xml")
            word_xml_parts = [archive.read(name) for name in names if re.fullmatch(r"word/(document|header\d+|footer\d+)\.xml", name)]
    except (zipfile.BadZipFile, KeyError) as exc:
        raise SystemExit(f"Invalid DOCX package: {docx_path}: {exc}") from exc
    if corrupt_member:
        issues.append(f"Corrupt ZIP member: {corrupt_member}")
    comment_parts = sorted(name for name in names if "comment" in name.lower())
    if comment_parts:
        issues.append("Comment-related package part remains")

    root = etree.fromstring(document_xml)
    package_text = "\n".join(
        "".join(etree.fromstring(xml).xpath(".//w:t/text()", namespaces=NS))
        for xml in word_xml_parts
    )
    tracked = {tag: len(root.xpath(f".//w:{tag}", namespaces=NS)) for tag in ("ins", "del", "moveFrom", "moveTo")}
    if any(tracked.values()):
        issues.append(f"Tracked changes remain: {tracked}")

    sections = root.xpath(".//w:sectPr", namespaces=NS)
    for index, section in enumerate(sections, start=1):
        page_size = section.find("./w:pgSz", NS)
        if page_size is None or page_size.get(qn("w")) != "12240" or page_size.get(qn("h")) != "15840":
            issues.append(f"Section {index} is not US Letter portrait")

    tables = root.xpath(".//w:tbl", namespaces=NS)
    widths: list[str | None] = []
    indents: list[str | None] = []
    repeating_headers = 0
    cant_split_rows = 0
    total_rows = 0
    geometry_errors: list[str] = []
    for table_index, table in enumerate(tables, start=1):
        width_node = table.find("./w:tblPr/w:tblW", NS)
        indent_node = table.find("./w:tblPr/w:tblInd", NS)
        width = width_node.get(qn("w")) if width_node is not None else None
        indent = indent_node.get(qn("w")) if indent_node is not None else None
        widths.append(width)
        indents.append(indent)
        grid = [int(node.get(qn("w"))) for node in table.findall("./w:tblGrid/w:gridCol", NS)]
        if width != "9360" or sum(grid) != 9360:
            geometry_errors.append(f"table {table_index}: tblW={width}, grid={sum(grid)}")
        rows = table.findall("./w:tr", NS)
        if rows and rows[0].find("./w:trPr/w:tblHeader", NS) is not None:
            repeating_headers += 1
        for row_index, row in enumerate(rows, start=1):
            total_rows += 1
            if row.find("./w:trPr/w:cantSplit", NS) is not None:
                cant_split_rows += 1
            cell_widths = [int(node.get(qn("w"))) for node in row.findall("./w:tc/w:tcPr/w:tcW", NS)]
            if cell_widths and sum(cell_widths) != 9360:
                geometry_errors.append(f"table {table_index} row {row_index}: cell widths={sum(cell_widths)}")
    if geometry_errors:
        issues.append("Table geometry errors: " + "; ".join(geometry_errors[:10]))
    if any(indent != "120" for indent in indents):
        issues.append("One or more tables do not use 120-DXA indent")
    if repeating_headers != len(tables):
        issues.append(f"Only {repeating_headers}/{len(tables)} tables repeat their header")
    if cant_split_rows != total_rows:
        issues.append(f"Only {cant_split_rows}/{total_rows} rows prevent page splitting")

    doc = Document(docx_path)
    paragraphs = list(doc.paragraphs)
    main_section_numbers = []
    for paragraph in paragraphs:
        if paragraph.style.name != "Heading 1":
            continue
        match = re.match(r"^(\d+)\.", paragraph.text)
        if match:
            main_section_numbers.append(int(match.group(1)))
    expected_main_section_count = 6 + (1 if data.get("failedSoakFinding") else 0) + (1 if data.get("repositoryVerification") or data.get("repositoryRegressionGroups") else 0)
    expected_main_section_numbers = list(range(1, expected_main_section_count + 1))
    if main_section_numbers != expected_main_section_numbers:
        issues.append(f"Main section numbering differs: {main_section_numbers} != {expected_main_section_numbers}")
    appendix_start = next((index for index, paragraph in enumerate(paragraphs) if paragraph.style.name == "Heading 1" and paragraph.text.startswith("부록 B.")), None)
    closing_start = next((index for index, paragraph in enumerate(paragraphs) if paragraph.text == "최종 운영 결론"), len(paragraphs))
    detail_ids: list[str] = []
    if appendix_start is None:
        issues.append("Appendix B heading is missing")
    else:
        for paragraph in paragraphs[appendix_start + 1 : closing_start]:
            if paragraph.style.name == "Heading 2":
                match = re.match(r"^(A\d{2})\b", paragraph.text)
                if match:
                    detail_ids.append(match.group(1))
    if detail_ids != expected_ids:
        issues.append(f"Appendix B IDs differ from A01-A50: {detail_ids}")

    required_tokens = [
        "JARVIS CONTROL CENTER",
        "JARVIS 어나더 레벨 복합 미션 감사",
        f"{data['progression']['soak']['behavioralPass']} / {data['progression']['soak']['totalExecutions']}",
        pct(data["statistics"].get("oneSided99PercentSuccessRateLowerBound")),
        "harness 외부 계측",
        "영구 무결함",
        "retained workspace 직접 재검증",
        "hash-chain-bound compacted seal",
        "OS 전체 프로세스의 네트워크 무접속",
        str(data["independentReverification"]["soak"]["retainedWorkspaceArtifactVerifications"]),
        str(data["independentReverification"]["soak"]["compactedHashChainSealVerifications"]),
    ]
    required_tokens.extend(item.get("id") for item in data.get("evidenceDefects", []))
    failed_soak = data.get("failedSoakFinding")
    if failed_soak:
        required_tokens.extend([
            failed_soak.get("id"),
            failed_soak.get("failedContract"),
            f"{failed_soak.get('contractPass')}/{failed_soak.get('totalExecutions')}",
            failed_soak.get("rootCause") or "remediation evidence에 원인 기록 없음",
            failed_soak.get("correction") or "remediation evidence에 솔루션 기록 없음",
        ])
        for remediation in failed_soak.get("remediationSteps", []):
            required_tokens.extend([
                remediation.get("id"),
                remediation.get("rootCause") or "원인 미기록",
                remediation.get("correction") or "솔루션 미기록",
            ])
    repository = data.get("repositoryVerification")
    if repository:
        required_tokens.extend([
            "저장소 전체 회귀 검증",
            repository.get("fileSha256"),
            repository.get("reportSha256"),
        ])
        for gate in repository.get("gates", []):
            required_tokens.extend([
                gate.get("id"),
                gate.get("command"),
                gate.get("evidencePath"),
                gate.get("evidenceSha256"),
            ])
    for group in data.get("repositoryRegressionGroups", []):
        required_tokens.extend([
            group.get("id"),
            group.get("rootCause") or "원인 미기록",
            group.get("correction") or "솔루션 미기록",
            group.get("regression") or "집중 재검증 설명 미기록",
            group.get("status"),
        ])
        for gate in group.get("verificationGates", []):
            required_tokens.extend([gate.get("id"), gate.get("status")])
    for token in required_tokens:
        if token and token not in package_text:
            issues.append(f"Required report token is missing: {token}")
    for command in commands:
        if command.get("command") not in package_text:
            issues.append(f"Full command text missing: {command.get('id')}")

    core = etree.fromstring(core_xml)
    core_ns = {
        "dc": "http://purl.org/dc/elements/1.1/",
        "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    }
    creator = core.xpath("string(./dc:creator)", namespaces=core_ns)
    last_modified_by = core.xpath("string(./cp:lastModifiedBy)", namespaces=core_ns)
    if creator or last_modified_by:
        issues.append("Creator metadata was not scrubbed")

    result = {
        "status": "passed" if not issues else "needs-review",
        "path": str(docx_path),
        "sha256": hashlib.sha256(docx_bytes).hexdigest(),
        "sizeBytes": len(docx_bytes),
        "zipIntegrity": "passed" if not corrupt_member else "failed",
        "sectionCount": len(sections),
        "tableCount": len(tables),
        "tableWidths": widths,
        "tableIndents": indents,
        "repeatingHeaderRows": repeating_headers,
        "totalRows": total_rows,
        "cantSplitRows": cant_split_rows,
        "appendixCommandCount": len(detail_ids),
        "appendixCommandIds": detail_ids,
        "mainSectionNumbers": main_section_numbers,
        "trackedChangeCounts": tracked,
        "commentParts": comment_parts,
        "creator": creator,
        "lastModifiedBy": last_modified_by,
        "issues": issues,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        key: result[key]
        for key in (
            "status",
            "sha256",
            "sizeBytes",
            "sectionCount",
            "tableCount",
            "repeatingHeaderRows",
            "appendixCommandCount",
            "trackedChangeCounts",
            "issues",
        )
    }, ensure_ascii=False))
    if issues:
        raise SystemExit(1)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: qa-apex-workflow-docx-structure.py <docx> <report-data.json> <output.json>")
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
