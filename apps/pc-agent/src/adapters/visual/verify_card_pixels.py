"""Independent literal-glyph checks; no card generator or layout solver imports."""
import base64
import hashlib
import json
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont
from fontTools.ttLib import TTFont


def selected_font(size):
    candidates = [r'C:\Windows\Fonts\malgunbd.ttf', r'C:\Windows\Fonts\segoeuib.ttf', r'C:\Windows\Fonts\arialbd.ttf']
    for path in candidates:
        if os.path.isfile(path):
            return path, ImageFont.truetype(path, size=size)
    raise ValueError('pixel-verification-font-unavailable')


def verify(entry):
    card, layout = entry['card'], entry['layout']
    with open(card['path'], 'rb') as file:
        digest = hashlib.sha256(file.read()).hexdigest()
    image = Image.open(card['path']).convert('RGB')
    expected = {role: card[role] for role in ['label', 'title', 'subtitle'] if card.get(role)}
    body = card.get('body') or []
    if isinstance(body, str):
        body = [body]
    expected.update({'body:%d' % index: text for index, text in enumerate(body) if text})
    if card.get('footer'):
        expected['footer'] = card['footer']
    if list(expected) != [field['role'] for field in layout['fields']]:
        raise ValueError('pixel-verification-required-fields-mismatch')
    accent = str(card.get('accent') or '#4471ff').lstrip('#')
    try:
        if len(accent) != 6:
            raise ValueError()
        accent = tuple(int(accent[i:i+2], 16) for i in [0, 2, 4])
    except ValueError:
        accent = (68, 113, 255)
    results, fonts = [], {}
    for field in layout['fields']:
        role = field['role']
        if field['text'] != expected[role]:
            raise ValueError('pixel-verification-request-text-mismatch')
        if ''.join(''.join(field['lines']).split()) != ''.join(expected[role].split()):
            raise ValueError('pixel-verification-required-text-incomplete')
        if len(field['lines']) != len(field['bounds']):
            raise ValueError('pixel-verification-line-count-mismatch')
        path, font = selected_font(field['fontSize'])
        if path not in fonts:
            with TTFont(path) as font_file:
                cmap = set(font_file.getBestCmap())
            with open(path, 'rb') as font_bytes:
                fonts[path] = {'cmap': cmap, 'sha256': hashlib.sha256(font_bytes.read()).hexdigest()}
        if any(ord(char) not in fonts[path]['cmap'] for char in field['text'] if not char.isspace()):
            raise ValueError('pixel-verification-unsupported-glyph')
        color = accent if role in ['label', 'subtitle'] else (247, 249, 255) if role == 'title' else (204, 214, 232)
        for line, bounds in zip(field['lines'], field['bounds']):
            if len(bounds) != 4 or any(not isinstance(value, int) for value in bounds):
                raise ValueError('pixel-verification-invalid-region')
            left, top, right, bottom = bounds
            if left < 0 or top < 0 or right > image.width or bottom > image.height or right <= left or bottom <= top:
                raise ValueError('pixel-verification-region-outside-image')
            patch = Image.new('RGB', (right-left, bottom-top), (20, 29, 48))
            draw = ImageDraw.Draw(patch)
            bbox = draw.textbbox((0, 0), line, font=font)
            if bbox[2]-bbox[0] != patch.width or bbox[3]-bbox[1] != patch.height:
                raise ValueError('pixel-verification-font-bounds-mismatch')
            draw.text((-bbox[0], -bbox[1]), line, font=font, fill=color)
            if ImageChops.difference(image.crop(tuple(bounds)), patch).getbbox() is not None:
                raise ValueError('pixel-verification-glyph-pixels-mismatch')
        results.append({'role': role, 'matched': True, 'lineCount': len(field['lines']), 'fontSha256': fonts[path]['sha256']})
    return {'path': card['path'], 'sha256': digest, 'status': 'verified', 'fields': results,
            'scope': 'literal-truetype-glyph-pixels', 'semanticMeaning': 'not-evaluated', 'ocr': 'not-used'}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    request = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))
    try:
        print(json.dumps({'status': 'passed', 'cards': [verify(entry) for entry in request['entries']]}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error), 'cards': []}, ensure_ascii=False))
        sys.exit(1)
