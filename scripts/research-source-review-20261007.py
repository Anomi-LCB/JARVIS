import json, hashlib, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone

root = Path(__file__).resolve().parent.parent
out = root / 'artifacts/research-source-review-20261007'
out.mkdir(exist_ok=True)
sources = [
    ('agents-api', 'https://developers.openai.com/api/docs/guides/agents-api/overview.md'),
    ('agents-sdk', 'https://developers.openai.com/api/docs/guides/agents/sdk.md'),
    ('changelog', 'https://developers.openai.com/api/docs/changelog.md'),
    ('decisions', 'https://developers.openai.com/api/docs/guides/decisions.md'),
    ('decisions-reference', 'https://developers.openai.com/api/reference/resources/decisions/methods/create.md'),
    ('google-research', 'https://research.google/blog/rss/'),
]
rows = []
for name, url in sources:
    observed = datetime.now(timezone.utc).isoformat()
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'JARVIS-official-source-review/1.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError('source size limit')
            filename = name + ('.xml' if name == 'google-research' else '.md')
            with (out / filename).open('xb') as f:
                f.write(data)
            row = dict(name=name, url=url, finalUrl=r.url, observedAt=observed,
                       sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), file=filename)
            if name == 'google-research':
                tree = ET.fromstring(data)
                row['latestItems'] = [dict(title=i.findtext('title'), url=i.findtext('link'),
                                          publishedAt=i.findtext('pubDate'))
                                      for i in tree.findall('./channel/item')[:8]]
            rows.append(row)
    except Exception as e:
        rows.append(dict(name=name, url=url, observedAt=observed, error=str(e)))
status = (root / 'artifacts/research-heartbeat-20261007-040042-status.txt').read_text(encoding='utf-8-sig')
state, _ = json.JSONDecoder().raw_decode(status[status.index('{'):])
candidate_reviews = [dict(id=c.get('id'), review=c.get('review'), attempts=c.get('attemptCount'))
                     for c in state['candidates']]
result = dict(observedAt=datetime.now(timezone.utc).isoformat(), sources=rows,
              statusCandidateFields=list(state['candidates'][0]), candidateReviews=candidate_reviews)
with (out / 'observations.json').open('x', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False))
