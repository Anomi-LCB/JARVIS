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


def main(docx_path: Path, output_path: Path) -> None:
    issues: list[str] = []
    sha256 = hashlib.sha256(docx_path.read_bytes()).hexdigest()

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
    tracked_change_counts = {
        tag: len(root.xpath(f".//w:{tag}", namespaces=NS))
        for tag in ("ins", "del", "moveFrom", "moveTo")
    }
    if any(tracked_change_counts.values()):
        issues.append(f"Tracked changes remain: {tracked_change_counts}")

    tables = root.xpath(".//w:tbl", namespaces=NS)
    widths: list[str | None] = []
    indents: list[str | None] = []
    repeating_headers = 0
    for table in tables:
        width = table.find("./w:tblPr/w:tblW", NS)
        indent = table.find("./w:tblPr/w:tblInd", NS)
        widths.append(width.get(qn("w")) if width is not None else None)
        indents.append(indent.get(qn("w")) if indent is not None else None)
        first_row = table.find("./w:tr", NS)
        if first_row is not None and first_row.find("./w:trPr/w:tblHeader", NS) is not None:
            repeating_headers += 1
    if any(width != "9360" for width in widths):
        issues.append("One or more tables do not use the expected 9360-DXA width")
    if any(indent != "120" for indent in indents):
        issues.append("One or more tables do not use the expected 120-DXA indent")
    if repeating_headers != len(tables):
        issues.append(f"Only {repeating_headers}/{len(tables)} tables repeat their header row")

    doc = Document(docx_path)
    paragraphs = list(doc.paragraphs)
    all_text = "\n".join(p.text for p in paragraphs)
    appendix_start = next(
        (
            index
            for index, p in enumerate(paragraphs)
            if p.text.startswith("부록 B.") and p.style.name == "Heading 1"
        ),
        None,
    )
    closing_start = next(
        (index for index, p in enumerate(paragraphs) if p.text == "최종 운영 결론"),
        len(paragraphs),
    )
    detail_ids: list[str] = []
    if appendix_start is None:
        issues.append("Appendix B heading is missing")
    else:
        for paragraph in paragraphs[appendix_start + 1 : closing_start]:
            if paragraph.style.name == "Heading 2":
                match = re.match(r"^(C\d{2})\b", paragraph.text)
                if match:
                    detail_ids.append(match.group(1))
    expected_ids = [f"C{index:02d}" for index in range(1, 51)]
    if detail_ids != expected_ids:
        issues.append(f"Appendix B case IDs differ from C01-C50: {detail_ids}")

    forbidden_text = [token for token in ("4분 60초", "46건 모두 실제 재실행 성공") if token in all_text]
    if forbidden_text:
        issues.append(f"Forbidden or misleading text remains: {forbidden_text}")

    core = etree.fromstring(core_xml)
    core_ns = {
        "dc": "http://purl.org/dc/elements/1.1/",
        "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    }
    creator = core.xpath("string(./dc:creator)", namespaces=core_ns)
    last_modified_by = core.xpath("string(./cp:lastModifiedBy)", namespaces=core_ns)
    if creator or last_modified_by:
        issues.append("Creator metadata was not scrubbed")

    section_settings = [
        {
            "differentFirstPage": section.different_first_page_header_footer,
            "headerLinked": section.header.is_linked_to_previous,
            "footerLinked": section.footer.is_linked_to_previous,
        }
        for section in doc.sections
    ]

    result = {
        "status": "passed" if not issues else "needs-review",
        "path": str(docx_path),
        "sha256": sha256,
        "sizeBytes": docx_path.stat().st_size,
        "zipIntegrity": "passed" if not corrupt_member else "failed",
        "tableCount": len(tables),
        "tableWidths": sorted(set(widths), key=lambda value: str(value)),
        "tableIndents": sorted(set(indents), key=lambda value: str(value)),
        "repeatingHeaderRows": repeating_headers,
        "appendixBCaseCount": len(detail_ids),
        "appendixBCaseIds": detail_ids,
        "trackedChangeCounts": tracked_change_counts,
        "commentParts": sorted(name for name in names if "comment" in name.lower()),
        "creator": creator,
        "lastModifiedBy": last_modified_by,
        "oddAndEvenHeaders": doc.settings.odd_and_even_pages_header_footer,
        "sections": section_settings,
        "issues": issues,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in (
        "status",
        "sha256",
        "sizeBytes",
        "tableCount",
        "repeatingHeaderRows",
        "appendixBCaseCount",
        "trackedChangeCounts",
        "issues",
    )}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: qa-complex-workflow-docx-structure.py <input.docx> <output.json>")
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
