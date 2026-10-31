# Notice — licensing scope

- **Owner-authored code and documents** in this package (the `app/` sources and tests, `producer/`,
  `offline-eval/`, `demo/`, `tests/`, `tools/`, the static simulator `web-demo/`, `.github/workflows/ci.yml`, the
  Markdown files and the screenshots in `docs/screenshots/`) are derived from the owner's own internal project,
  with internal names replaced by the generic name "Review Workflow". **No open-source license is granted by this
  package yet**; all rights are reserved by the owner until a license is chosen explicitly. Publishing the source
  or the static simulator for viewing does not grant a license. This notice does not claim ownership of anything
  listed below.
- **Other repositories are separate.** A license on any other repository of the owner (for example an MIT-licensed
  project) does not apply to this package.
- **Third-party dependencies are not included.** `app/package.json` and `app/package-lock.json` only name and
  pin npm packages (Next.js, React, FullCalendar, pg, zod, Tailwind CSS, Vitest, Playwright Core, …); each is
  governed by its own license and must be installed from its registry by whoever runs the app. The optional
  browser check (`tools/web_demo_browser_check.mjs`) only reads an already installed Playwright Core given by path.
  The CI workflow uses the official `actions/checkout` action under its own license.
- **No fonts or other vendor binaries are redistributed.** The app and the static simulator fall back to system
  fonts. A deployment may place a self-hosted Pretendard (SIL OFL 1.1) stylesheet at
  `app/public/fonts/pretendard.css`; the demo runner can copy such locally obtained files into its disposable
  runtime copy (`--font-dir`), never into this package.
- Chrome, PostgreSQL and Node.js are prerequisites supplied by the machine running the demo; none is bundled.
- All people, companies, products, addresses and mails in fixtures, screenshots and the simulator are synthetic.
- Provided as is, without warranty of any kind.
