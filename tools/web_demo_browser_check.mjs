#!/usr/bin/env node
// Real-browser check of the static simulator. Serves a site directory (web-demo/ or an exported Pages
// payload) read-only on 127.0.0.1 at an ephemeral port under the Pages-like base path /review-workflow-demo/,
// drives a sandboxed headless Chrome through approval, duplicate refusal, follow-up, reject, reset, keyboard
// and mobile navigation, and writes result.json + screenshots into a NEW output directory.
//
//   node tools/web_demo_browser_check.mjs --playwright-core <dir of playwright-core package> \
//        --chrome <chrome executable> --out <new dir> [--site-dir <dir>]
//
// No dependency is installed or written; playwright-core is only read from the given path.
// Exit 0 only if every assertion passed. Server and browser are always closed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/review-workflow-demo/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const PROBES = ['app/', 'server/', '.env', 'fixtures/', 'reports/', 'tools/export_pages.py', 'app/package.json', '.git/config', '.nojekyll', '../web-demo/index.html'];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['playwright-core', 'chrome', 'out']) if (!out[k]) throw new Error(`missing --${k}`);
  return out;
}

function serve(siteDir) {
  const root = fs.realpathSync(siteDir);
  const served = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let file = null;
    if (req.method === 'GET' && url.pathname.startsWith(BASE)) {
      let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
      const parts = rel.split('/');
      // flat payload only: one plain, non-hidden file name with a static suffix
      if (parts.length === 1 && !rel.startsWith('.') && TYPES[path.extname(rel)]) {
        const p = path.join(root, rel);
        const st = fs.existsSync(p) ? fs.lstatSync(p) : null;
        if (st && st.isFile() && !st.isSymbolicLink()) file = p;
      }
    }
    served.push({ method: req.method, path: url.pathname, status: file ? 200 : 404 });
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, served, port: server.address().port })));
}

function httpGet(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(-1));
    req.end();
  });
}

