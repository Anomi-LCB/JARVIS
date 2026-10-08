from __future__ import annotations

import importlib.util
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches


ROOT = Path(__file__).resolve().parents[1]
BASE_PATH = ROOT / "scripts" / "build-complex-workflow-50-docx.py"
REPORT_VERSION = "jarvis-apex-workflow-50-report-v1"


def load_base_module():
    spec = importlib.util.spec_from_file_location("jarvis_apex_docx_base", BASE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load DOCX helpers: {BASE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


B = load_base_module()


def apply_standard_business_brief_tokens(doc):
    """Resolve the standard_business_brief preset; navy table heads are the APEX evidence-grid override."""
    section = doc.sections[0]
    section.top_margin = Inches(1.0)
    section.bottom_margin = Inches(1.0)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)
    normal = doc.styles["Normal"]
    normal.paragraph_format.space_before = B.Pt(0)
    normal.paragraph_format.space_after = B.Pt(6)
    normal.paragraph_format.line_spacing = 1.10
    for name in ("List Bullet", "List Bullet 2", "List Number", "List Number 2"):
        style = doc.styles[name]
        style.paragraph_format.space_after = B.Pt(8)
        style.paragraph_format.line_spacing = 1.167


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Required report data is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid report JSON at {path}: {exc}") from exc


def canonical_sha256(value) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def clear_paragraph(paragraph):
    for child in list(paragraph._element):
        paragraph._element.remove(child)


def set_repeat_safe_row(row):
    tr_pr = row._tr.get_or_add_trPr()
    if tr_pr.find(qn("w:cantSplit")) is None:
        tr_pr.append(OxmlElement("w:cantSplit"))


def add_table(*args, **kwargs):
    table = B.add_table(*args, **kwargs)
    for row in table.rows:
        set_repeat_safe_row(row)
    return table


def rewrite_header_footer(doc):
    section = doc.sections[0]
    header = section.header
    header_p = header.paragraphs[0]
    clear_paragraph(header_p)
    header_p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    B.set_run_font(
        header_p.add_run("JARVIS CONTROL CENTER  ·  APEX RESILIENCE AUDIT"),
        size=8.5,
        color=B.MID_GRAY,
        bold=True,
    )

    footer = section.footer
    footer_p = footer.paragraphs[0]
    clear_paragraph(footer_p)
    footer_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    B.set_run_font(footer_p.add_run("JARVIS 어나더 레벨 복합 미션 감사  |  "), size=8.5, color=B.MID_GRAY)
    page_run = footer_p.add_run()
    B.set_run_font(page_run, size=8.5, color=B.MID_GRAY)
    B.add_field(page_run, " PAGE ")
    B.set_run_font(footer_p.add_run(" / "), size=8.5, color=B.MID_GRAY)
    total_run = footer_p.add_run()
    B.set_run_font(total_run, size=8.5, color=B.MID_GRAY)
    B.add_field(total_run, " NUMPAGES ")


def pct(value, digits=4):
    if value is None:
        return "계산 불가"
    return f"{float(value) * 100:.{digits}f}%"


def compact(value, limit=210):
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        text = str(value or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def terminal_ko(value):
    return {
        "COMPLETED": "완료",
        "BLOCKED": "안전 정지",
        "ROLLED_BACK": "롤백 완료",
    }.get(value, value or "-")


def verdict_ko(value):
    return {
        "passed-with-explicit-scope": "검증 범위 내 통과",
        "failed-or-incomplete": "실패 또는 증거 미완료",
    }.get(value, value or "-")


def add_cover(doc, data):
    initial = data["progression"]["initial"]
    final = data["progression"]["final"]
    soak = data["progression"]["soak"]
    reverify = data["independentReverification"]

    kicker = doc.add_paragraph()
    kicker.paragraph_format.space_before = B.Pt(26)
    kicker.paragraph_format.space_after = B.Pt(8)
    B.set_run_font(kicker.add_run("FINAL EVIDENCE REPORT"), size=10, color=B.BLUE, bold=True)

    title = doc.add_paragraph()
    title.paragraph_format.space_after = B.Pt(8)
    B.set_run_font(title.add_run("JARVIS 제어센터"), size=29, color=B.NAVY, bold=True)
    title.add_run().add_break(WD_BREAK.LINE)
    B.set_run_font(title.add_run("어나더 레벨 복합 미션 50건 감사"), size=22, color=B.NAVY, bold=True)

    subtitle = doc.add_paragraph()
    subtitle.paragraph_format.space_after = B.Pt(18)
    B.set_run_font(
        subtitle.add_run("최초 실패 공개 · 원인/솔루션 추적 · 최종 재시험 · 반복 검증 · 증거 해시"),
        size=12.2,
        color=B.MID_GRAY,
    )

    metadata = [
        ("작성 기준", data["generatedAt"]),
        ("고정 코퍼스", f"50건 / SHA-256 {data['corpus']['corpusSha256'][:16]}…"),
        ("반복 규모", f"{soak['cycles']}회 · {soak['totalExecutions']}건"),
        ("명목상 단측 99% 하한", pct(data["statistics"]["oneSided99PercentSuccessRateLowerBound"])),
        ("판정", verdict_ko(data["verdict"]["status"])),
    ]
    for label, value in metadata:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = B.Pt(3)
        B.set_run_font(paragraph.add_run(f"{label}: "), size=10.5, bold=True)
        B.set_run_font(paragraph.add_run(str(value)), size=10.5)

    metric_values = [[
        f"행동 {initial['behavioralPass']} / {initial['totalExecutions']}\n계약 {initial['contractPass']} / {initial['totalExecutions']}",
        f"행동 {final['behavioralPass']} / {final['totalExecutions']}\n계약 {final['contractPass']} / {final['totalExecutions']}",
        f"행동 {soak['behavioralPass']} / {soak['totalExecutions']}\n계약 {soak['contractPass']} / {soak['totalExecutions']}",
        f"{reverify['soak']['passed']} / {reverify['soak']['checkCount']} checks\n실물 {reverify['soak']['retainedWorkspaceArtifactVerifications']} · seal {reverify['soak']['compactedHashChainSealVerifications']}",
    ]]
    metric = add_table(doc, ["최초", "최종", f"반복 {soak['cycles']}회", "반복 재검증"], metric_values, [2340] * 4, font_size=9)
    for index, cell in enumerate(metric.rows[1].cells):
        passing = index > 0 and (final["failed"] == 0 if index == 1 else soak["failed"] == 0)
        if index == 3:
            passing = reverify["soak"]["failed"] == 0
        fill = B.PALE_GREEN if passing else B.PALE_RED
        color = B.GREEN if passing else B.RED
        B.set_cell_shading(cell, fill)
        B.set_cell_text(cell, metric_values[0][index], bold=True, color=color, size=12.5, align=WD_ALIGN_PARAGRAPH.CENTER)

    failed_soak = data.get("failedSoakFinding")
    if failed_soak:
        B.add_callout(
            doc,
            "보존된 교정 전 반복 실패",
            f"행동 {failed_soak['behavioralPass']}/{failed_soak['totalExecutions']}건은 통과했지만 계약은 "
            f"{failed_soak['contractPass']}/{failed_soak['totalExecutions']}건만 통과했다. "
            f"{', '.join(failed_soak['affectedCases'])}에서 {failed_soak['failedContract']} "
            f"{failed_soak['contractFailed']}건을 보존했다.",
            fill=B.PALE_RED,
            border=B.RED,
            color=B.RED,
        )
    repository = data.get("repositoryVerification")
    if repository:
        B.add_callout(
            doc,
            "저장소 전체 회귀 검증",
            f"교정 후 gate {repository['passed']}/{repository['total']}건 통과, 실패 {repository['failed']}건 · "
            f"각 gate evidence SHA-256 재검증 완료",
            fill=B.PALE_GREEN if repository["status"] == "passed" else B.PALE_RED,
            border=B.GREEN if repository["status"] == "passed" else B.RED,
            color=B.GREEN if repository["status"] == "passed" else B.RED,
        )

    verdict_fill = B.PALE_GREEN if data["verdict"]["status"] == "passed-with-explicit-scope" else B.PALE_RED
    verdict_border = B.GREEN if data["verdict"]["status"] == "passed-with-explicit-scope" else B.RED
    B.add_callout(doc, "증거 기반 판정", data["verdict"]["supportedClaim"], fill=verdict_fill, border=verdict_border, color=verdict_border)
    B.add_callout(doc, "보증 경계", data["verdict"]["universalLimit"], fill=B.PALE_GOLD, border=B.GOLD, color=B.GOLD)


def add_contents(doc, data):
    B.add_heading(doc, "보고서 구성", 1, page_break=True)
    offset = 1 if data.get("failedSoakFinding") else 0
    has_repository_section = bool(data.get("repositoryVerification") or data.get("repositoryRegressionGroups"))
    repository_offset = 1 if has_repository_section else 0
    entries = [
        "1. 판정과 증거 범위",
        "2. 시험 설계와 복잡도",
        "3. 최초 실패·원인·솔루션·재시험",
    ]
    if data.get("failedSoakFinding"):
        entries.append("4. 교정 전 반복 계약 실패와 솔루션")
    entries.extend([
        f"{4 + offset}. 제품 probe 10건 전후 비교",
    ])
    if has_repository_section:
        entries.append(f"{5 + offset}. 저장소 전체 회귀 검증")
    entries.extend([
        f"{5 + offset + repository_offset}. 최종·반복 결과와 99% 통계",
        f"{6 + offset + repository_offset}. 증거 무결성과 남은 한계",
        "부록 A. A01-A50 결과표",
        "부록 B. A01-A50 명령·장애·검증 계약",
    ])
    for entry in entries:
        B.add_bullet(doc, entry)
    B.add_callout(
        doc,
        "판정 원칙",
        "BLOCKED와 ROLLED_BACK은 해당 사례가 요구한 정확한 안전 정지·원복 계약을 만족할 때만 행동 통과로 계산했다. 수정 설명이 증거에 없으면 재시험 통과와 원인 설명을 분리한다.",
        fill=B.PALE_GRAY,
        border=B.MID_GRAY,
        color=B.BLACK,
    )


def add_verdict(doc, data):
    B.add_heading(doc, "1. 판정과 증거 범위", 1, page_break=True)
    B.add_body(doc, data["verdict"]["supportedClaim"])
    rows = [
        ["행동 재시험", "통과" if data["verdict"]["behavioralEvidencePassed"] else "미통과", "최종 단일과 반복 campaign의 행동 결과"],
        ["계약 재시험", "통과" if data["verdict"]["contractEvidencePassed"] else "미통과", "종료·산출물·장애 소비·반복 의미 안정성 전체 계약"],
        ["독립 재검증", "통과" if data["verdict"]["reverificationPassed"] else "미통과", "총 check와 retained workspace 직접 검사·compacted seal 검사를 구분"],
        ["제품 probe", "통과" if data["verdict"]["productRetestPassed"] else "미통과", "동일 probe ID의 수정 전·후 대조"],
        ["원인 문서", f"{data['verdict']['remediationDocumentation']['documented']} / {len(data['initialFailureRepairs'])}", data["verdict"]["remediationDocumentation"]["note"]],
        ["미래 환경", "보증 범위 밖", data["verdict"]["universalLimit"]],
    ]
    if data.get("failedSoakFinding"):
        rows.insert(3, [
            "교정 전 soak 회귀",
            "해결" if data["verdict"]["failedSoakRegressionPassed"] else "미해결",
            f"실패 원본 보존 · remediation {data['verdict']['failedSoakRemediationDocumentation']}",
        ])
    if data.get("repositoryVerification"):
        rows.insert(-2, [
            "저장소 전체 회귀",
            "통과" if data["verdict"]["repositoryVerificationPassed"] else "미통과",
            f"gate {data['repositoryVerification']['passed']}/{data['repositoryVerification']['total']} · 원시 evidence hash 재검증",
        ])
    if data.get("repositoryRegressionGroups"):
        groups = data["repositoryRegressionGroups"]
        resolved = sum(item.get("status") == "resolved-and-regression-covered" for item in groups)
        rows.insert(-2, [
            "추가 저장소 회귀",
            "해결" if data["verdict"].get("repositoryRegressionGroupsPassed") else "미해결",
            f"원인·해결·verification gate 연결 {resolved}/{len(groups)}",
        ])
    add_table(doc, ["판정 축", "상태", "근거"], rows, [1700, 1500, 6160], font_size=9)
    B.add_callout(doc, "정확한 적용 범위", data["verdict"]["claimScope"], fill=B.PALE_BLUE, border=B.BLUE, color=B.NAVY)


def add_method(doc, data):
    corpus = data["corpus"]
    soak = data["progression"]["soak"]
    B.add_heading(doc, "2. 시험 설계와 복잡도", 1)
    rows = [
        ["명령", f"{corpus['commandCount']}건", f"{corpus['categoryCount']}개 범주, 범주별 5건"],
        ["단계", f"{corpus['checkpointCountPerCycle']}개/회", "각 명령 6단계 이상, 순서 계약 보존"],
        ["작업", f"{corpus['operationCountPerCycle']}개/회", "실제 로컬 I/O와 in-memory provider operation"],
        ["장애", f"{corpus['faultCountPerCycle']}개/회", f"반복 evidence {soak['faultCount']}개"],
        ["종료 분포", compact(corpus["expectedTerminalStates"]), "완료·안전 정지·롤백을 서로 다른 계약으로 검사"],
        ["harness 외부 계측", f"시도 {soak['realExternalAttempts']} · 반영 {soak['realExternalCommits']}", "audit harness 범위; OS 전체 네트워크 무접속 증명 아님"],
        ["trace 보충", compact(soak.get("scriptedTraceSupplements")), "call/event/fault 보충 수치를 원시 summary에서 공개"],
    ]
    add_table(doc, ["항목", "규모", "검증 방식"], rows, [1750, 2200, 5410], font_size=9)

    B.add_heading(doc, "10개 시험 범주", 2)
    category_rows = []
    for code, count in corpus["categoryCounts"].items():
        category_rows.append([corpus["categoryLabels"].get(code, code), code, count])
    add_table(doc, ["범주", "코드", "명령 수"], category_rows, [3300, 4200, 1860], font_size=9.2)


def add_initial_findings(doc, data):
    findings = data["initialFailureRepairs"]
    initial = data["progression"]["initial"]
    B.add_heading(doc, "3. 최초 실패·원인·솔루션·재시험", 1)
    B.add_body(doc, f"최초 실행은 {initial['behavioralPass']}/{initial['totalExecutions']} 통과, 실패 {initial['failed']}건이었다. 아래 원인과 솔루션은 remediation evidence에 기록된 경우에만 확정 설명으로 표시한다.")
    for defect in data.get("evidenceDefects", []):
        B.add_heading(doc, "최초 corpus 증거 직렬화 결함", 2)
        observed = defect["observed"]
        rows = [
            ["결함 ID", defect["id"]],
            ["상태", defect["status"]],
            ["원본 byte SHA-256", observed["byteSha256"]],
            ["파싱 오류", observed["parseError"]],
            ["campaign/source hash", f"{observed['campaignSelectedCorpusSha256']} / {observed.get('currentSourceCorpusSha256') or '-'}"],
            ["원인", defect.get("rootCause") or "기록 없음"],
            ["솔루션", defect.get("correction") or "기록 없음"],
            ["재검증", defect["regression"]],
        ]
        add_table(doc, ["항목", "내용"], rows, [1900, 7460], font_size=8.3, header_fill=B.DARK_BLUE, cell_vertical_margin=48)
        B.add_callout(doc, "증거 보존", "손상된 최초 corpus.json은 복원하거나 덮어쓰지 않았다. 최초 summary·result·ledger와 raw-byte hash를 사용하고 최종·반복 corpus에 완전한 무결성 검사를 적용했다.", fill=B.PALE_GOLD, border=B.GOLD, color=B.GOLD)
    if not findings:
        B.add_callout(doc, "최초 결과", "관찰된 행동 실패가 없다.", fill=B.PALE_GREEN, border=B.GREEN, color=B.GREEN)
        return

    for item in findings:
        B.add_heading(doc, f"{item['caseId']} · {item['title']}", 2)
        remediation = item["remediation"]
        root_cause = remediation.get("rootCause") or "원인 기록 없음. 최초 assertion과 engine error만 증거로 보존했다."
        correction = remediation.get("correction") or "수정 설명 없음. 최종·반복 재시험 결과와 구분해 표시한다."
        rows = [
            ["실패 분류", item["failureClass"]],
            ["최초 실패 검사", " / ".join(item["failedAssertions"]) or "engine error"],
            ["관찰 사실", item["observedDiagnosis"]],
            ["기록된 원인", root_cause],
            ["기록된 솔루션", correction],
            ["변경 파일", ", ".join(remediation.get("changedFiles") or []) or "기록 없음"],
            ["최종/반복", f"{item['finalRetest']['passed']}/{item['finalRetest']['executions']} · {item['soakRetest']['passed']}/{item['soakRetest']['executions']}"],
        ]
        add_table(doc, ["항목", "내용"], rows, [1800, 7560], font_size=8.5, header_fill=B.DARK_BLUE, cell_vertical_margin=55)
        if item["resolutionStatus"] == "resolved-and-regression-covered":
            B.add_callout(doc, "처리 상태", "원인·수정 기록과 최종·반복 통과가 모두 연결됐다.", fill=B.PALE_GREEN, border=B.GREEN, color=B.GREEN)
        elif item["resolutionStatus"] == "retested-passed-remediation-undocumented":
            B.add_callout(doc, "처리 상태", "최종·반복 통과는 확인됐지만 원인·수정 설명 evidence가 없어 구현 원인을 추정하지 않았다.", fill=B.PALE_GOLD, border=B.GOLD, color=B.GOLD)
        else:
            B.add_callout(doc, "처리 상태", "최종 또는 반복 재시험에서 아직 실패가 남아 있다.", fill=B.PALE_RED, border=B.RED, color=B.RED)


def add_failed_soak_finding(doc, data):
    finding = data.get("failedSoakFinding")
    if not finding:
        return
    B.add_heading(doc, "4. 교정 전 반복 계약 실패와 솔루션", 1)
    B.add_body(
        doc,
        f"보존된 교정 전 반복 실행은 행동 {finding['behavioralPass']}/{finding['totalExecutions']}건을 "
        f"충족했지만 전체 계약은 {finding['contractPass']}/{finding['totalExecutions']}건만 통과했다. "
        "행동 성공과 반복 안정성 계약 성공을 별도 지표로 판정했다.",
    )
    rows = [
        ["결함 ID", finding["id"]],
        ["증거 root", finding["sourceRoot"]],
        ["실패 계약", finding["failedContract"]],
        ["영향 사례", ", ".join(finding["affectedCases"]) or "기록 없음"],
        ["영향 실행", f"{finding['affectedExecutionCount']}건"],
        ["교정 전 집계", f"행동 {finding['behavioralPass']}/{finding['totalExecutions']} · 계약 {finding['contractPass']}/{finding['totalExecutions']} · 실패 {finding['contractFailed']}"],
        ["교정 전 독립 재검증", f"{finding['reverification']['passed']}/{finding['reverification']['checkCount']} · 실패 {finding['reverification']['failed']}"],
        ["관찰", finding["observed"]],
        ["기록된 원인", finding.get("rootCause") or "remediation evidence에 원인 기록 없음"],
        ["적용 솔루션", finding.get("correction") or "remediation evidence에 솔루션 기록 없음"],
        ["집중 재검증", finding.get("focusedVerification") or "별도 집중 재검증 설명 없음"],
        ["교정 후 반복", f"계약 {finding['finalSoak']['contractPass']}/{finding['finalSoak']['totalExecutions']} · 실패 {finding['finalSoak']['contractFailed']} · 독립 재검증 {finding['finalSoak']['reverificationStatus']}"],
        ["교정 후 digest 계약", f"clock profile {finding['finalSoak']['digestRegression']['profileCount']}종 × 최소 {finding['finalSoak']['digestRegression']['minimumProfileRepeats']}회 · profile 내부 exact {'안정' if finding['finalSoak']['digestRegression']['exactDigestStableWithinClockProfile'] else '불안정'} · profile 간 behavioral {'안정' if finding['finalSoak']['digestRegression']['behavioralDigestStable'] else '불안정'}"],
        ["처리 상태", f"{finding['status']} · remediation {finding['documentationStatus']}"],
    ]
    add_table(doc, ["항목", "증거 기반 내용"], rows, [2050, 7310], font_size=8.3, header_fill=B.DARK_BLUE, cell_vertical_margin=50)
    remediation_steps = finding.get("remediationSteps") or []
    if remediation_steps:
        B.add_heading(doc, "교정 단계별 추적", 2)
        remediation_rows = []
        for item in remediation_steps:
            remediation_rows.append([
                item.get("id") or "ID 미기록",
                ", ".join(item.get("cases") or []) or "사례 미기록",
                item.get("affectedExecutions") if item.get("affectedExecutions") is not None else "집중 검사 발견",
                item.get("rootCause") or "원인 미기록",
                item.get("correction") or "솔루션 미기록",
                item.get("regression") or "재검증 미기록",
            ])
        add_table(doc, ["ID", "사례", "영향", "원인", "솔루션", "재검증"], remediation_rows, [1250, 900, 750, 2050, 2350, 2060], font_size=7.3, cell_vertical_margin=42)
    fill = B.PALE_GREEN if finding["regressionPassed"] else B.PALE_RED
    border = B.GREEN if finding["regressionPassed"] else B.RED
    B.add_callout(
        doc,
        "회귀 판정",
        "교정 후 반복 증거에서 계약 실패 0건, 독립 재검증 통과, 같은 clock profile 내부 exact digest와 profile 간 behavioral digest 안정성을 모두 확인했다."
        if finding["regressionPassed"]
        else "교정 후 반복 증거에서 계약·독립 재검증·의미 digest 안정성 중 하나 이상이 아직 통과하지 않았다.",
        fill=fill,
        border=border,
        color=border,
    )


def add_product_findings(doc, data, section_number):
    product = data["productResilience"]
    B.add_heading(doc, f"{section_number}. 제품 probe 10건 전후 비교", 1)
    B.add_body(doc, f"동일한 probe ID를 수정 전과 후에 실행했다. 수정 전 {product['baseline']['passed']}/{product['baseline']['total']}, 수정 후 {product['retest']['passed']}/{product['retest']['total']}이며 해결 {product['resolvedCount']}건, 미해결 {product['unresolvedCount']}건이다.")
    rows = []
    for item in product["findings"]:
        rows.append([
            item["component"],
            item["title"],
            item["rootCause"],
            item["correction"],
            "통과" if item["retestPassed"] else "미통과",
        ])
    table = add_table(doc, ["구성요소", "결함", "원인", "적용 솔루션", "재시험"], rows, [1300, 1700, 2370, 3190, 800], font_size=7.4, cell_vertical_margin=45)
    for row in table.rows[1:]:
        B.set_cell_shading(row.cells[4], B.PALE_GREEN if row.cells[4].text == "통과" else B.PALE_RED)


def add_repository_verification(doc, data, section_number):
    verification = data.get("repositoryVerification")
    regression_groups = data.get("repositoryRegressionGroups") or []
    if not verification and not regression_groups:
        return
    B.add_heading(doc, f"{section_number}. 저장소 전체 회귀 검증", 1)
    if verification:
        B.add_body(
            doc,
            f"APEX 교정 뒤 verification evidence에 기록된 gate를 다시 검증했다. "
            f"{verification['passed']}/{verification['total']}건 통과, 실패 {verification['failed']}건이며 "
            "각 gate의 원시 evidence 파일 hash를 보고서 생성 시점에 다시 계산했다.",
        )
        add_table(doc, ["항목", "값"], [
            ["최종 상태", verification["status"]],
            ["검사 합계", f"{verification['passed']}/{verification['total']} · 실패 {verification['failed']}"],
            ["verification 파일", verification["path"]],
            ["파일 SHA-256", verification["fileSha256"]],
            ["내장 report SHA-256", verification["reportSha256"]],
        ], [2050, 7310], font_size=8.5, header_fill=B.DARK_BLUE, cell_vertical_margin=48)
        for gate in verification["gates"]:
            B.add_heading(doc, gate["id"], 2)
            gate_rows = [
                ["명령", gate["command"]],
                ["상태 / exit", f"{gate['status']} / {gate['exitCode']}"],
                ["요약", compact(gate["summary"], 700)],
                ["원시 evidence", gate["evidencePath"]],
                ["evidence SHA-256", gate["evidenceSha256"]],
            ]
            add_table(doc, ["항목", "값"], gate_rows, [1750, 7610], font_size=8.2, header_fill=B.DARK_BLUE, cell_vertical_margin=45)
        fill = B.PALE_GREEN if verification["status"] == "passed" else B.PALE_RED
        border = B.GREEN if verification["status"] == "passed" else B.RED
        B.add_callout(
            doc,
            "저장소 회귀 판정",
            "모든 gate가 exit code 0으로 통과했고 gate별 증거 hash도 일치했다."
            if verification["status"] == "passed"
            else "하나 이상의 저장소 회귀 gate가 실패했다.",
            fill=fill,
            border=border,
            color=border,
        )
    else:
        B.add_callout(
            doc,
            "verification evidence 미제공",
            "저장소 회귀 원인과 수정 기록은 있으나 실행 gate evidence가 제공되지 않아 해결을 확정하지 않았다.",
            fill=B.PALE_RED,
            border=B.RED,
            color=B.RED,
        )

    if regression_groups:
        B.add_heading(doc, "저장소 회귀 원인·해결·재검증 추적", 2)
        B.add_body(doc, "원인과 솔루션은 remediation evidence에서 읽었고, 회귀 결과는 verification evidence의 gate 명령·요약·원시 파일 hash에 연결했다.")
        rows = []
        for item in regression_groups:
            gate_text = "\n".join(
                f"{gate['id']}: {gate['status']} · {compact(gate['summary'], 220)}"
                for gate in item.get("verificationGates", [])
            ) or "연결된 gate 없음"
            files = ", ".join(item.get("changedFiles") or []) or "변경 파일 미기록"
            rows.append([
                item["id"],
                item.get("symptom") or "증상 미기록",
                item.get("rootCause") or "원인 미기록",
                f"{item.get('correction') or '솔루션 미기록'}\n파일: {files}",
                f"{item.get('regression') or '집중 재검증 설명 미기록'}\n{gate_text}",
                item["status"],
            ])
        table = add_table(
            doc,
            ["ID", "증상", "원인", "솔루션", "회귀 시험", "상태"],
            rows,
            [1350, 1350, 1750, 2200, 1900, 810],
            font_size=6.9,
            cell_vertical_margin=38,
        )
        for row in table.rows[1:]:
            B.set_cell_shading(row.cells[5], B.PALE_GREEN if row.cells[5].text == "resolved-and-regression-covered" else B.PALE_RED)


def add_results(doc, data, section_number):
    B.add_heading(doc, f"{section_number}. 최종·반복 결과와 99% 통계", 1)
    progression = data["progression"]
    rows = []
    for label, key in (("최초", "initial"), ("최종", "final"), ("반복", "soak")):
        item = progression[key]
        rows.append([
            label,
            item["cycles"],
            item["totalExecutions"],
            item["behavioralPass"],
            item["contractPass"],
            item["failed"],
            item["faultCount"],
            compact(item["terminalStates"], 100),
        ])
    add_table(doc, ["구간", "회", "총계", "행동", "계약", "실패", "fault", "terminal"], rows, [850, 520, 760, 760, 760, 650, 760, 4300], font_size=8.1)

    stats = data["statistics"]
    stat_rows = [
        ["표본", f"n={stats['sampleSize']}, 성공={stats['observedSuccesses']}, 실패={stats['observedFailures']}"],
        ["관찰 성공률", pct(stats["observedSuccessRate"])],
        ["명목상 단측 99% 하한", pct(stats["oneSided99PercentSuccessRateLowerBound"])],
        ["계산", stats["method"]],
        ["적용 범위", stats["appliesTo"]],
    ]
    add_table(doc, ["통계 항목", "값"], stat_rows, [2400, 6960], font_size=9)
    B.add_callout(doc, "통계 해석", stats["independenceQualification"], fill=B.PALE_GOLD, border=B.GOLD, color=B.GOLD)

    reverify = data["independentReverification"]
    add_table(doc, ["재검증", "검사", "실패", "결과 수", "ledger 최종 hash"], [
        ["최종", f"{reverify['final']['passed']}/{reverify['final']['checkCount']}", reverify['final']['failed'], reverify['final']['resultCount'], reverify['final']['finalLedgerHash']],
        ["반복", f"{reverify['soak']['passed']}/{reverify['soak']['checkCount']}", reverify['soak']['failed'], reverify['soak']['resultCount'], reverify['soak']['finalLedgerHash']],
    ], [1000, 1300, 800, 1000, 5260], font_size=8.1)
    add_table(doc, ["구간", "결과", "retained workspace 직접 재검증", "hash-chain-bound compacted seal", "coverage"], [
        ["최종", reverify['final']['resultCount'], reverify['final']['retainedWorkspaceArtifactVerifications'], reverify['final']['compactedHashChainSealVerifications'], "완전" if reverify['final']['artifactVerificationCoverageComplete'] else "불완전"],
        ["반복", reverify['soak']['resultCount'], reverify['soak']['retainedWorkspaceArtifactVerifications'], reverify['soak']['compactedHashChainSealVerifications'], "완전" if reverify['soak']['artifactVerificationCoverageComplete'] else "불완전"],
    ], [1000, 850, 2450, 2650, 2410], font_size=8.0)
    B.add_callout(
        doc,
        "재검증 check 해석",
        "총 check 수는 campaign·ledger·result·artifact·digest assertion을 합친 값이다. retained workspace 결과만 실물 파일을 직접 다시 읽었고, compacted 결과는 ledger hash chain에 결합된 compacted seal을 재검증했다.",
        fill=B.PALE_GOLD,
        border=B.GOLD,
        color=B.GOLD,
    )


def add_integrity(doc, data, section_number):
    B.add_heading(doc, f"{section_number}. 증거 무결성과 남은 한계", 1)
    integrity = data["evidenceIntegrity"]
    rows = [
        ["ledger hash chain", "검증 완료" if integrity["ledgerChainsVerified"] else "미완료"],
        ["내장 digest", "검증 완료" if integrity["embeddedDigestsVerified"] else "미완료"],
        ["최종 ledger", integrity["finalLedgerHash"]],
        ["반복 ledger", integrity["soakLedgerHash"]],
        ["보고서 data", data["reportSha256"]],
    ]
    if integrity.get("failedSoakLedgerHash"):
        rows.insert(4, ["교정 전 반복 ledger", integrity["failedSoakLedgerHash"]])
    add_table(doc, ["항목", "값"], rows, [2200, 7160], font_size=8.6)

    B.add_heading(doc, "주요 증거 파일", 2)
    evidence_rows = [[item["role"], item["path"], item["sha256"]] for item in data["evidenceFiles"]]
    add_table(doc, ["역할", "경로", "SHA-256"], evidence_rows, [1700, 4300, 3360], font_size=7.4, cell_vertical_margin=42)

    B.add_heading(doc, "남은 한계", 2)
    for limitation in data["limitations"]:
        B.add_bullet(doc, limitation)


def add_case_matrix(doc, data):
    B.add_heading(doc, "부록 A. A01-A50 결과표", 1, page_break=True)
    rows = []
    for item in data["corpus"]["commands"]:
        rows.append([
            item["id"],
            item["title"],
            item["categoryLabel"],
            f"{item['stepCount']}/{item['operationCount']}/{item['faultCount']}",
            terminal_ko(item["expectedTerminalState"]),
            item.get("expectedStopCode") or "-",
            f"{item['soakRetest']['passed']}/{item['soakRetest']['executions']}",
        ])
    table = add_table(doc, ["ID", "미션", "범주", "단계/작업/fault", "기대 종료", "정지 code", "반복"], rows, [520, 2440, 1500, 1100, 1100, 1900, 800], font_size=7.2, cell_vertical_margin=36)
    for row in table.rows[1:]:
        B.set_cell_shading(row.cells[4], B.PALE_GREEN if row.cells[4].text == "완료" else B.PALE_GOLD)


def add_case_details(doc, data):
    B.add_heading(doc, "부록 B. A01-A50 명령·장애·검증 계약", 1, page_break=True)
    B.add_body(doc, "각 항목은 실행에 사용한 명령 전문, 단계·작업·장애 계획, 기대 산출물과 불변조건, 최종·반복 결과를 함께 보존한다.")
    for item in data["corpus"]["commands"]:
        B.add_heading(doc, f"{item['id']} · {item['title']}", 2)
        rows = [
            ["범주", f"{item['categoryLabel']} · {item['category']}"],
            ["복잡도", f"단계 {item['stepCount']} · 작업 {item['operationCount']} · 장애 {item['faultCount']}"],
            ["기대 종료", f"{item['expectedOutcome']} · {terminal_ko(item['expectedTerminalState'])}{' · ' + item['expectedStopCode'] if item.get('expectedStopCode') else ''}"],
            ["산출물", ", ".join(item["expectedArtifacts"]) or "없음"],
            ["진단물", ", ".join(item["expectedDiagnostics"]) or "없음"],
            ["최종/반복", f"{item['finalRetest']['passed']}/{item['finalRetest']['executions']} · {item['soakRetest']['passed']}/{item['soakRetest']['executions']} · exact digest {len(item['soakRetest'].get('semanticDigests', []))}종 · behavioral digest {len(item['soakRetest'].get('behavioralDigests', [])) or '미기록'}종"],
        ]
        add_table(doc, ["항목", "내용"], rows, [1650, 7710], font_size=8.2, header_fill=B.DARK_BLUE, cell_vertical_margin=38)

        B.add_heading(doc, "명령 전문", 3)
        command = doc.add_paragraph()
        command.paragraph_format.left_indent = Inches(0.12)
        command.paragraph_format.right_indent = Inches(0.05)
        command.paragraph_format.space_after = B.Pt(7)
        command.paragraph_format.line_spacing = 1.06
        command.paragraph_format.keep_together = True
        B.set_paragraph_box(command, fill="F7F8FA", border=B.LIGHT_BORDER)
        B.set_run_font(command.add_run(item["command"]), size=8.7, color=B.BLACK)

        if item["steps"]:
            B.add_heading(doc, "단계", 3)
            for step in item["steps"]:
                B.add_bullet(doc, f"{step['id']}  {step['description']}")
        if item["faults"]:
            B.add_heading(doc, "장애 계획", 3)
            for fault in item["faults"]:
                B.add_bullet(doc, f"{fault['faultId']}  {fault['target']} / {fault['phase']} / {fault.get('effectKind') or 'effect 미기록'}{(' / ' + fault['effectCode']) if fault.get('effectCode') else ''}")
        B.add_heading(doc, "검증 계약", 3)
        B.add_bullet(doc, "scenario: " + (", ".join(item["verification"]) or "없음"))
        B.add_bullet(doc, "invariants: " + (", ".join(item["invariants"]) or "없음"))


def add_closing(doc, data):
    B.add_heading(doc, "최종 운영 결론", 1)
    B.add_body(doc, data["verdict"]["supportedClaim"])
    if data.get("repositoryVerification"):
        verification = data["repositoryVerification"]
        B.add_callout(
            doc,
            "저장소 전체 회귀",
            f"{verification['passed']}/{verification['total']} gate 통과 · gate별 원시 evidence SHA-256 검증 완료",
            fill=B.PALE_GREEN if verification["status"] == "passed" else B.PALE_RED,
            border=B.GREEN if verification["status"] == "passed" else B.RED,
            color=B.GREEN if verification["status"] == "passed" else B.RED,
        )
    if data.get("repositoryRegressionGroups"):
        groups = data["repositoryRegressionGroups"]
        resolved = sum(item.get("status") == "resolved-and-regression-covered" for item in groups)
        B.add_callout(
            doc,
            "추가 저장소 회귀",
            f"원인·해결·회귀 gate 연결 {resolved}/{len(groups)}건 완료",
            fill=B.PALE_GREEN if resolved == len(groups) else B.PALE_RED,
            border=B.GREEN if resolved == len(groups) else B.RED,
            color=B.GREEN if resolved == len(groups) else B.RED,
        )
    if data["verdict"]["remediationDocumentation"]["missing"]:
        B.add_callout(doc, "문서화 잔여", data["verdict"]["remediationDocumentation"]["note"], fill=B.PALE_GOLD, border=B.GOLD, color=B.GOLD)
    B.add_callout(doc, "보증하지 않는 범위", data["verdict"]["universalLimit"], fill=B.PALE_GOLD, border=B.GOLD, color=B.GOLD)
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = B.Pt(18)
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    B.set_run_font(paragraph.add_run("— END OF REPORT —"), size=9, color=B.MID_GRAY, bold=True)


def validate_report(data):
    if data.get("reportVersion") != REPORT_VERSION:
        raise RuntimeError(f"Unsupported report version: {data.get('reportVersion')}")
    report_payload = dict(data)
    report_payload.pop("generatedAt", None)
    declared_report_sha256 = report_payload.pop("reportSha256", None)
    actual_report_sha256 = canonical_sha256(report_payload)
    if declared_report_sha256 != actual_report_sha256:
        raise RuntimeError(
            f"Report data SHA-256 mismatch: declared={declared_report_sha256}, actual={actual_report_sha256}"
        )
    commands = data.get("corpus", {}).get("commands", [])
    expected_ids = [f"A{index:02d}" for index in range(1, 51)]
    actual_ids = [item.get("id") for item in commands]
    if actual_ids != expected_ids:
        raise RuntimeError(f"The report requires A01-A50 in order: {actual_ids}")
    evidence = data.get("evidenceFiles", [])
    if not evidence:
        raise RuntimeError("The report has no evidence file inventory.")
    for item in evidence:
        if not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))):
            raise RuntimeError(f"Invalid evidence SHA-256: {item}")
        evidence_path = (ROOT / str(item.get("path", ""))).resolve()
        try:
            evidence_path.relative_to(ROOT.resolve())
        except ValueError as exc:
            raise RuntimeError(f"Evidence path escapes the project root: {item.get('path')}") from exc
        try:
            evidence_bytes = evidence_path.read_bytes()
        except FileNotFoundError as exc:
            raise RuntimeError(f"Required evidence file is missing: {evidence_path}") from exc
        actual_evidence_sha256 = hashlib.sha256(evidence_bytes).hexdigest()
        if actual_evidence_sha256 != item["sha256"]:
            raise RuntimeError(
                f"Evidence SHA-256 mismatch: {item.get('path')} declared={item['sha256']}, actual={actual_evidence_sha256}"
            )
    for key in ("initial", "final", "soak"):
        if key not in data.get("progression", {}):
            raise RuntimeError(f"Missing progression section: {key}")
    repository = data.get("repositoryVerification")
    if repository:
        if not repository.get("gates"):
            raise RuntimeError("Repository verification has no gates.")
        for field in ("fileSha256", "reportSha256"):
            if not re.fullmatch(r"[a-f0-9]{64}", str(repository.get(field, ""))):
                raise RuntimeError(f"Invalid repository verification {field}.")
        for gate in repository["gates"]:
            if not re.fullmatch(r"[a-f0-9]{64}", str(gate.get("evidenceSha256", ""))):
                raise RuntimeError(f"Invalid gate evidence SHA-256: {gate.get('id')}")


