from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageDraw, ImageFont


def dark_pixel_count(image: Image.Image, cutoff: int = 242) -> int:
    histogram = image.convert("L").histogram()
    return sum(histogram[:cutoff])


def page_number(path: Path) -> int:
    match = re.search(r"(\d+)$", path.stem)
    return int(match.group(1)) if match else 0


def contains_ignoring_whitespace(text: str, expected: str) -> bool:
    return re.sub(r"\s+", "", expected) in re.sub(r"\s+", "", text)


def page_analysis(path: Path) -> dict:
    with Image.open(path) as source:
        image = source.convert("RGB")
    white = Image.new("RGB", image.size, "white")
    bbox = ImageChops.difference(image, white).getbbox()
    dark = dark_pixel_count(image)
    width, height = image.size
    edge = 12
    edge_dark = sum(
        dark_pixel_count(crop)
        for crop in (
            image.crop((0, 0, width, edge)),
            image.crop((0, height - edge, width, height)),
            image.crop((0, 0, edge, height)),
            image.crop((width - edge, 0, width, height)),
        )
    )
    return {
        "file": path.name,
        "pageNumber": page_number(path),
        "width": width,
        "height": height,
        "nonWhiteBoundingBox": list(bbox) if bbox else None,
        "darkPixelCount": dark,
        "darkPixelRatio": round(dark / (width * height), 6),
        "edgeDarkPixelCount": edge_dark,
        "blank": dark < 1500,
        "edgeCollision": edge_dark > 0,
    }


def make_contact_sheets(page_paths: list[Path], output_dir: Path, chunk_size: int = 6):
    font = ImageFont.load_default()
    sheets: list[str] = []
    for chunk_index in range(0, len(page_paths), chunk_size):
        paths = page_paths[chunk_index : chunk_index + chunk_size]
        thumbnails = []
        for path in paths:
            with Image.open(path) as source:
                image = source.convert("RGB")
            thumb_width = 440
            thumb_height = round(image.height * thumb_width / image.width)
            thumb = image.resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (thumb_width + 16, thumb_height + 42), "#D9DEE7")
            canvas.paste(thumb, (8, 30))
            draw = ImageDraw.Draw(canvas)
            draw.text((10, 9), path.stem, fill="#111827", font=font)
            thumbnails.append(canvas)
        cols = 2
        rows = (len(thumbnails) + cols - 1) // cols
        cell_width = max(item.width for item in thumbnails)
        cell_height = max(item.height for item in thumbnails)
        sheet = Image.new("RGB", (cols * cell_width, rows * cell_height), "#AEB7C5")
        for index, thumb in enumerate(thumbnails):
            sheet.paste(thumb, ((index % cols) * cell_width, (index // cols) * cell_height))
        first_page = page_number(paths[0])
        last_page = page_number(paths[-1])
        sheet_path = output_dir / f"contact-{first_page:02d}-{last_page:02d}.png"
        sheet.save(sheet_path, optimize=True)
        sheets.append(sheet_path.name)
    return sheets


def resolve_pdf(render_dir: Path, explicit_pdf: Path | None) -> Path:
    if explicit_pdf:
        if not explicit_pdf.exists():
            raise SystemExit(f"Rendered PDF not found: {explicit_pdf}")
        return explicit_pdf
    pdfs = sorted(render_dir.glob("*.pdf"))
    if len(pdfs) != 1:
        raise SystemExit(f"Expected exactly one rendered PDF in {render_dir}; found {len(pdfs)}. Pass the PDF path explicitly.")
    return pdfs[0]


def render_pages(pdf, render_dir: Path) -> list[Path]:
    existing = sorted(render_dir.glob("page-*.png"), key=page_number)
    if existing:
        return existing
    output = []
    for index in range(len(pdf)):
        path = render_dir / f"page-{index + 1:02d}.png"
        pdf[index].render(scale=2).to_pil().save(path, optimize=True)
        output.append(path)
    return output


def main(render_dir: Path, explicit_pdf: Path | None = None):
    if not render_dir.exists():
        raise SystemExit(f"Render directory not found: {render_dir}")
    pdf_path = resolve_pdf(render_dir, explicit_pdf)
    pdf = pdfium.PdfDocument(str(pdf_path))
    page_paths = render_pages(pdf, render_dir)
    if not page_paths:
        raise SystemExit(f"No rendered pages found: {render_dir}")

    page_texts: list[str] = []
    text_lengths: list[int] = []
    for index in range(len(pdf)):
        text_page = pdf[index].get_textpage()
        page_text = text_page.get_text_range().strip()
        page_texts.append(page_text)
        text_lengths.append(len(page_text))

    pages = [page_analysis(path) for path in page_paths]
    expected_size = [pages[0]["width"], pages[0]["height"]]
    issues: list[str] = []
    if len(pdf) != len(page_paths):
        issues.append(f"PDF/page image count mismatch: {len(pdf)} vs {len(page_paths)}")
    expected_page_numbers = list(range(1, len(page_paths) + 1))
    actual_page_numbers = [page["pageNumber"] for page in pages]
    if actual_page_numbers != expected_page_numbers:
        issues.append(f"Page image numbering is not contiguous: {actual_page_numbers}")
    for index, page in enumerate(pages):
        if [page["width"], page["height"]] != expected_size:
            issues.append(f"{page['file']}: inconsistent page size")
        if page["blank"]:
            issues.append(f"{page['file']}: appears blank")
        if page["edgeCollision"]:
            issues.append(f"{page['file']}: dark pixels touch the outer 12 px")
        if index < len(text_lengths) and text_lengths[index] < 20:
            issues.append(f"{page['file']}: extracted text is unexpectedly short ({text_lengths[index]})")
        if index > 0 and "JARVIS CONTROL CENTER" not in page_texts[index]:
            issues.append(f"{page['file']}: running header text is missing")
        if index > 0 and "JARVIS 어나더 레벨 복합 미션 감사" not in page_texts[index]:
            issues.append(f"{page['file']}: footer text is missing")
    if not contains_ignoring_whitespace(page_texts[0], "어나더 레벨 복합 미션 50건 감사"):
        issues.append("Cover title is missing from the first page")

    sheets = make_contact_sheets(page_paths, render_dir)
    result = {
        "status": "passed" if not issues else "needs-review",
        "pdf": str(pdf_path),
        "pageCount": len(page_paths),
        "pdfPageCount": len(pdf),
        "expectedPageSize": expected_size,
        "minimumExtractedTextLength": min(text_lengths),
        "maximumExtractedTextLength": max(text_lengths),
        "issues": issues,
        "contactSheets": sheets,
        "manualVisualInspectionRequired": True,
        "pages": pages,
    }
    output = render_dir / "qa-summary.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        key: result[key]
        for key in (
            "status",
            "pageCount",
            "pdfPageCount",
            "expectedPageSize",
            "minimumExtractedTextLength",
            "issues",
            "contactSheets",
            "manualVisualInspectionRequired",
        )
    }, ensure_ascii=False))
    if issues:
        raise SystemExit(1)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit("Usage: qa-apex-workflow-docx-render.py <render-directory> [rendered.pdf]")
    directory = Path(sys.argv[1]).resolve()
    pdf_argument = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else None
    main(directory, pdf_argument)
