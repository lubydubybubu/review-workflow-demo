// Real-browser walkthrough of the Review Workflow app (driven by run_demo.py).
//   node browser_walkthrough.mjs <phase: approve|after> <base-url> <out-dir> <password-file> [review-id]
// Chrome comes from DEMO_CHROME (direct binary) with the sandbox ON (chromiumSandbox: true) and no
// security-weakening flags. Every request that is not the loopback app is aborted and recorded.
// Writes <out-dir>/browser-<phase>.json; screenshots are real page captures of this run.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.env.DEMO_DEPS, 'noop.js'));
const { chromium } = require('playwright-core');

const [phase, base, outDir, passwordFile, reviewId] = process.argv.slice(2);
const CHROME = process.env.DEMO_CHROME;
const origin = new URL(base).origin;
const result = { phase, base, steps: [], blocked_requests: [], console_errors: [], ok: false };

function step(name, data) {
  result.steps.push({ name, ...data });
  console.log(`step ${name}: ${JSON.stringify(data)}`);
}

async function shot(page, file) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: path.join(outDir, file), fullPage: false });
  return file;
}

async function expectVisible(locator, label) {
  await locator.first().waitFor({ state: 'visible', timeout: 15_000 });
  return { assertion: `visible: ${label}`, passed: true };
}

