# Coding Workshop - Frontend Code

## Overview

This folder contains the React frontend for the ACME facility incident
management platform. It talks to the `facility-api` Lambda described in
`backend/facility-api/README.md`.

## Prerequisites

- React - JavaScript library for building user interfaces
- React Router - Client-side routing for React
- Material UI - Comprehensive UI component library
- Redux Toolkit + React Redux - Application state management
- React Responsive - Media queries in JavaScript, driving the layout switches

## Structure

```
coding-workshop-participant/
├── frontend/                  # React frontend
│   ├── src/
│   │   ├── main.jsx             # Store, theme and router providers
│   │   ├── App.jsx              # Route table with role guards
│   │   ├── theme.js             # MUI theme + status/priority vocabulary
│   │   ├── services/
│   │   │   └── api.js             # fetch wrapper, error envelope, query builder
│   │   ├── store/               # Redux Toolkit slices (one per domain)
│   │   │   ├── index.js           # configureStore
│   │   │   ├── authSlice.js       # tokens, profile, persisted session
│   │   │   ├── session.js         # refreshSession thunk (split to break a cycle)
│   │   │   ├── thunkUtils.js      # withAuth: retry once behind a renewed token
│   │   │   ├── incidentsSlice.js  # list, filters, detail, notes
│   │   │   ├── facilitiesSlice.js # buildings -> floors -> seats
│   │   │   ├── engineersSlice.js  # roster, workload, accounts
│   │   │   ├── dashboardSlice.js  # summary, hotspots, SLA, workflow
│   │   │   └── uiSlice.js         # toasts and the mobile drawer
│   │   ├── components/
│   │   │   ├── AppLayout.jsx      # responsive shell (sidebar / drawer)
│   │   │   ├── SimilarIncidents.jsx # "is this already reported?" panel
│   │   │   ├── ProtectedRoute.jsx # auth + role guard
│   │   │   ├── IncidentFilters.jsx
│   │   │   ├── IncidentList.jsx   # table on desktop, cards on phones
│   │   │   ├── StatusChip.jsx     # status / priority / escalation chips
│   │   │   ├── WorkflowDiagram.jsx
│   │   │   └── Notifier.jsx       # global toast host
│   │   └── pages/
│   │       ├── LoginPage.jsx      # sign in + register
│   │       ├── DashboardPage.jsx
│   │       ├── IncidentsPage.jsx
│   │       ├── IncidentDetailPage.jsx
│   │       ├── FacilitiesPage.jsx
│   │       ├── EngineersPage.jsx
│   │       └── UsersPage.jsx      # facility admin only
│   ├── .env.sample            # React environment variables
│   ├── eslint.config.js       # ESLint JS tool configuration
│   ├── index.html             # Landing page
│   ├── package.json           # App metadata with dependencies
│   ├── README.md              # Frontend guide (YOU ARE HERE)
│   └── vite.config.js         # Vite build tool configuration
├── ...
```

## State management

State is held in Redux Toolkit slices, one per domain, each owning its own
`createAsyncThunk` calls so the data and the requests that fetch it stay
together. Three decisions worth knowing:

* **Incident filters live in the store, not in component state.** The list page,
  the dashboard's drill-down tiles and the back-navigation from a detail view
  all need to agree on what is being shown.
* **Writes return the full incident**, so `updateIncident`, `assignIncident`,
  `changeStatus` and `escalateIncident` share one reducer that refreshes both
  the detail view and the matching row in the list without a re-fetch.
* **Toasts are global.** Any thunk reports success or failure through
  `notify()`, so no page has to own a snackbar.

## Telling the reporter it is already reported

The report dialog asks the API whether the draft describes a problem someone
has already filed, and shows what it finds above the buttons. The same panel
appears on the detail page, listing incidents that look like the same fault.

Three decisions shape it:

* **It never blocks.** The reporter can always submit. A duplicate prompt
  standing between somebody and reporting a real problem is worse than the
  duplicates it prevents, so the panel is advice and the Report button stays
  enabled.
* **It explains itself.** Every match lists why it matched - "wording is very
  similar, same category, same floor". A bare relevance score tells a reporter
  nothing about whether to abandon what they are typing.
