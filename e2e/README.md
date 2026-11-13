# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- Unknown sessions and paths outside the fixture project are rejected.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.

## Pi Web 多用户版 multi-user E2E

`npm run test:e2e:multiuser` covers the fork's multi-user surface end to end.
It is a separate script (`e2e/multiuser.mjs`, modeled on `terminal.mjs`) because
multi-user mode is an environment switch (`PI_WEB_MULTI_USER=1`) the single-user
suite deliberately never sets. It boots its own dev/`start` server on a random
loopback port against a temporary `PI_WEB_DATA_DIR`, seeds accounts
(`createUser` via jiti) and one session per user, and cleans everything up.

Coverage, of the two-credential login model (shared `PI_WEB_PASSWORD` cookie +
per-user HTTP Basic) and the fork's additions:

- 401 + `WWW-Authenticate` challenge for anonymous API calls; `requireAuth`
  resolves the Basic identity per user.
- Cross-user isolation: session listing, detail and export by a known id, plus
  runtime secrets, personal `APPEND_SYSTEM.md`, and scheduled tasks.
- Admin-only `/api/admin/users` and `/api/admin/allowed-roots`; users cannot
  reach them (403); an admin cannot demote or disable their own account (409).
- Write-only secrets: the API and UI return names/booleans, never values.
- `/api/logout` sentinel semantics (bare request 401s, `logout:logout` 200s).
- Browser: shared-password gate, per-user sidebar, Settings › General ›
  账号与密钥 (add a secret), Settings › 定时任务, the non-admin `/admin`
  permission message, and the admin console's user / skills / audit panels.

Run it the same way as the main suite; `E2E_SERVER_MODE=start` runs it against a
production build. Failures save screenshots, traces, and the server log under
`test-results/e2e-multiuser/`.
