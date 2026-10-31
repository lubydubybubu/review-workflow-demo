# Review Workflow — demo package (release candidate)

A small internal-tool case study: product-review requests arrive as **candidates**, a person approves them, and
only then does the review appear on the review page, calendar and dashboard. Inputs are synthetic; the
"extraction" JSON is hand-authored replay data, **not** model output.

This package has two separate things. Don't mix them up:

| | What it is | How to use it |
|---|---|---|
| **Static simulator** [`web-demo/`](web-demo/index.html) | Browser-only page with built-in synthetic data. Approve/reject/reset happen in tab memory only; nothing you do is sent to a server. **Not** the real app, **not** connected to any backend. | Open `web-demo/index.html` through any static file server, or the intended GitHub Pages address once it is published (publish candidate, not live yet): `https://lubydubybubu.github.io/review-workflow-demo/` |
| **Source + local backend** (`app/`, `producer/`, `offline-eval/`, `demo/`) | The actual Next.js + PostgreSQL app and its tools. The screenshots in [docs/STORYBOARD.ko.md](docs/STORYBOARD.ko.md) come from this app running locally, not from the simulator. | Download the source and run it yourself on your own machine: [README.ko.md](README.ko.md) |

- Korean overview and run instructions: [README.ko.md](README.ko.md)
- Case study (Korean): [CASE-STUDY.ko.md](CASE-STUDY.ko.md)
- Evidence summary: [docs/EVIDENCE.ko.md](docs/EVIDENCE.ko.md) · publishing steps: [docs/PUBLISHING.ko.md](docs/PUBLISHING.ko.md)
- Security and threat model: [SECURITY.md](SECURITY.md) · licensing scope: [NOTICE.md](NOTICE.md)
- Intended source repository (publish candidate): `https://github.com/lubydubybubu/review-workflow-demo`

Scope: validated only locally on Linux (loopback PostgreSQL, headless Chrome with its sandbox on). No real mail,
no LLM quality evaluation, RBAC is a design document only, no finance features, external cloud not verified. The
original app is for local evaluation only; it is not deployed anywhere. Dependencies are not shipped; see the
pinned `app/package-lock.json`. Provided as is, without any warranty.

Roles: the owner set the requirements, design, safety boundaries, orchestration and acceptance criteria; code was
implemented with AI coding assistance and checked by independent review runs.

Quick checks (no dependencies to install):

```
python3 -B -m unittest discover -s tests -t .
node --test tests/web-demo/state.test.mjs tests/web-demo/static.test.mjs
```