def main(data_path: Path, output_path: Path):
    data = load_json(data_path)
    validate_report(data)
    doc = B.setup_document()
    apply_standard_business_brief_tokens(doc)
    rewrite_header_footer(doc)
    add_cover(doc, data)
    add_contents(doc, data)
    add_verdict(doc, data)
    add_method(doc, data)
    add_initial_findings(doc, data)
    add_failed_soak_finding(doc, data)
    section_offset = 1 if data.get("failedSoakFinding") else 0
    add_product_findings(doc, data, 4 + section_offset)
    repository_offset = 1 if data.get("repositoryVerification") or data.get("repositoryRegressionGroups") else 0
    add_repository_verification(doc, data, 5 + section_offset)
    add_results(doc, data, 5 + section_offset + repository_offset)
    add_integrity(doc, data, 6 + section_offset + repository_offset)
    add_case_matrix(doc, data)
    add_case_details(doc, data)
    add_closing(doc, data)

    core = doc.core_properties
    core.title = "JARVIS 제어센터 어나더 레벨 복합 미션 50건 감사 보고서"
    core.subject = "A01-A50 최초 실패, 수정, 최종 재시험, 반복 검증 및 증거 무결성"
    core.author = ""
    core.last_modified_by = ""
    core.keywords = "JARVIS, APEX, 복합 미션, 복원력, 증거 감사"
    core.comments = "Evidence-scoped report generated only from supplied APEX audit artifacts."
    core.created = datetime(2026, 9, 4, tzinfo=timezone.utc)
    core.modified = datetime.now(timezone.utc)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_path)
    print(json.dumps({
        "status": "created",
        "path": str(output_path),
        "commands": len(data["corpus"]["commands"]),
        "verdict": data["verdict"]["status"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: build-apex-workflow-50-docx.py <report-data.json> <output.docx>")
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