* **It only links where a link works.** An employee sees that a colleague
  already reported the fault but may not read that incident, so a match arrives
  with `visible: false` and is rendered as plain text with a line saying why.
  Linking anyway would hand them a 404.

The lookup is debounced by 400ms and skipped until the title is at least eight
characters, because a two-word title matches half the table and the suggestions
flicker while the reporter is still typing the first word. Results are guarded
by request id in the reducer: two lookups can be in flight, and the slow answer
for an abandoned draft must not overwrite the fast answer for the current one.
A failed lookup changes nothing on screen - it is a convenience, and the
reporter should never find out it broke.

## Staying signed in

Access tokens last 30 minutes, so a session that only refreshed on page load
would drop a user mid-sentence. Instead every authenticated thunk goes through
`withAuth`, which runs the request, and on a `token_expired` rejection renews
the session and runs it exactly once more. Anything else is rejected untouched —
a retry would not help a 403, and retrying a write could double-apply it.

Renewal is **single-flight**. A dashboard mounting five thunks at once would
otherwise fire five refreshes; because rotation invalidates the previous token,
the second one through would replay a spent token and trip the server's reuse
detection, logging the user out for doing nothing wrong. A module-level promise
means concurrent callers await the one renewal in progress and then all retry
with the token it produced.

`refreshSession` lives in `store/session.js` rather than in `authSlice.js`
because `thunkUtils` is imported *by* the slices; putting the thunk in the slice
would make the import cycle back on itself.

On startup `loadSession` restores the tokens from `localStorage` and validates
the access token against `/auth/me`. If that fails the access token is dropped
but **the refresh token is kept** — an expired access token is the normal state
after leaving the tab open, and it is exactly the case the refresh token exists
to handle. Only a failed refresh clears both and returns the user to login.
Signing out calls `/auth/logout` so the token is revoked server-side, not merely
forgotten by the browser.

## API base URL

One rule works in both environments, so `services/api.js` has no branching:

```
`${VITE_API_URL}/api/facility-api`
```

On AWS `VITE_API_URL` is the CloudFront domain and the `/api/facility-api`
cache behaviour forwards to the Lambda with the prefix intact; locally it is the
dev proxy on port 3001, which strips the same prefix. Both are written into
`.env.local` by `./bin/generate-env.sh`.

## Progressive web app

The app is installable and opens without a network. `vite-plugin-pwa` generates
the manifest and a Workbox service worker from the build output; icons live in
`public/` at 192px, 512px and a maskable 512px so a platform that crops to a
circle does not clip the mark.

**The API is deliberately never cached.** Incident data is live and per-user: a
cached response would show one person another's view, or stale state presented
as current. `runtimeCaching` is empty, so API requests reach the network or
fail honestly, and the existing error handling reports that.

Two details that matter more than they look:

* `navigateFallbackDenylist: [/^\/api\//]`. Without it a failed API call would
  be answered with the HTML shell, and the client would try to parse markup as
  JSON — a confusing failure a long way from its cause.
* `devOptions.enabled: false`. A service worker caching a dev bundle is a
  reliable way to spend an afternoon debugging a stale page.

Offline, the shell loads from the precache and `OfflineBanner` says plainly
that nothing will update until the connection returns, rather than letting
every request fail one at a time into a toast.

`e2e/pwa.spec.js` checks the manifest is installable, that the service worker
registers and precaches the shell without any `/api/` entry, and that the app
still opens with the browser set offline.

## Keeping data current

The dashboard, the incident list and the incident detail view refresh
themselves. `src/hooks/usePolling.js` re-fetches on an interval
(`VITE_POLL_INTERVAL_MS`, 20s by default) and `LiveStatus` shows how fresh the
data is with a manual refresh alongside it.

**Why polling and not a socket.** Lambda Function URLs do not support the
WebSocket upgrade, and every managed alternative — API Gateway WebSockets,
AppSync, IoT Core — is outside the permissions this deployment has, so a
persistent connection is not available to it. For incident tracking a short
poll is a fair substitute: no infrastructure, identical behaviour against
LocalStack and AWS, and it degrades to "slightly stale" rather than to a broken
connection.

Two behaviours keep it from being wasteful or disruptive:

