const { chromium } = require(process.env.ROKID_PLAYWRIGHT_PATH);
const path = require('node:path');

async function main() {
  const baseUrl = process.env.ROKID_QA_URL || 'http://127.0.0.1:4786';
  const outputRoot = process.env.ROKID_QA_OUTPUT || process.cwd();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ROKID_BROWSER_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const failedRequests = [];
  let screenshotResponses = 0;
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => {
    if (response.url().includes('/api/device/screenshot') && response.ok()) screenshotResponses += 1;
  });
  page.on('requestfailed', (request) => {
    if (!request.url().includes('/api/device/screen-stream')) failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.locator('[data-view="diagnostics"]').first().click();
  await page.locator('[data-live-image]').waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector('[data-live-image]')?.naturalWidth > 0, null, { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  const live = await page.evaluate(() => ({
    width: document.querySelector('[data-live-image]').naturalWidth,
    height: document.querySelector('[data-live-image]').naturalHeight,
    ready: document.querySelector('[data-live-placeholder]').classList.contains('ready'),
    status: document.querySelector('[data-live-status]').textContent,
    appOptions: document.querySelector('[data-live-app-select]').options.length,
    orientation: [...document.querySelector('[data-live-frame]').classList],
    imageTransform: getComputedStyle(document.querySelector('[data-live-image]')).transform,
    imageRotationTerms: (() => {
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('[data-live-image]')).transform);
      return { b: matrix.b, c: matrix.c };
    })(),
    frameRect: (() => { const rect = document.querySelector('[data-live-frame]').getBoundingClientRect(); return { width: Math.round(rect.width), height: Math.round(rect.height) }; })(),
    caption: document.querySelector('[data-live-activity]').textContent
  }));
  if (screenshotResponses < 2) throw new Error(`연속 화면 요청이 충분하지 않습니다: ${screenshotResponses}`);
  if (!live.orientation.includes('landscape') || Math.abs((live.frameRect.width / live.frameRect.height) - (4 / 3)) > 0.03) throw new Error(`가로 화면 비율이 아닙니다: ${JSON.stringify(live)}`);
  if (Math.abs(live.imageRotationTerms.b) > 0.001 || Math.abs(live.imageRotationTerms.c) > 0.001) throw new Error(`HUD 이미지에 회전이 남아 있습니다: ${live.imageTransform}`);
  await page.locator('[data-live-orientation]').click();
  await page.waitForTimeout(350);
  const portrait = await page.evaluate(() => {
    const frame = document.querySelector('[data-live-frame]');
    const rect = frame.getBoundingClientRect();
    return { classes: [...frame.classList], width: Math.round(rect.width), height: Math.round(rect.height), caption: document.querySelector('[data-live-activity]').textContent };
  });
  if (portrait.classes.includes('landscape') || Math.abs((portrait.width / portrait.height) - (3 / 4)) > 0.03) throw new Error(`세로 원본 전환이 올바르지 않습니다: ${JSON.stringify(portrait)}`);
  await page.locator('[data-live-orientation]').click();
  await page.screenshot({ path: path.join(outputRoot, 'qa-live-screen.png'), fullPage: true });

  await page.locator('[data-view="fine-tune"]').first().click();
  await page.locator('[data-fine-setting-card]').first().waitFor({ state: 'visible', timeout: 120_000 });
  const recommendedCount = await page.locator('[data-fine-setting-card]').count();
  await page.screenshot({ path: path.join(outputRoot, 'qa-fine-tune-recommended.png'), fullPage: true });
  await page.locator('[data-fine-category="전체"]').click();
  await page.waitForTimeout(150);
  const allCount = await page.locator('[data-fine-setting-card]').count();
  await page.screenshot({ path: path.join(outputRoot, 'qa-fine-tune.png'), fullPage: true });

  const layouts = [];
  for (const viewport of [{ width: 900, height: 900 }, { width: 620, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    layouts.push(await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      visibleCards: document.querySelectorAll('[data-fine-setting-card]').length
    })));
  }
  await page.screenshot({ path: path.join(outputRoot, 'qa-fine-tune-mobile.png'), fullPage: true });
  await browser.close();
  process.stdout.write(`${JSON.stringify({ title: await page.title().catch(() => '내 Rokid 안경'), live: { ...live, screenshotResponses, portrait }, recommendedCount, allCount, layouts, consoleErrors, failedRequests }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
