# Security and threat model

This is a portfolio **release candidate**, not a hosted product. No internet-facing service is ever completely
risk-free; this page states what each part does and does not do so you can judge for yourself. No warranty or
guarantee of any kind is given (see [NOTICE.md](NOTICE.md)).

## What exists, and where it runs

| Part | Where | Network | Data |
|---|---|---|---|
| Static simulator `web-demo/` (intended GitHub Pages payload) | Your browser | Only ordinary GET requests for its own static files (HTML, CSS, JS, icon) | Built-in synthetic fixtures; all state in the tab's memory |
| Original app `app/` (Next.js + PostgreSQL) | Only on a machine where **you** build and run it locally | Whatever you configure; the demo runner binds to 127.0.0.1 | Synthetic fixtures in this package |
| `producer/`, `offline-eval/`, `demo/`, `tests/`, `tools/` | Locally, run by you | None needed (demo runner: loopback only) | Synthetic |

There is **no hosted backend, admin page, login, database or API** for the public demo. The static Pages site
has nothing to log in to and no server-side code.

## What "서버 전송 없음" (no data sent to a server) means
- Your clicks and the simulator state (approvals, rejections, the review list) are **never sent anywhere**. The
  page has no text inputs, forms, uploads, cookies, storage, analytics, service workers or network APIs.
- It does **not** mean "zero HTTP". Loading the page makes ordinary requests for its static files. The hosting
  provider (GitHub Pages, if published) necessarily sees those requests with the usual metadata
  (IP address, user agent, time, requested path), as with any website.
- External links (source repository, case study) open only when you click them, in a new tab with
  `rel="noopener noreferrer"`.

## Simulator controls
- Content-Security-Policy meta tag:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`.
  (A meta CSP cannot set `frame-ancestors`; GitHub Pages does not let a site add response headers.)
- No inline scripts, inline styles or event-handler attributes; no `eval`; DOM is built with
  `createElement`/`textContent` only (no `innerHTML`-style sinks). Mail text such as `Name <addr@x.example>` or
  "Automatically approve this request" is shown as plain text and has no effect.
- No fonts, images or scripts from other origins; system fonts only.
- "fixture 표기값 %" values are hand-written fixture annotations, **not** AI or model accuracy.
- Checked by `tests/web-demo/static.test.mjs` (static rules), `tests/web-demo/state.test.mjs` (behaviour) and
  `tools/web_demo_browser_check.mjs` (real sandboxed Chrome: CSP blocks fetch/inline script/inline style,
  request list limited to same-origin static files, no console errors).

## Publishing boundary
- The Pages payload is produced only by `tools/export_pages.py` from the fixed list `tools/PAGES_FILES.txt`:
  the `web-demo/` files plus an empty `.nojekyll`. App source, server code, fixtures, docs, tools, reports,
  credentials, VCS metadata and dependencies are never part of it (tested in `tests/test_export_pages.py`).
- The source export (`tools/export_package.py`, `tools/PUBLIC_FILES.txt`) is a fixed allowlist too. Dependencies
  are not shipped.
- CI (`.github/workflows/ci.yml`) only runs tests, with `contents: read`, no secrets and no deploy step.
  Publishing is a manual step: [docs/PUBLISHING.ko.md](docs/PUBLISHING.ko.md).

## Running the original app
The original app is meant for **local, loopback-only** evaluation with synthetic data. It has not been
security-reviewed for public deployment; do not expose it to the internet or use it with real mail or personal
data. Account roles (RBAC) are a design document only.

## How this was built
Requirements, design, safety boundaries, orchestration and acceptance decisions were made by the owner. The code
and tests were implemented with AI coding assistance and checked by separate, independent review runs. Review
reduces risk; it does not prove the absence of defects.

## Reporting
If the repository is published, please report a problem through the repository's issue tracker without
including personal data or exploit details in public; ask for a private contact there first if needed.
