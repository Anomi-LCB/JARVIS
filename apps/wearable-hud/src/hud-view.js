import {
  createWearableHudFrame,
  createWearableHudProductGate
} from './hud-adapter.js';

export function renderWearableHudText(frame) {
  return [
    'JARVIS-WEARABLE-HUD',
    ...frame.lines.map((line) => line.text)
  ].join('\n');
}

export function renderWearableHudHtml(frame = createWearableHudFrame()) {
  const lines = frame.lines.map((line) => (
    `<div class="hud-line hud-${escapeHtml(line.slot)}" data-slot="${escapeHtml(line.slot)}">${escapeHtml(line.text)}</div>`
  )).join('\n');
  const progress = progressForFrame(frame);
  const actionDeck = frame.actions?.length ? frame.actions : fallbackActionsForFrame(frame);
  const contextDeck = frame.context?.length ? frame.context : fallbackContextForFrame(frame);
  const actionHtml = actionDeck.slice(0, 4).map((item) => (
    `<span class="hud-action-chip">${escapeHtml(item.label)}</span>`
  )).join('\n');
  const metricHtml = [
    ['듣기', frame.lines.find((line) => line.slot === 'voice') ? '인식됨' : '대기'],
    ['실행', frame.lines.find((line) => line.slot === 'task-status')?.text ?? '준비'],
    ['승인', approvalMetric(frame)],
    ['보안', `비식별 ${frame.privacy.redactionCount}`]
  ].map(([label, value]) => (
    `<div class="hud-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  )).join('\n');
  const leftRows = panelRows(actionDeck.slice(0, 4).map((item) => [item.label, item.phrase ?? item.command ?? item.label]));
  const rightRows = panelRows(contextDeck.slice(0, 4));
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JARVIS 웨어러블 HUD</title>
  <style>
    :root {
      color-scheme: dark;
      --hud-green: #00ff66;
      --hud-dim: #37a86b;
      --hud-bg: #000400;
      --hud-progress-deg: ${progress.value * 3.6}deg;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background: var(--hud-bg);
      color: var(--hud-green);
      font-family: Consolas, "SFMono-Regular", "Roboto Mono", monospace;
      letter-spacing: 0;
    }
    #jarvis-wearable-hud-root {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 10px;
      padding: clamp(18px, 4vh, 44px) clamp(18px, 6vw, 96px);
      background:
        linear-gradient(rgba(0, 255, 102, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 102, 0.025) 1px, transparent 1px),
        var(--hud-bg);
      background-size: 100% 8px, 44px 100%;
      text-shadow: 0 0 8px rgba(0, 255, 102, 0.32);
    }
    .hud-status-bar,
    .hud-metric,
    .hud-panel,
    .hud-focus {
      border: 1px solid rgba(55, 168, 107, 0.28);
      background: rgba(0, 10, 5, 0.74);
      box-shadow: inset 0 0 0 1px rgba(0, 255, 102, 0.035);
    }
    .hud-status-bar {
      min-height: 42px;
      display: grid;
      grid-template-columns: 170px 1fr auto;
      gap: 14px;
      align-items: center;
      padding: 8px 10px;
    }
    .hud-brand {
      display: grid;
      gap: 1px;
    }
    .hud-brand strong { font-size: 16px; line-height: 1; }
    .hud-brand span,
    .hud-action-chip,
    .hud-metric span,
    .hud-panel-kicker,
    .hud-panel-row span,
    .hud-primary span,
    .hud-primary small,
    .hud-orbit-core span,
    .hud-orbit-core small {
      color: var(--hud-dim);
      font-size: 10px;
      text-transform: uppercase;
    }
    .hud-action-deck {
      display: grid;
      grid-template-columns: repeat(4, minmax(72px, 1fr));
      gap: 8px;
    }
    .hud-action-chip,
    .hud-chip {
      min-height: 20px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(55, 168, 107, 0.24);
      background: rgba(0, 8, 4, 0.72);
      border-radius: 3px;
    }
    .hud-metric-rail {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .hud-metric {
      min-height: 52px;
      display: grid;
      align-content: center;
      gap: 2px;
      padding: 8px 10px;
    }
    .hud-metric strong {
      font-size: 16px;
      white-space: nowrap;
      overflow: hidden;
    }
    .hud-cockpit {
      display: grid;
      grid-template-columns: minmax(190px, 0.8fr) minmax(280px, 1.5fr) minmax(190px, 0.8fr);
      gap: 10px;
      min-height: 0;
    }
    .hud-panel {
      display: grid;
      align-content: start;
      gap: 9px;
      padding: 10px;
      min-width: 0;
    }
    .hud-panel-kicker {
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(55, 168, 107, 0.22);
    }
    .hud-panel-row {
      display: grid;
      gap: 3px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(55, 168, 107, 0.14);
    }
    .hud-panel-row strong {
      font-size: 15px;
      white-space: nowrap;
      overflow: hidden;
    }
    .hud-focus {
      display: grid;
      grid-template-columns: minmax(150px, 0.7fr) minmax(260px, 1.3fr);
      grid-template-rows: auto 1fr;
      gap: 12px;
      align-content: center;
      padding: clamp(14px, 3vh, 28px);
      min-width: 0;
    }
    .hud-orbit {
      grid-row: 1 / span 2;
      width: min(26vmin, 190px);
      aspect-ratio: 1;
      position: relative;
      justify-self: center;
      align-self: center;
      display: grid;
      place-items: center;
      border-radius: 999px;
      background:
        radial-gradient(circle at center, #000400 0 55%, transparent 56%),
        conic-gradient(var(--hud-green) var(--hud-progress-deg), rgba(55, 168, 107, 0.18) 0);
    }
    .hud-orbit::before {
      content: "";
      width: 76%;
      aspect-ratio: 1;
      border-radius: 999px;
      border: 1px solid rgba(55, 168, 107, 0.24);
      position: absolute;
    }
    .hud-orbit-core {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      gap: 6px;
    }
    .hud-orbit-core strong {
      font-size: clamp(34px, 8vmin, 68px);
      line-height: 0.9;
    }
    .hud-primary {
      align-self: end;
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .hud-primary strong {
      font-size: clamp(20px, 4vmin, 36px);
      line-height: 1.08;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .hud-lines {
      display: grid;
      align-content: start;
      gap: 6px;
      min-height: 0;
    }
    .hud-line {
      min-height: 22px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: clamp(13px, 2.4vmin, 20px);
      line-height: 1.15;
      color: rgba(0, 255, 102, 0.86);
      border-top: 1px solid rgba(55, 168, 107, 0.13);
      padding-top: 5px;
    }
    @media (max-width: 560px) {
      #jarvis-wearable-hud-root {
        grid-template-rows: auto 1fr;
        gap: 6px;
        padding: 10px;
      }
      .hud-status-bar {
        grid-template-columns: minmax(0, 1fr) auto;
        min-height: 32px;
        gap: 8px;
        padding: 6px 8px;
      }
      .hud-brand span,
      .hud-cockpit > .hud-panel:first-child {
        display: none;
      }
      .hud-action-deck {
        grid-template-columns: repeat(2, minmax(58px, 1fr));
        gap: 4px;
      }
      .hud-metric-rail {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .hud-cockpit {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(0, 1fr) auto;
        gap: 6px;
        min-height: 0;
      }
      .hud-focus {
        grid-template-columns: minmax(82px, 0.35fr) minmax(0, 1fr);
        grid-template-rows: auto auto;
        gap: 8px;
        padding: 10px;
      }
      .hud-orbit {
        grid-row: 1 / span 2;
        width: min(28vmin, 112px);
      }
      .hud-orbit-core { gap: 3px; }
      .hud-orbit-core strong { font-size: clamp(24px, 8vmin, 36px); }
      .hud-primary {
        align-self: center;
        gap: 3px;
      }
      .hud-primary strong { font-size: clamp(18px, 5vmin, 24px); }
      .hud-lines { gap: 3px; }
      .hud-line {
        min-height: 18px;
        font-size: 12px;
        padding-top: 3px;
      }
      .hud-panel {
        gap: 4px;
        padding: 8px;
      }
      .hud-panel-kicker { padding-bottom: 5px; }
      .hud-panel-row {
        min-height: 36px;
        padding: 5px 0;
      }
      .hud-panel-row strong { font-size: 13px; }
    }
  </style>
</head>
<body>
  <main id="jarvis-wearable-hud-root" data-frame-version="${escapeHtml(frame.frameVersion)}">
    <header class="hud-status-bar">
      <div class="hud-brand"><strong>JARVIS</strong><span aria-label="웨어러블 관제">웨어러블 실행</span></div>
      <div class="hud-action-deck">${actionHtml}</div>
      <span class="hud-chip">${escapeHtml(modeLabelKo(frame.mode))}</span>
    </header>
    <section class="hud-metric-rail">${metricHtml}</section>
    <section class="hud-cockpit">
      <aside class="hud-panel"><div class="hud-panel-kicker">01 말할 수 있는 것</div>${leftRows}</aside>
      <section class="hud-focus">
        <div class="hud-orbit">
          <div class="hud-orbit-core">
            <span>${escapeHtml(progress.label)}</span>
            <strong>${progress.value}%</strong>
            <small>${escapeHtml(progress.eta)}</small>
          </div>
        </div>
        <div class="hud-primary">
          <span>지금</span>
          <strong>${escapeHtml(primaryTitle(frame))}</strong>
          <small>${escapeHtml(primarySubtitle(frame))}</small>
        </div>
        <div class="hud-lines">${lines}</div>
      </section>
      <aside class="hud-panel"><div class="hud-panel-kicker">02 지금 필요한 판단</div>${rightRows}</aside>
    </section>
  </main>
</body>
</html>
`;
}

export function createWearableHudViewProductGate({ frame, voiceIntent, approvalState, bridgeSyncPlan } = {}) {
  const html = renderWearableHudHtml(frame);
  return createWearableHudProductGate({
    frame,
    voiceIntent,
    approvalState,
    bridgeSyncPlan,
    html
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function panelRows(rows) {
  return rows.map(([label, value]) => (
    `<div class="hud-panel-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  )).join('\n');
}

function riskLabel(frame) {
  const riskLine = frame.lines.find((line) => line.slot === 'approval-risk')?.text;
  return riskLine ? riskLine.replace(/^위험\s*/i, '') : '정상';
}

function approvalMetric(frame) {
  const approval = frame.lines.find((line) => line.slot === 'approval-action')?.text;
  if (approval) return approval;
  return frame.lines.find((line) => line.slot === 'approval-risk')?.text ?? '없음';
}

function fallbackActionsForFrame(frame) {
  if (frame.mode === 'approval') {
    return [
      { label: 'PC 확인 요청', phrase: '자비스 PC 확인' },
      { label: '거절', phrase: '자비스 거절' },
      { label: '다시 듣기', phrase: '자비스 다시' },
      { label: '숨김', phrase: '자비스 조용히' }
    ];
  }
  if (frame.mode === 'focus') {
    return [
      { label: '진행 확인', phrase: '자비스 상태' },
      { label: '화면 캡처', phrase: '자비스 현재 화면 캡처' },
      { label: '메모 추가', phrase: '자비스 음성 메모 저장' },
      { label: '숨김', phrase: '자비스 조용히' }
    ];
  }
  return [
    { label: '회의 녹음', phrase: '자비스 회의 녹음 시작' },
    { label: '화면 캡처', phrase: '자비스 현재 화면 캡처' },
    { label: '음성 메모', phrase: '자비스 음성 메모 저장' },
    { label: '승인 확인', phrase: '자비스 승인 대기 보여줘' }
  ];
}

function fallbackContextForFrame(frame) {
  if (frame.mode === 'approval') {
    return [
      ['판단', primaryTitle(frame)],
      ['허용', primarySubtitle(frame)],
      ['위험', riskLabel(frame)],
      ['대안', '거절 가능']
    ];
  }
  return [
    ['준비', frame.mode === 'focus' ? '작업 진행 중' : '바로 말하기 가능'],
    ['추천', '회의 녹음 / 화면 캡처'],
    ['승인', approvalMetric(frame)],
    ['보안', '원문/토큰 미저장']
  ];
}

function progressForFrame(frame) {
  if (frame.mode === 'approval') return { value: 62, label: '검토', eta: 'PC 확인' };
  if (frame.mode === 'emergency') return { value: 38, label: '확인', eta: '연결 버튼' };
  if (frame.mode === 'focus') return { value: 86, label: '집중', eta: '진행 중' };
  return { value: 100, label: '대기', eta: '말하기' };
}

function primaryTitle(frame) {
  return frame.lines.find((line) => line.slot === 'approval-summary')?.text
    ?? frame.lines.find((line) => line.slot === 'task-title')?.text
    ?? frame.lines.find((line) => line.slot === 'system')?.text
    ?? 'JARVIS';
}

function primarySubtitle(frame) {
  return frame.lines.find((line) => line.slot === 'approval-action')?.text
    ?? frame.lines.find((line) => line.slot === 'task-status')?.text
    ?? frame.lines.find((line) => line.slot === 'queue')?.text
    ?? modeLabelKo(frame.mode);
}

function modeLabelKo(mode) {
  const table = {
    approval: '승인',
    emergency: '경고',
    focus: '집중',
    glance: '요약'
  };
  return table[mode] ?? String(mode ?? '모드');
}
