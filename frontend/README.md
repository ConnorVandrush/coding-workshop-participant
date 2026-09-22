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
│   │   │   ├── authSlice.js       # token, profile, persisted session
│   │   │   ├── incidentsSlice.js  # list, filters, detail, notes
│   │   │   ├── facilitiesSlice.js # buildings -> floors -> seats
│   │   │   ├── engineersSlice.js  # roster, workload, accounts
│   │   │   ├── dashboardSlice.js  # summary, hotspots, SLA, workflow
│   │   │   └── uiSlice.js         # toasts and the mobile drawer
│   │   ├── components/
│   │   │   ├── AppLayout.jsx      # responsive shell (sidebar / drawer)
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

## API base URL

One rule works in both environments, so `services/api.js` has no branching:

```
`${VITE_API_URL}/api/facility-api`
```

On AWS `VITE_API_URL` is the CloudFront domain and the `/api/facility-api`
cache behaviour forwards to the Lambda with the prefix intact; locally it is the
dev proxy on port 3001, which strips the same prefix. Both are written into
`.env.local` by `./bin/generate-env.sh`.

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

189 tests across the API client, the Redux slices, the components and every
page (84% statement coverage). They concentrate on behaviour a production build cannot catch:

* `services/api.test.js` — empty filters are dropped from query strings (the
  API rejects `""` for enum parameters), the error envelope is unwrapped, a 204
  returns null, and a network failure becomes a readable message.
* `store/*.test.js` — changing a filter returns to page one; a write refreshes
  both the detail view and the matching list row; a restored token that turns
  out to be expired is discarded rather than leaving a half-signed-in state.
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

13 Playwright tests over the journeys the workshop calls critical:

* `e2e/auth.spec.js` — anonymous redirect, bad credentials, off-domain
  registration, and a session surviving a reload then ending on sign out.
* `e2e/incident-lifecycle.spec.js` — the whole journey across three personas in
  one test built from `test.step()`s: an employee reports, an admin assigns,
  the engineer progresses, blocks with a reason, unblocks and resolves, and the
  reporter closes. Plus the note thread, internal notes staying invisible to
  employees, and escalation that only an admin can clear.
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