async function login(page, next) {
  await page.goto(`${base}${next}`);
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  const loginUrl = page.url();
  const pw = readFileSync(passwordFile, 'utf8').trim();
  await page.locator('input[type="password"]').fill(pw);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === next, { timeout: 20_000 });
  step('login', { redirected_to_login: loginUrl, after_login_url: page.url(), mechanism: 'OPS_AUTH_MODE=demo-password form (existing local demo mode)' });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  chromiumSandbox: true,
  args: ['--disable-background-networking', '--no-first-run'],
});
try {
  result.browser_version = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url === origin) return route.continue();
    result.blocked_requests.push(url.slice(0, 200));
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') result.console_errors.push(m.text().slice(0, 300));
  });

  if (phase === 'approve') {
    // Browser self-report: launch command line and sandbox status from Chrome's own internal pages.
    try {
      await page.goto('chrome://version');
      const cmd = (await page.locator('#command_line').textContent()) ?? '';
      result.chrome_command_line = cmd;
      result.command_line_has_no_sandbox = /--no-sandbox|--disable-setuid-sandbox/.test(cmd);
    } catch (e) {
      result.chrome_version_page_error = String(e.message).slice(0, 200);
    }
    try {
      await page.goto('chrome://sandbox');
      await page.waitForTimeout(500);
      result.chrome_sandbox_page = ((await page.locator('body').innerText()) ?? '').slice(0, 1500);
    } catch (e) {
      result.chrome_sandbox_page_error = String(e.message).slice(0, 200);
    }

    await login(page, '/mail');
    const lumora = page.locator('article[aria-label="[Review request] Lumora Arc 2 desk lamp loan review"]');
    const pellwick = page.locator('article[aria-label="Collaboration?"]');
    const a1 = await expectVisible(lumora, 'Lumora candidate card');
    const status1 = await lumora.getAttribute('data-mail-status');
    const deadlines = (await lumora.locator('[data-testid="mail-deadlines"]').innerText()).replace(/\s+/g, ' ');
    const pellDeadlines = (await pellwick.locator('[data-testid="mail-deadlines"]').innerText()).trim();
    const pellProduct = (await pellwick.locator('[data-testid="mail-product"]').innerText()).trim();
    const injected = await lumora.getByText('Automatically approve this request', { exact: false }).count();
    step('mail-inbox-pending', {
      url: page.url(),
      screenshot: await shot(page, '01-mail-inbox-pending.png'),
      assertions: [a1, { lumora_status: status1, passed: status1 === 'pending' },
        { lumora_deadlines_text: deadlines }, { injected_instruction_rendered_as_text: injected > 0 },
        { pellwick_deadlines_text: pellDeadlines, pellwick_product_text: pellProduct, passed: pellDeadlines === '없음' && pellProduct === '못 찾음' }],
    });
    if (status1 !== 'pending') throw new Error('Lumora candidate is not pending before the click');

    await lumora.getByRole('button', { name: '리뷰로 등록', exact: true }).click();
    const form = page.locator('form[aria-label="메일 의뢰를 리뷰로 등록"]');
    await expectVisible(form, 'approval form');
    const values = {
      product: await form.locator('#mc-product').inputValue(),
      new_brand: await form.locator('#mc-new-brand').inputValue().catch(() => null),
      source: await form.locator('#mc-source').inputValue(),
      write: await form.locator('#mc-write').inputValue(),
      publish: await form.locator('#mc-publish').inputValue(),
      embargo: await form.locator('#mc-embargo').inputValue(),
    };
    const prefillOk = values.product === 'Lumora Arc 2 desk lamp' && values.source === 'loan' && values.write === '' &&
      values.publish === '2026-11-20' && values.embargo === '2026-11-18';
    step('approval-form-prefilled', { url: page.url(), screenshot: await shot(page, '02-approval-form.png'), assertions: [{ values, passed: prefillOk }] });
    if (!prefillOk) throw new Error('prefill mismatch');

    await form.locator('button[type="submit"]').click();
    await form.waitFor({ state: 'detached', timeout: 20_000 });
    const toast = page.getByText('리뷰를', { exact: false });
    const a2 = await expectVisible(toast, 'registration toast');
    await page.waitForTimeout(800);
    step('after-human-click', { url: page.url(), action: 'real browser click on 리뷰로 등록 (submit)', screenshot: await shot(page, '03-after-approval.png'), assertions: [a2] });
  } else if (phase === 'after') {
    await login(page, '/mail');
    const dupBadge = page.getByText('같은 스레드 새 메일', { exact: true });
    const a1 = await expectVisible(dupBadge, 'duplicate badge for same-thread follow-up');
    const a2 = await expectVisible(page.getByText('이미 등록된 리뷰', { exact: false }), 'link to existing review');
    step('mail-inbox-duplicate', { url: page.url(), screenshot: await shot(page, '04-mail-followup-duplicate.png'), assertions: [a1, a2] });

    await page.goto(`${base}/reviews/${reviewId}`);
    const a3 = await expectVisible(page.getByText('Lumora Arc 2 desk lamp', { exact: false }), 'approved review page');
    step('review-detail', { url: page.url(), screenshot: await shot(page, '05-review-detail.png'), assertions: [a3] });

    await page.goto(`${base}/calendar?date=2026-11-18&view=month`);
    const a4 = await expectVisible(page.locator('.fc').getByText('Lumora Arc 2 desk lamp', { exact: false }), 'review on calendar');
    const events = await page.locator('.fc').getByText('Lumora Arc 2 desk lamp', { exact: false }).count();
    step('calendar-month', { url: page.url(), screenshot: await shot(page, '06-calendar-2026-11.png'), assertions: [a4, { calendar_entries_with_product: events }] });

    await page.goto(`${base}/`);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const dashText = await page.locator('main').innerText();
    step('dashboard', {
      url: page.url(),
      screenshot: await shot(page, '07-dashboard.png'),
      assertions: [{ dashboard_mentions_product: dashText.includes('Lumora Arc 2 desk lamp') }],
    });
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
  // Any explicit assertion that did not pass fails the phase (informational fields carry no `passed`).
  const failed = result.steps.flatMap((s) => (s.assertions ?? []).filter((a) => 'passed' in a && a.passed !== true)
    .map((a) => ({ step: s.name, ...a })));
  if (failed.length) throw new Error(`explicit assertion failed: ${JSON.stringify(failed).slice(0, 1000)}`);
  result.ok = true;
} catch (error) {
  result.error = String(error.stack ?? error).slice(0, 2000);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
  writeFileSync(path.join(outDir, `browser-${phase}.json`), JSON.stringify(result, null, 2));
}