* **Nothing is requested while the tab is hidden**, and returning to the tab
  refreshes immediately rather than waiting out the rest of an interval.
* **Polling is suspended while a write is in flight** — and while the report
  dialog is open — so a refresh cannot race a response or move the page under
  someone who is typing.

The callback is held in a ref so that a new function identity on each render
does not restart the timer. Without that, a component re-rendering faster than
the interval would reset the timer before it ever fired and polling would
silently never happen.

## Form validation

Validation happens in three places, deliberately:

* **Before submission** — submit stays disabled until the required fields are
  filled, so an obviously incomplete request is never sent.
* **Beside the field** — the API reports validation failures per field
  (`{"field": "body.name", "message": "..."}`). `ApiError.fieldErrors()` strips
  the `body.` prefix, thunks reject with `{message, fields}`, and each form puts
  the message on the input it refers to and marks it `aria-invalid`. Editing the
  input clears it.
* **In a toast** — for failures that belong to no single field, such as a
  conflict or a permission refusal.

Required fields carry the `required` prop so they are marked visually, and
inputs are disabled while a submission is in flight rather than only the button,
so a form cannot be edited mid-request.

## Continuous deployment

`.github/workflows/frontend.deploy.yml` runs on any push to `main` touching
`frontend/**`. It installs with `npm ci`, then runs lint, `npm audit
--audit-level=high` and a production build; only if all pass does it run
`./bin/deploy-frontend.sh aws` and smoke-test the CloudFront URL.

## Tests

```sh
npm test           # vitest run, single pass - what CI runs
npm run test:watch # watch mode while developing
npm run coverage   # v8 coverage report
```

266 tests across the API client, the Redux slices, the components and every
page (86% statement coverage). They concentrate on behaviour a production build cannot catch:

* `services/api.test.js` — empty filters are dropped from query strings (the
  API rejects `""` for enum parameters), the error envelope is unwrapped, a 204
  returns null, and a network failure becomes a readable message.
* `store/*.test.js` — changing a filter returns to page one; a write refreshes
  both the detail view and the matching list row; a restored token that turns
  out to be expired is discarded rather than leaving a half-signed-in state.
* `components/SimilarIncidents.test.jsx` — the duplicate panel renders nothing
  when there is nothing to say, never links to a match the caller cannot open,
  and treats a ground floor numbered zero as a floor rather than as missing.
* `components/*.test.jsx` — the responsive table/card switch, the role guard
  waiting for the session check before judging a role, the chip vocabulary, the
  shell's per-role navigation and drawer behaviour, and the filter bar's flags
  control, which maps one dropdown onto two mutually exclusive parameters and
  has to clear whichever is not chosen.
* `pages/*.test.jsx` — each page against a real store with only `fetch` stubbed,
  via the fake API in `src/test/utils.jsx`. These assert that the controls a
  page offers match what the API permits, that requests carry the right body,
  and that a refusal from the server is surfaced rather than swallowed.

Rules that protect a deployment — refusing to demote the last admin, refusing
self-deactivation — live in the API on purpose, so the page tests check those
messages are *displayed*, not that the UI re-implements the rule.

The suite is mutation-checked rather than assumed useful. Removing the page
reset in `setFilters`, inverting the responsive breakpoint, leaking the
work-distribution panel to employees, dropping the accessible name from the
activation switches, and widening who sees the assignment panel each made it
fail.

See `backend/facility-api/README.md` for the repository secrets both deploy
workflows need, and for why this is GitHub Actions rather than CodePipeline.

## End-to-end tests

```sh
# Against a running local stack (./bin/start-dev.sh, proxying on 3001)
VITE_API_URL=http://localhost:3001 npm run build
npm run e2e          # or npm run e2e:ui for the interactive runner

# Against any already-running deployment
E2E_BASE_URL=https://your-distribution.cloudfront.net npm run e2e
```

21 Playwright tests over the journeys the workshop calls critical:

* `e2e/auth.spec.js` — anonymous redirect, bad credentials, off-domain
  registration, and a session surviving a reload then ending on sign out.
