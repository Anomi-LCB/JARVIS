import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRevisionPanel } from '../src/ui/source-revisions.js';

const escapeHtml = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

test('source revision panel requires admin access and does not expose registration controls', async () => {
  let calls = 0;
  const panel = createSourceRevisionPanel({ request: async () => { calls += 1; return {}; }, canManage: () => false, escape: escapeHtml });
  await panel.refresh();
  const markup = panel.render();
  assert.equal(calls, 0);
  assert.match(markup, /관리자 연결 필요/u);
  assert.match(markup, /관리자 토큰을 설정/u);
  assert.doesNotMatch(markup, /data-source-watch-form/u);
});

test('source revision panel lists hash-only change metadata, escapes stored values, and states no automatic execution', async () => {
  const injected = '<img src=x onerror=alert(1)>';
  const panel = createSourceRevisionPanel({
    canManage: () => true,
    escape: escapeHtml,
    request: async path => {
      assert.equal(path, '/source-revisions');
      return {
        items: [{ sourceKey: injected, sourcePath: 'C:\\workspace\\notes.md', sourceSha256: 'a'.repeat(64), revision: 2,
          observedAt: '2026-09-30T00:00:00.000Z', completedRevision: 1, attempts: 1, state: 'pending', lastError: null }],
        watches: [{ sourceKey: 'research', sourcePath: 'C:\\workspace\\notes.md', quietPeriodMs: 750, active: true, createdAt: '2026-09-29T00:00:00.000Z' }],
        watcher: { registrations: [{ sourceKey: 'research' }] }
      };
    }
  });
  await panel.refresh();
  const markup = panel.render();
  assert.match(markup, /research/u);
  assert.match(markup, /revision 2/u);
  assert.match(markup, /aaaaaaaaaaaaaaaa/u);
  assert.doesNotMatch(markup, /<img src=x/u);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(markup, /자동 실행되지 않습니다/u);
  assert.match(markup, /data-source-revision-mission="&lt;img src=x onerror=alert\(1\)&gt;"/u);
  assert.match(markup, /읽기 전용 Mission 실행/u);
  assert.match(markup, /data-source-watch-remove="research"/u);
  assert.doesNotMatch(markup, new RegExp('a'.repeat(64) + '(?!…)','u'));
});
