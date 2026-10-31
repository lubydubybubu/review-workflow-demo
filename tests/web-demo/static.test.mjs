// Static security checks for the browser-only simulator (web-demo/). Node built-ins only:
//   node --test tests/web-demo/state.test.mjs tests/web-demo/static.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web-demo');
const read = (f) => readFileSync(path.join(WEB, f), 'utf8');
const EXPECTED_FILES = ['app.js', 'icon.svg', 'index.html', 'state.js', 'styles.css'];
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'; object-src 'none'";
const BANNER = '합성 데이터 체험판 · 서버 전송 없음 · 실제 운영 앱 아님';
const ALLOWED_URLS = new Set([
  'https://github.com/lubydubybubu/review-workflow-demo',
  'http://www.w3.org/2000/svg' // SVG XML namespace identifier, never fetched
]);

// Strip comments so prose in comments cannot hide or fake a match.
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

test('web-demo contains exactly the reviewed static files (no subdirs, no build output)', () => {
  const entries = readdirSync(WEB, { withFileTypes: true });
  assert.deepEqual(entries.map((e) => e.name).sort(), EXPECTED_FILES);
  assert.ok(entries.every((e) => e.isFile()));
  const pages = readFileSync(path.join(ROOT, 'tools', 'PAGES_FILES.txt'), 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(pages.sort(), EXPECTED_FILES.map((f) => `web-demo/${f}`));
});

test('index.html: exact CSP meta, no inline script/style/handlers, same-origin relative assets only', () => {
  const html = read('index.html');
  const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  assert.equal(metas.length, 1);
  assert.equal(metas[0][1], CSP);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'CSP precedes scripts');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((m) => m[1].trim()), ['src="state.js" defer', 'src="app.js" defer']);
  assert.ok(scripts.every((m) => m[2] === ''), 'no inline script bodies');
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<(form|input|textarea|select|iframe|object|embed|base)\b/i);
  assert.doesNotMatch(html, /contenteditable/i);
  for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
    assert.match(m[1], /^(#main|[a-z]+\.(js|css|svg))$/, `relative same-origin reference: ${m[1]}`);
  }
  assert.ok(html.includes(BANNER), 'prominent synthetic/no-send banner');
});

test('JavaScript: no HTML sinks, eval, network, workers, storage or cookies', () => {
  const forbidden = [
    /\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write/, /\beval\s*\(/, /\bnew\s+Function\b/,
    /\bFunction\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bWorker\b/,
    /serviceWorker/, /SharedWorker/, /localStorage/, /sessionStorage/, /indexedDB/, /\bcookie\b/, /caches\./,
    /\bimport\s*\(/, /createContextualFragment/, /DOMParser/, /srcdoc/, /\.src\s*=/, /window\.open/, /postMessage/,
    /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /\.style\b/, /createElement\(\s*['"](script|style|iframe|form|input|textarea|select|link|img|object|embed)['"]/,
    /location\s*(\.href)?\s*=/, /Math\.random/, /Date\.now/, /new Date\(\s*\)/
  ];
  for (const f of ['state.js', 'app.js']) {
    const src = stripJs(read(f));
    for (const re of forbidden) assert.doesNotMatch(src, re, `${f}: ${re}`);
  }
});

test('external links are deliberate navigation only (allowlisted, new tab, noopener noreferrer)', () => {
  const app = read('app.js');
  const urls = new Set([...app.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]));
  assert.deepEqual([...urls], ['https://github.com/lubydubybubu/review-workflow-demo']);
  assert.match(app, /rel: 'noopener noreferrer'/);
  assert.match(app, /target: '_blank'/);
  for (const f of EXPECTED_FILES) {
    for (const m of read(f).matchAll(/https?:\/\/[^\s'"`)<>]+/g)) assert.ok(ALLOWED_URLS.has(m[0]), `${f}: ${m[0]}`);
  }
});

test('CSS: no imports, remote fonts or url() loads', () => {
  const css = read('styles.css');
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /@font-face/);
  assert.doesNotMatch(css, /url\s*\(/);
});

test('no production hosts or operational details: only .example mail domains, no IPs or ports', () => {
  for (const f of EXPECTED_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) assert.match(m[1], /\.example$/, `${f}: ${m[0]}`);
    assert.doesNotMatch(src, /\b\d{1,3}(\.\d{1,3}){3}\b/, `${f}: IP address`);
    assert.doesNotMatch(src, /localhost|127\.0\.0\.1|:\d{4,5}\b/, `${f}: host/port`);
    assert.doesNotMatch(src, /token|password|secret|api[_-]?key/i, `${f}: credential vocabulary`);
  }
});

test('rendering helper refuses event-handler and style attributes; text goes through textContent', () => {
  const app = stripJs(read('app.js'));
  assert.match(app, /if \(\/\^on\/i\.test\(name\) \|\| name\.toLowerCase\(\) === 'style'\) throw/);
  assert.match(app, /el\.textContent = String\(props\.text\)/);
  assert.match(app, /document\.createTextNode\(c\)/);
});

test('fixture confidence is labelled as an annotation, not AI accuracy', () => {
  assert.match(read('app.js'), /fixture 표기값 .*AI 정확도 아님/);
  assert.match(read('state.js'), /not a model score/);
});