* `e2e/incident-lifecycle.spec.js` — the whole journey across three personas in
  one test built from `test.step()`s: an employee reports, an admin assigns,
  the engineer progresses, blocks with a reason, unblocks and resolves, and the
  reporter closes. Plus the note thread, internal notes staying invisible to
  employees, and escalation that only an admin can clear.
* `e2e/duplicates.spec.js` — the ranking itself, against real PostgreSQL rather
  than a stub: a reworded, misspelled report is recognised as one already
  filed; a genuinely different fault on the same equipment is not; the panel
  never blocks a submission; and an employee is told a colleague reported it
  without being shown the ticket or offered a link they cannot follow. The
  phrasings are chosen from measured scores (~0.60 for the duplicate, ~0.48 for
  the distinct fault, against a 0.55 threshold) so the margin is deliberate
  rather than lucky.
* `e2e/rbac.spec.js` — per-role scoping, and that `/users` is unreachable by URL
  for an employee rather than rendering a page that would only 403.
* `e2e/responsive.spec.js` — on a Pixel 5 profile, the table becomes cards and
  navigation collapses behind a drawer.

They run against a production build served by `vite preview`, so they exercise
the bundle that actually deploys. `workers: 1` because the specs share one
database and mutate incidents.

Every test creates the records it needs and can be run on its own — a journey
is modelled as one test made of `test.step()`s rather than as several tests
that depend on each other's order. Titles carry a timestamp and a random
suffix so repeated runs never collide, and assertions prefer durable page
state over the toast, which auto-hides and would otherwise make a slow run
fail for the wrong reason.

CI runs them in `.github/workflows/e2e.yml`, which stands up PostgreSQL, the
backend under uvicorn and the built frontend inside the job. No AWS access and
no secrets, so it runs on pull requests from forks too.

## Which backend the frontend talks to

`npm run dev` targets your local backend; a production build targets the
deployed one. This is pure Vite env-file resolution — `services/api.js` has no
branching in it.

| Priority | Source | Applies to |
| --- | --- | --- |
| 1 | shell environment | `bin/deploy-frontend.sh` exports `VITE_API_URL` before building |
| 2 | `.env.development.local` | `npm run dev` only |
| 3 | `.env.local` | everything else (written by `bin/generate-env.sh`) |

So `.env.development.local` shadows the generated CloudFront URL during
development, and is invisible to `npm run build`. Because `bin/generate-env.sh`
rewrites `.env.local` on every run, the local override must live in the
mode-specific file or it would be overwritten.

To point development at a local backend:

```sh
echo 'VITE_API_URL=http://127.0.0.1:8000' > .env.development.local   # uvicorn
# or, for the full ./bin/start-dev.sh stack which proxies on 3001:
echo 'VITE_API_URL=http://localhost:3001' > .env.development.local
```

`.gitignore` ignores `.env.*`, so that file stays on your machine; `.env.sample`
documents the scheme for everyone else.

## Roles in the UI

Route guards and conditional controls mirror the API's permissions so that no
button leads to a 403. The API remains the authority — this only avoids
dead ends:

| | Employee | Engineer | Facility Admin |
| --- | :---: | :---: | :---: |
| Dashboard, incidents, facilities, engineers | ✓ | ✓ | ✓ |
| Report an incident | ✓ | ✓ | ✓ |
| Assignment panel | – | ✓ | ✓ |
| Status controls | own resolved ticket | assigned | any |
| Internal notes | – | ✓ | ✓ |
| Facility / engineer CRUD | – | – | ✓ |
| Accounts page | – | – | ✓ |

## Responsive design

React Responsive drives the two layout switches, rather than CSS hiding
content: below 900px the sidebar becomes a drawer behind a hamburger, and the
incident table becomes a card list. A data table is unusable at phone width, so
both variants show the same fields arranged for the space available.

## Usage

### Local Development

To run your application locally:

```sh
./bin/start-dev.sh
```

To view your application, open the browser and navigate to `http://localhost:3000`.

### Cloud Deployment

To deploy your frontend to AWS:

```sh
./bin/deploy-frontend.sh
```

To view your application, open the browser and navigate to CloudFront URL.

## Clean Up

To remove all deployed resources (including frontend):

```sh
./bin/cleanup-environment.sh
```

**Warning**: This removes all infra resources. Cannot be undone.
