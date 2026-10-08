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


def main(docx_path: Path, report_data_path: Path, output_path: Path) -> None:
    issues: list[str] = []
    sha256 = hashlib.sha256(docx_path.read_bytes()).hexdigest()
    data = json.loads(report_data_path.read_text(encoding="utf-8"))

    with zipfile.ZipFile(docx_path) as archive:
        corrupt_member = archive.testzip()
        names = set(archive.namelist())
        document_xml = archive.read("word/document.xml")
        core_xml = archive.read("docProps/core.xml")
    if corrupt_member:
        issues.append(f"Corrupt ZIP member: {corrupt_member}")
    if any("comment" in name.lower() for name in names):
        issues.append("Comment-related package part remains")

    root = etree.fromstring(document_xml)
    tracked = {
        tag: len(root.xpath(f".//w:{tag}", namespaces=NS))
        for tag in ("ins", "del", "moveFrom", "moveTo")
    }
    if any(tracked.values()):
        issues.append(f"Tracked changes remain: {tracked}")

    tables = root.xpath(".//w:tbl", namespaces=NS)
    widths: list[str | None] = []
    indents: list[str | None] = []
    repeating_headers = 0
    cant_split_rows = 0
    total_rows = 0
    for table in tables:
        width = table.find("./w:tblPr/w:tblW", NS)
        indent = table.find("./w:tblPr/w:tblInd", NS)
        widths.append(width.get(qn("w")) if width is not None else None)
        indents.append(indent.get(qn("w")) if indent is not None else None)
        first_row = table.find("./w:tr", NS)
        if first_row is not None and first_row.find("./w:trPr/w:tblHeader", NS) is not None:
            repeating_headers += 1
        for row in table.findall("./w:tr", NS):
            total_rows += 1
            if row.find("./w:trPr/w:cantSplit", NS) is not None:
                cant_split_rows += 1
    if any(width != "9360" for width in widths):
        issues.append("One or more tables do not use 9360-DXA width")
    if any(indent != "120" for indent in indents):
        issues.append("One or more tables do not use 120-DXA indent")
    if repeating_headers != len(tables):
        issues.append(f"Only {repeating_headers}/{len(tables)} tables repeat their header")
    if cant_split_rows != total_rows:
        issues.append(f"Only {cant_split_rows}/{total_rows} rows prevent page splitting")

    doc = Document(docx_path)
    paragraphs = list(doc.paragraphs)
    all_text = "\n".join(root.xpath(".//w:t/text()", namespaces=NS))
    appendix_start = next((i for i, p in enumerate(paragraphs) if p.text.startswith("부록 B.")), None)
    closing_start = next((i for i, p in enumerate(paragraphs) if p.text == "최종 운영 결론"), len(paragraphs))
    detail_ids: list[str] = []
    if appendix_start is None:
        issues.append("Appendix B heading is missing")
    else:
        for paragraph in paragraphs[appendix_start + 1:closing_start]:
            if paragraph.style.name == "Heading 2":
                match = re.match(r"^(E\d{2})\b", paragraph.text)
                if match:
                    detail_ids.append(match.group(1))
    expected_ids = [f"E{index:02d}" for index in range(1, 51)]
    if detail_ids != expected_ids:
        issues.append(f"Appendix B IDs differ from E01-E50: {detail_ids}")

    required_tokens = [
        "500 / 500",
        "5,005 / 5,005",
        "99.0832%",
        "실제 외부 commit 0",
        "모든 미래 환경",
    ]
    for token in required_tokens:
        if token not in all_text:
            issues.append(f"Required claim token is missing: {token}")
    for command in data["corpus"]["commands"]:
        if command["command"] not in all_text:
            issues.append(f"Full command text missing: {command['id']}")

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
        "sha256": sha256,
        "sizeBytes": docx_path.stat().st_size,
        "zipIntegrity": "passed" if not corrupt_member else "failed",
        "tableCount": len(tables),
        "repeatingHeaderRows": repeating_headers,
        "totalRows": total_rows,
        "cantSplitRows": cant_split_rows,
        "appendixCommandCount": len(detail_ids),
        "appendixCommandIds": detail_ids,
        "trackedChangeCounts": tracked,
        "commentParts": sorted(name for name in names if "comment" in name.lower()),
        "creator": creator,
        "lastModifiedBy": last_modified_by,
        "issues": issues,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in (
        "status", "sha256", "sizeBytes", "tableCount", "repeatingHeaderRows",
        "appendixCommandCount", "trackedChangeCounts", "issues"
    )}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: qa-extreme-workflow-docx-structure.py <docx> <report-data.json> <output.json>")
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
