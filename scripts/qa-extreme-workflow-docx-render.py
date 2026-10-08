from __future__ import annotations

import json
import sys
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageDraw, ImageFont


def dark_pixel_count(image: Image.Image, cutoff: int = 242) -> int:
    histogram = image.convert("L").histogram()
    return sum(histogram[:cutoff])


def page_analysis(path: Path) -> dict:
    image = Image.open(path).convert("RGB")
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
    sheets = []
    for chunk_index in range(0, len(page_paths), chunk_size):
        paths = page_paths[chunk_index : chunk_index + chunk_size]
        thumbnails = []
        for path in paths:
            image = Image.open(path).convert("RGB")
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
        for idx, thumb in enumerate(thumbnails):
            sheet.paste(thumb, ((idx % cols) * cell_width, (idx // cols) * cell_height))
        sheet_path = output_dir / f"contact-{chunk_index + 1:02d}-{chunk_index + len(paths):02d}.png"
        sheet.save(sheet_path, optimize=True)
        sheets.append(sheet_path.name)
    return sheets


def main(render_dir: Path):
    pdf_path = render_dir / "JARVIS_50_audit.pdf"
    if not pdf_path.exists():
        raise SystemExit(f"Rendered PDF not found: {pdf_path}")
    pdf = pdfium.PdfDocument(str(pdf_path))
    page_paths = sorted(render_dir.glob("page-*.png"))
    if not page_paths:
        for index in range(len(pdf)):
            page_path = render_dir / f"page-{index + 1:02d}.png"
            pdf[index].render(scale=2).to_pil().save(page_path, optimize=True)
        page_paths = sorted(render_dir.glob("page-*.png"))
    page_texts = []
    text_lengths = []
    for index in range(len(pdf)):
        page = pdf[index]
        text_page = page.get_textpage()
        page_text = text_page.get_text_range().strip()
        page_texts.append(page_text)
        text_lengths.append(len(page_text))
    pages = [page_analysis(path) for path in page_paths]
    expected_size = [pages[0]["width"], pages[0]["height"]]
    issues = []
    if len(pdf) != len(page_paths):
        issues.append(f"PDF/page image count mismatch: {len(pdf)} vs {len(page_paths)}")
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
        if index > 0 and "JARVIS 극한 복합 명령 감사" not in page_texts[index]:
            issues.append(f"{page['file']}: footer text is missing")
    sheets = make_contact_sheets(page_paths, render_dir)
    result = {
        "status": "passed" if not issues else "needs-review",
        "pageCount": len(page_paths),
        "pdfPageCount": len(pdf),
        "expectedPageSize": expected_size,
        "minimumExtractedTextLength": min(text_lengths),
        "maximumExtractedTextLength": max(text_lengths),
        "issues": issues,
        "contactSheets": sheets,
        "pages": pages,
    }
    output = render_dir / "qa-summary.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("status", "pageCount", "pdfPageCount", "expectedPageSize", "minimumExtractedTextLength", "issues", "contactSheets")}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: qa-extreme-workflow-docx-render.py <render-directory>")
    main(Path(sys.argv[1]).resolve())