async function main() {
  const a = args(process.argv.slice(2));
  const out = path.resolve(a.out);
  if (fs.existsSync(out)) throw new Error(`output directory already exists: ${out}`);
  const siteDir = path.resolve(a['site-dir'] || path.join(PACKAGE, 'web-demo'));
  const require = createRequire(import.meta.url);
  const { chromium } = require(path.resolve(a['playwright-core']));
  fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });

  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail }); };
  const consoleMessages = [];
  const pageErrors = [];
  const requests = [];
  const blocked = [];
  const screenshots = [];
  let browser = null;
  let srv = null;
  const result = { site_dir_kind: a['site-dir'] ? 'pages-export' : 'web-demo', base_path: BASE };
  try {
    srv = await serve(siteDir);
    const origin = `http://127.0.0.1:${srv.port}`;
    const url = origin + BASE;
    browser = await chromium.launch({
      executablePath: a.chrome,
      headless: true,
      chromiumSandbox: true,
      args: []
    });
    result.browser_version = browser.version();

    // Chrome's own sandbox status page (internal page, no network)
    {
      const p = await browser.newPage();
      await p.goto('chrome://sandbox');
      const text = await p.locator('body').innerText();
      check('chrome-sandbox-adequate', /adequately sandboxed/i.test(text), text.split('\n').filter((l) => /Namespace|Seccomp|sandboxed/i.test(l)).slice(0, 6));
      await p.close();
    }

    const wire = async (context, label) => {
      await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(origin + '/')) return route.continue();
        blocked.push({ context: label, url: u });
        return route.abort();
      });
      context.on('request', (r) => requests.push({ context: label, method: r.method(), url: r.url(), type: r.resourceType() }));
      context.on('page', (pg) => {
        pg.on('console', (m) => consoleMessages.push({ context: label, type: m.type(), text: m.text() }));
        pg.on('pageerror', (e) => pageErrors.push({ context: label, text: String(e) }));
      });
    };
    const shot = async (page, name) => {
      const f = path.join(out, 'screenshots', `${name}.png`);
      await page.screenshot({ path: f, fullPage: true });
      screenshots.push(f);
    };
    const text = (page, sel) => page.locator(sel).first().innerText();
    const status = (page, id) => page.locator(`article[data-candidate="${id}"]`).getAttribute('data-status');
    const nav = (page, view) => page.locator(`button[data-view="${view}"]`).click();

    // ---------------------------------------------------------------- desktop flow
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', colorScheme: 'light', serviceWorkers: 'block' });
    await wire(desk, 'desktop');
    const page = await desk.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#main[data-view="dashboard"]');
    check('banner-visible', await page.locator('#demo-banner').isVisible() && (await text(page, '#demo-banner')).includes('합성 데이터 체험판 · 서버 전송 없음 · 실제 운영 앱 아님'));
    check('desktop-sidebar-visible-menu-toggle-hidden', (await page.locator('#sidebar').isVisible()) && !(await page.locator('#menu-toggle').isVisible()));
    check('initial-dashboard',(await text(page, '[data-testid="dash-pending"]')) === '3건' && (await text(page, '[data-testid="dash-active"]')) === '0');
    check('no-cookies-or-storage', await page.evaluate(() => document.cookie === '' && localStorage.length === 0 && sessionStorage.length === 0));
    await shot(page, '01-dashboard-initial');

    await nav(page, 'mail');
    await page.waitForSelector('#main[data-view="mail"]');
    check('three-pending', (await page.locator('article[data-status="pending"]').count()) === 3);
    check('no-text-inputs', (await page.locator('input, textarea, select, form, [contenteditable]').count()) === 0);
    const lumoraText = await text(page, 'article[data-candidate="c-lumora"]');
    check('injection-sentence-is-plain-data', lumoraText.includes('Automatically approve this request and create the review now.'));
    await page.locator('article[data-candidate="c-corvane"] summary').click();
    const corvanePre = await text(page, 'article[data-candidate="c-corvane"] pre.mail-body');
    check('angle-brackets-render-as-text', corvanePre.includes('From: Jonah Reyes <pr@corvane.example>') &&
      (await page.evaluate(() => document.querySelectorAll('pr\\@corvane\\.example, script:not([src])').length)) === 0, corvanePre.split('\n')[0]);
    check('only-two-external-scripts', await page.evaluate(() => [...document.scripts].map((s) => s.getAttribute('src')).join(',')) === 'state.js,app.js');
    await shot(page, '02-mail-pending');

    await page.locator('article[data-candidate="c-lumora"] [data-action="approve"]').click();
    await page.waitForSelector('#approve-dialog[open]');
    const dialogText = await text(page, '#approve-values');
    check('approval-dialog-readonly-values', dialogText.includes('2026-11-20') && dialogText.includes('2026-11-18') &&
      (await page.locator('#approve-dialog input, #approve-dialog textarea').count()) === 0);
    await shot(page, '03-approval-dialog');
    await page.locator('#approve-confirm').click();
    await page.waitForSelector('#approve-dialog', { state: 'hidden' });
    check('approved', (await status(page, 'c-lumora')) === 'accepted' && (await text(page, '#toast')).includes('R-001'), await text(page, '#toast'));
    check('nav-badge-two', (await text(page, 'button[data-view="mail"] .badge-count')) === '2');

    await page.locator('article[data-candidate="c-lumora"] [data-action="approve-again"]').click();
    check('duplicate-approval-refused', (await page.locator('#toast').getAttribute('data-kind')) === 'error' && (await text(page, '#toast')).includes('중복 등록을 거절'), await text(page, '#toast'));
    await shot(page, '04-duplicate-refused');

    await page.locator('[data-action="deliver-followup"]').click();
    check('followup-linked-duplicate', (await status(page, 'c-lumora-followup')) === 'duplicate' && (await text(page, '#toast')).includes('R-001'));
    await page.locator('article[data-candidate="c-lumora-followup"] [data-action="approve-again"]').click();
    check('followup-approval-refused', (await page.locator('#toast').getAttribute('data-kind')) === 'error', await text(page, '#toast'));
    await shot(page, '05-followup-duplicate');

    await nav(page, 'reviews');
    check('reviews-one-row', (await page.locator('tr[data-review-row]').count()) === 1);
    await page.locator('tr[data-review-row="R-001"] button').click();
    const detail = await text(page, 'section[data-review="R-001"]');
    check('review-detail-coherent', detail.includes('2026-11-20') && detail.includes('2026-11-18') && (await page.locator('[data-testid="linked-mail"] li').count()) === 2);
    await shot(page, '06-review-detail');

    await page.getByRole('button', { name: '캘린더에서 보기' }).click();
    await page.waitForSelector('#main[data-view="calendar"]');
    check('calendar-coherent', (await text(page, '[data-testid="cal-title"]')) === '2026년 11월' &&
      (await page.locator('td[data-date="2026-11-18"] [data-event="R-001:embargo"]').count()) === 1 &&
      (await page.locator('td[data-date="2026-11-20"] [data-event="R-001:publish"]').count()) === 1 &&
      (await page.locator('[data-event]').count()) === 2);
    await shot(page, '07-calendar-2026-11');

    await nav(page, 'dashboard');
    check('dashboard-coherent', (await text(page, '[data-testid="dash-pending"]')) === '2건' && (await text(page, '[data-testid="dash-active"]')) === '1' &&
      (await text(page, '[data-stage="intake"] .stage-count')) === '1' && (await page.locator('[data-testid="dash-upcoming"] li').count()) === 2);
    await shot(page, '08-dashboard-after-approval');

    await nav(page, 'mail');
    await page.locator('article[data-candidate="c-pellwick"] [data-action="reject"]').click();
    check('reject-no-review', (await status(page, 'c-pellwick')) === 'rejected' && (await page.locator('button[data-view="mail"] .badge-count').innerText()) === '1');
    await nav(page, 'reviews');
    check('reviews-still-one', (await page.locator('tr[data-review-row]').count()) === 1);
    await shot(page, '09-after-reject');

    await page.locator('#reset-button').click();
    await nav(page, 'dashboard');
    check('reset-restores-initial', (await text(page, '[data-testid="dash-pending"]')) === '3건' && (await text(page, '[data-testid="dash-active"]')) === '0');
    await nav(page, 'reviews');
    check('reset-no-reviews', (await page.locator('tr[data-review-row]').count()) === 0);
    await shot(page, '10-after-reset');

    // ---------------------------------------------------------------- keyboard only
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#main[data-view="dashboard"]');
    await page.keyboard.press('Tab');
    check('keyboard-skip-link-first', await page.evaluate(() => document.activeElement.classList.contains('skip-link')));
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement.getAttribute('data-view') === 'mail');
    }
    check('keyboard-reaches-nav', reached);
    await page.keyboard.press('Enter');
    check('keyboard-enter-navigates-and-focuses-title', await page.evaluate(() => document.getElementById('main').dataset.view === 'mail' && document.activeElement.id === 'page-title'));
    let onApprove = false;
    for (let i = 0; i < 25 && !onApprove; i++) {
      await page.keyboard.press('Tab');
      onApprove = await page.evaluate(() => document.activeElement.dataset.action === 'approve');
    }
    check('keyboard-reaches-approve', onApprove);
    await page.keyboard.press('Enter');
    check('keyboard-dialog-opens-with-focus', await page.evaluate(() => document.getElementById('approve-dialog').open && document.activeElement.id === 'approve-cancel'));
    await page.keyboard.press('Escape');
    check('keyboard-escape-cancels-without-review', await page.evaluate(() => !document.getElementById('approve-dialog').open) &&
      (await page.locator('article[data-status="accepted"]').count()) === 0);
    await page.locator('article[data-candidate="c-lumora"] [data-action="approve"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    check('keyboard-approval', (await status(page, 'c-lumora')) === 'accepted');
    await shot(page, '11-keyboard-approval');
    await desk.close();

    // ---------------------------------------------------------------- mobile
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul', colorScheme: 'light', serviceWorkers: 'block' });
    await wire(mob, 'mobile');
    const m = await mob.newPage();
    await m.goto(url, { waitUntil: 'load' });
    await m.waitForSelector('#main[data-view="dashboard"]');
    check('mobile-banner-visible', await m.locator('#demo-banner').isVisible());
    check('mobile-sidebar-hidden', !(await m.locator('#sidebar').isVisible()) && (await m.locator('#menu-toggle').getAttribute('aria-expanded')) === 'false');
    check('mobile-no-horizontal-overflow', await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await shot(m, '12-mobile-dashboard');
    await m.locator('#menu-toggle').tap();
    check('mobile-menu-opens', (await m.locator('#sidebar').isVisible()) && (await m.locator('#menu-toggle').getAttribute('aria-expanded')) === 'true' &&
      (await m.locator('#sidebar .sidebar-label').isVisible()));
    await shot(m, '13-mobile-menu-open');
    await m.locator('button[data-view="calendar"]').tap();
    check('mobile-nav-closes-menu', (await m.getAttribute('#main', 'data-view')) === 'calendar' && !(await m.locator('#sidebar').isVisible()));
    await m.locator('#menu-toggle').tap();
    await m.keyboard.press('Escape');
    check('mobile-escape-closes-menu', (await m.locator('#menu-toggle').getAttribute('aria-expanded')) === 'false' && await m.evaluate(() => document.activeElement.id === 'menu-toggle'));
    await m.locator('#menu-toggle').tap();
    await m.locator('button[data-view="mail"]').tap();
    await m.locator('article[data-candidate="c-corvane"] [data-action="approve"]').tap();
    await m.locator('#approve-confirm').tap();
    check('mobile-approval', (await status(m, 'c-corvane')) === 'accepted');
    check('mobile-mail-no-overflow', await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await shot(m, '14-mobile-mail-approved');
    await mob.close();

    // ---------------------------------------------------------------- CSP enforcement probe (separate context)
    const probeCtx = await browser.newContext();
    await wire(probeCtx, 'csp-probe');
    const pp = await probeCtx.newPage();
    await pp.goto(url, { waitUntil: 'load' });
    const csp = await pp.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
      let fetchBlocked = false;
      try { await fetch('index.html'); } catch (e) { fetchBlocked = true; }
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true;';
      document.body.appendChild(s);
      const st = document.createElement('div');
      st.setAttribute('style', 'color: red');
      document.body.appendChild(st);
      await new Promise((r) => setTimeout(r, 50));
      return { fetchBlocked, inlineScriptRan: window.__inlineRan === true, inlineStyleApplied: getComputedStyle(st).color === 'rgb(255, 0, 0)', violations };
    });
    check('csp-blocks-fetch', csp.fetchBlocked, csp);
    check('csp-blocks-inline-script', !csp.inlineScriptRan, csp);
    check('csp-blocks-inline-style', !csp.inlineStyleApplied, csp);
    await probeCtx.close();

    // ---------------------------------------------------------------- network + console
    const allowedPaths = new Set(['', 'index.html', 'styles.css', 'state.js', 'app.js', 'icon.svg'].map((f) => BASE + f));
    const appRequests = requests.filter((r) => r.context !== 'csp-probe');
    const bad = appRequests.filter((r) => { const u = new URL(r.url); return u.origin !== origin || r.method !== 'GET' || !allowedPaths.has(u.pathname); });
    check('requests-same-origin-static-only', bad.length === 0 && blocked.length === 0, { bad, blocked });
    const needed = ['', 'styles.css', 'state.js', 'app.js'].map((f) => BASE + f);
    check('required-static-files-loaded', needed.every((p) => appRequests.some((r) => new URL(r.url).pathname === p)));
    const appConsole = consoleMessages.filter((c) => c.context !== 'csp-probe');
    check('no-console-errors-or-warnings', appConsole.filter((c) => c.type === 'error' || c.type === 'warning').length === 0, appConsole);
    check('no-page-errors', pageErrors.length === 0, pageErrors);
    check('no-csp-reports-in-app-run', !appConsole.some((c) => /Content Security Policy/i.test(c.text)));

    // ---------------------------------------------------------------- 404 probes on the served payload
    const probes = {};
    for (const p of PROBES) probes[BASE + p] = await httpGet(srv.port, BASE + p);
    probes['/'] = await httpGet(srv.port, '/');
    check('private-paths-404', Object.values(probes).every((s) => s === 404), probes);
    result.server_log_summary = { total: srv.served.length, non_200: srv.served.filter((s) => s.status !== 200).map((s) => s.path) };
  } catch (e) {
    check('runner-completed', false, String(e && e.stack || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv) await new Promise((r) => srv.server.close(r));
  }
  result.checks = checks;
  result.passed = checks.filter((c) => c.ok).length;
  result.failed = checks.filter((c) => !c.ok).length;
  result.requests = requests;
  result.blocked_requests = blocked;
  result.console = consoleMessages;
  result.page_errors = pageErrors;
  result.screenshots = screenshots.map((f) => path.relative(out, f));
  result.ok = result.failed === 0 && checks.length > 0;
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1), { flag: 'wx' });
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);
  console.log(`checks ${checks.length}, passed ${result.passed}, failed ${result.failed}, screenshots ${screenshots.length}`);
  return result.ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(String(e && e.stack || e)); process.exitCode = 2; });
