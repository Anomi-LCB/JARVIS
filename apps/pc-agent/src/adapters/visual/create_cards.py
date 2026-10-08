import base64
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\malgunbd.ttf" if bold else r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def hex_color(value, fallback):
    value = str(value or "").strip().lstrip("#")
    if len(value) == 6:
        try:
            return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return fallback


def wrap_complete_by_pixels(draw, value, selected_font, max_width):
    text = str(value or "").replace("\r", " ").replace("\n", " ")
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if draw.textbbox((0, 0), candidate, font=selected_font)[2] <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if draw.textbbox((0, 0), word, font=selected_font)[2] <= max_width:
            current = word
            continue
        chunk = ""
        for character in word:
            candidate = chunk + character
            if chunk and draw.textbbox((0, 0), candidate, font=selected_font)[2] > max_width:
                lines.append(chunk)
                chunk = character
            else:
                chunk = candidate
        current = chunk
    if current:
        lines.append(current)
    return lines


def draw_complete_card(card, width, height):
    image = Image.new('RGB', (width, height), (13, 20, 36))
    draw = ImageDraw.Draw(image)
    margin = max(24, int(min(width, height) * 0.06))
    left, right = margin + 28, width - margin - 28
    top, bottom = margin + 24, height - margin - 24
    available_width = right - left
    accent = hex_color(card.get('accent'), (68, 113, 255))
    draw.rounded_rectangle((margin, margin, width-margin, height-margin), radius=24,
                           fill=(20, 29, 48), outline=(51, 67, 96), width=2)
    body = card.get('body') or []
    if isinstance(body, str):
        body = [body] if body else []
    fields = [('label', str(card.get('label') or ''), True, accent),
              ('title', str(card.get('title') or ''), True, (247, 249, 255)),
              ('subtitle', str(card.get('subtitle') or ''), True, accent)]
    fields += [('body:%d' % i, str(item), True, (204, 214, 232)) for i, item in enumerate(body)]
    fields += [('footer', str(card.get('footer') or ''), True, (204, 214, 232))]
    selected = None
    for step in range(21):
        scale = 1.0 - step * 0.025
        sizes = {'title': max(24, round(height * 0.070 * scale)),
                 'label': max(16, round(22 * scale)), 'subtitle': max(18, round(23 * scale)),
                 'body': max(20, round(28 * scale)), 'footer': max(18, round(22 * scale))}
        rows = []
        total_height = 0
        for role, value, bold, color in fields:
            if not value:
                continue
            selected_font = font(sizes[role.split(':')[0]], bold)
            lines = wrap_complete_by_pixels(draw, value, selected_font, available_width)
            line_height = max(draw.textbbox((0, 0), line, font=selected_font)[3]
                              - draw.textbbox((0, 0), line, font=selected_font)[1] for line in lines) + 7
            gap = 12 if role in ['title', 'subtitle', 'footer'] else 6
            rows.append((role, value, lines, selected_font, color, line_height, gap))
            total_height += line_height * len(lines) + gap
        if total_height <= bottom - top:
            selected = rows
            break
    if selected is None:
        raise ValueError('visual-card-text-overflow: increase image height or split this card')
    layout = []
    y = top
    for role, value, lines, selected_font, color, line_height, gap in selected:
        rectangles = []
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=selected_font)
            position = (left - bbox[0], y - bbox[1])
            bounds = draw.textbbox(position, line, font=selected_font)
            if bounds[0] < left or bounds[2] > right or bounds[1] < top or bounds[3] > bottom:
                raise ValueError('visual-card-text-outside-content-bounds')
            draw.text(position, line, font=selected_font, fill=color)
            rectangles.append(list(bounds))
            y += line_height
        layout.append({'role': role, 'text': value, 'lines': lines,
                       'fontSize': selected_font.size, 'bounds': rectangles})
        y += gap
    return image, {'version': 1, 'complete': True, 'contentBounds': [left, top, right, bottom], 'fields': layout}


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    width = int(payload.get("width") or 1200)
    height = int(payload.get("height") or 675)
    generated = []
    for card in payload.get("cards") or []:
        path = card["path"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        image, layout = draw_complete_card(card, width, height)
        image.save(path, "PNG", optimize=True)
        generated.append({"path": path, "width": width, "height": height, "layout": layout})
    print(json.dumps({"status": "success", "generated": generated}, ensure_ascii=False))


if __name__ == "__main__":
    main()
