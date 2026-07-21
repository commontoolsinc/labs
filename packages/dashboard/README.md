# Fabric wall — modular dev/company dashboard

A small Deno server that renders a dark, glanceable wall of status tiles and
updates their markup in place over Server-Sent Events. Every tile is one file
with a fixed interface; a single file registers them.

## Run

```bash
cd <repo root>
deno task dashboard      # = deno run … packages/dashboard/server.ts
# open http://localhost:8731
```

Tiles that read GitHub need `GH_TOKEN` (or `GITHUB_TOKEN`) set in the
environment. The other token-gated tiles gray out cleanly until their env vars
are set (see below).

The root `deno task dashboard` command starts the server once. Watch mode and
dashboard-specific tests are package tasks:

```bash
cd packages/dashboard
deno task watch
deno task test
```

## Architecture

```
dashboard/
  types.ts      the interface: Tile, TileView, Status, Ctx, Route
  config.ts     port, repo, tunable status thresholds
  lib.ts        shared helpers (github, memo, escapeHtml, sparkline, strip, …)
  ctx.ts        shared, memoized data sources handed to every tile (ctx.runs)
  favicon.ts    runtime status priority and access to generated PNG favicon copies
  favicon-png.generated.ts  generated runtime PNG favicon copies
  favicon-artwork.ts  build/test-only SVG source for those favicon copies
  render.ts     renderTile(view) + the page shell/CSS
  server.ts     generic runtime: scheduler, SSE, route mounting, page assembly
  registry.ts   THE ONE REGISTRATION POINT — the array of tiles
  tiles/*.ts     one tile per file
```

`server.ts` knows nothing about individual tiles. It runs a single ticker,
collects each tile that is due (respecting its `intervalMs`), renders the
results uniformly, mounts any drill-down routes a tile declares, and pushes new
tile markup as each collection completes. Every registered tile has a gray
placeholder labelled with its id in its registered position until its first
collection completes, so slow collectors do not leave holes in the board. A
tile whose `collect()` throws is desaturated to a gray "unknown" — it keeps its
last-known value and shows a short reason (e.g. "source unreachable"), with the
full error in the server log — so one unreachable source never blanks or breaks
the board.

Each event connection receives the current tile snapshot before it waits for
new collections. The browser reconciles that snapshot by tile ID, leaving
unchanged elements, focus, and scroll positions in place. Routine data updates
never navigate the page. A changed shell version reloads once so an unattended
display picks up new CSS or client code after a dashboard deployment.

The tab favicon follows the most urgent visible tile. It is red when any tile is
red, orange when there are no red tiles but at least one orange tile, and green
otherwise. Gray tiles do not turn the favicon gray. The page uses one URL-backed
PNG favicon. Scalable source artwork is used only to generate and verify those
raster assets; it is not part of the runtime dependency graph. The red favicon
starts sad and becomes a crying face after the dashboard stays red for one
continuous hour. The server retains the elapsed time across reloads. Returning
below red resets it once every collector due in the same pass has finished.

After changing `favicon-artwork.ts`, regenerate the embedded PNGs and their
content-based cache version from the dashboard package directory:

```bash
cd packages/dashboard
deno task regenerate-favicons
deno task test-favicon-raster
```

## Add a tile

1. Create `tiles/my-tile.ts`:

```ts
import type { Status, Tile, TileView } from "../types.ts";

export const myTile: Tile = {
  id: "my-tile",          // unique, stable
  intervalMs: 60_000,     // how often collect() runs
  // wide: true,           // optional full-width placement
  async collect(ctx): Promise<TileView> {
    // ctx.runs() -> shared CI runs; ctx.env("KEY") -> env var.
    // If a required env var is missing, return a gray "unknown" view — don't throw.
    const s: Status = "good";
    return { label: "my tile", status: s, value: "42", sub: "things" };
  },
  // routes: [{ path: "/my-drilldown", handler: (req, url) => new Response("…") }],
};
```

2. Register it in `registry.ts` (import + one line in the `TILES` array).

That's it. Remove a tile by deleting its line from `registry.ts` (and its file).

### Philosophy and values

The wall is something people glance at all day, often out of the corner of an
eye, so a tile's first duty is to inform without adding anxiety. Keep it calm by
default. There are only three signals — good, warn, and bad, plus a gray
"unknown" when a source is missing or a collector fails — because green should
mean "fine," red should mean "a person should act on this now," and there is
little in between worth manufacturing. Red has to stay rare and trustworthy: if
tiles sit red or amber most of the time, people stop seeing them, and a board
everyone has learned to ignore is worse than no board. A tile earns a color
change; it never reaches for one to get attention.

Think about how a tile makes someone feel before you think about what it
measures. Prefer an honest gray "unknown" over a false green — a tile that
can't tell "healthy" from "I couldn't reach the source," and stays green while
blind, is worse than one that admits it doesn't know. Report on the system,
never on individuals: no per-person leaderboards, no "who broke the build,"
nothing that turns the wall into a place to rank or shame people. And be wary of
the number that looks like progress but isn't — coverage percentage, lines of
code, raw PR counts — anything that becomes a bad target the moment someone
optimizes for it, or whose only job is to look busy. If a metric would quietly
pressure people into gaming it, leave it off. This is a quiet instrument panel a
tired person should be able to trust at 2am, not a scoreboard and not a
surveillance tool.

### The `TileView` a tile returns

| field | meaning |
|---|---|
| `label` | header text (plain; escaped for you) |
| `status` | `good` / `warn` / `bad` / `unknown` → green / orange / red / gray |
| `value` | big headline (trusted HTML — escape data with `escapeHtml`) |
| `sub` | sub line (plain; escaped for you) |
| `extra` | trusted inline HTML under the value (sparkline / strip / list) |
| `duration` | a span in milliseconds, rendered (via `humanSpan`) in the chart's bottom-left corner |
| `aside` | trusted inline HTML minor header facet (e.g. an MTD or a "running" badge) |
| `href` | makes the whole tile a link (an `http…` link opens a new tab) |
| `hint` | small drill affordance, e.g. `"commits ↗"` |

## Tiles

| tile | source | needs |
|---|---|---|
| labs ci, labs ci trust, labs ci duration | GitHub Actions (`deno.yml` on main in `commontoolsinc/labs`), via the REST API | `GH_TOKEN` (or `GITHUB_TOKEN`) |
| loom ci, loom ci trust, loom ci duration | the same three tiles for `commontoolsinc/loom` (`test-fast.yml` on main) | `GH_TOKEN` (read access to loom); optional `DASHBOARD_LOOM_REPO` |
| recent main runs | labs + loom main runs interleaved chronologically, each row tagged with its repo | `GH_TOKEN` |
| labs ci duration → `/ci` | runs `scripts/ci-gantt.ts` with live controls (labs only) | — |
| production | synthetic HTTP check of the production server: `/_health` on `PROD_URL`'s origin, which answers only while the server is really serving. Defaults to estuary, the production toolshed. Estuary is on the tailnet, so a dashboard that cannot reach the tailnet needs `PROD_URL` pointed at something it can | `PROD_URL` (optional) |
| common.tools | synthetic HTTP check of the public site | `COMMON_TOOLS_URL` (optional; defaults to `https://common.tools`) |
| prod errors | SigNoz trace error rate for one service (errored spans / all spans): last-12h headline, with a per-hour sparkline over the retained trace history (~2 weeks) and the last-12h slice that feeds the headline highlighted. Scoped to `PROD_SERVICE` — the same SigNoz holds staging and one-off perf runs, whose rates are not production's. Gray (not red) when SigNoz is unreachable. Pops out to the SigNoz logs explorer | `SIGNOZ_URL`, `SIGNOZ_API_KEY`; optional `PROD_SERVICE`, `SIGNOZ_UI_URL` for the pop-out |
| cloud spend | BigQuery billing export, via the REST API | `GCP_BILLING_TABLE` (+ Workload Identity, or `GCP_SA_KEY` locally), optional `GCP_DAILY_BUDGET` |
| ci spend | GitHub Actions billing, projected to month-end (USD), with a 45-day daily-spend sparkline. Month-to-date sits in the header (the `aside` slot); the sub shows the GitHub-configured budget when there is one; the span the sparkline covers is in its bottom-left corner (the `duration` slot) | `GH_TOKEN` (with org billing read); optional `GH_BILLING_ORG` |
| benchmark | a runtime benchmark's ~45-day trend, from the `benchmarks.yml` deno-bench artifacts on main | `GH_TOKEN`; optional `BENCH_METRIC` |
| model spend | OpenAI + Anthropic + OpenRouter usage APIs. Headline is the projected full-month spend (extrapolated from the recent daily rate, spilling into last month when this month is under two weeks old), summed across providers. OpenAI and Anthropic (which expose per-day cost) are charted as one line each over ~45 days, dimmed except for the current-month slice that feeds the headline, with each line's MTD in the right gutter; OpenRouter (monthly total only, abbreviated "OR") is folded into the totals. The subtitle is the bullet-separated key (`OpenAI • Anthropic • OR $0`); the combined MTD sits in the header (the `aside` slot); the span the chart covers is in its bottom-left corner (the `duration` slot). A provider we can't read shows `$???` and drops the tile to gray, but the rest still chart and total | any of `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`, `OPENROUTER_KEY`; optional `MODEL_MONTHLY_BUDGET` |
| discord online | Discord gateway presence, team vs visitors over time | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` (Server Members + Presence intents) |
| dau | distinct identities active per UTC day on one named service, counted from the `user.did` attribute on the `memory.transact` and `memory.subscriber.sync` spans in SigNoz. The headline is the last day that ran to the end (today is still filling, and a part-day always reads as a drop); the sparkline is the retained history. Gray while the named service has no such spans — which is the resting state until a deployment's tracing is switched on. It counts keypairs rather than people; see [dau](#dau) below | `SIGNOZ_URL`, `SIGNOZ_API_KEY`; optional `PROD_SERVICE`, `DAU_EXCLUDE_DIDS`, `SIGNOZ_UI_URL` |
| github users | organization members plus outside collaborators, with each roster's size charted over about two months. The headline counts unique users across both rosters | `GH_TOKEN` (with org Members read) |

## Credentials

Every tile that reads a private source is gated on its own env var(s) and grays
out until they are set. The GitHub tiles need `GH_TOKEN`; every other
private-source tile is independently optional — set only the ones you want, and
the rest stay gray without breaking the board. Each key below lists what it
powers, the rights it needs, and how to mint it. (`common.tools` and
`production` need no key.)

Almost every credential is shown only once at creation — copy it immediately;
if you lose it you have to regenerate.

### `GH_TOKEN` (or `GITHUB_TOKEN`)

Powers **labs ci**, **labs ci trust**, **labs ci duration**, the **loom**
counterparts, **recent main runs**, **ci spend**, and **github users**. Needs repo
**Actions: read** on both `commontoolsinc/labs` and `commontoolsinc/loom`; the
github-ci-spend tile additionally needs org **Administration: read** on
`commontoolsinc`. The **github users** tile needs org **Members: read**. One
fine-grained token can carry all of these permissions:

The account that owns the token must be a member of the organization. GitHub's
member endpoint returns both concealed and public members to an authenticated
organization member; other callers see only public memberships.

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal
   access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Set **Resource owner** to the **commontoolsinc** organization (not your
   personal account) — org ownership is what unlocks the billing permission.
3. **Repository access** → **Only select repositories** → `commontoolsinc/labs`
   and `commontoolsinc/loom`.
4. **Repository permissions**: set **Actions** and **Contents** to **Read-only**.
5. **Organization permissions**: set **Members** to **Read-only** for GitHub
   users. Set **Administration** to **Read-only** for ci spend. Only an org
   owner or billing manager can grant the latter permission. Skip either
   permission when its tile is not needed.
6. **Generate token** and copy it (`github_pat_…`, shown once).

If you only need the labs CI tiles, keep `commontoolsinc` as the resource owner,
select only `commontoolsinc/labs`, and grant Actions/Contents read without any
organization permissions. Classic PATs also work (use `read:org` for GitHub
users and `admin:org` for ci spend). If the org requires approval for
fine-grained tokens, yours stays pending until an owner approves it.

### `SIGNOZ_URL` + `SIGNOZ_API_KEY`

Powers **prod errors**. Needs a read-only (Viewer) key on the SigNoz query API;
creating one requires an Admin.

1. In SigNoz (Cloud at `app.signoz.cloud`, or your self-hosted URL) → **Settings**
   → **Service Accounts** → **New Service Account** (e.g. `dashboard-reader`).
2. Assign it the **signoz-viewer** role (read-only query access).
3. Open the service account → **Keys** tab → **Add Key**, name it, optionally set
   an expiry → **Create**, and copy the key (opaque string, shown once). It's sent
   as the `SIGNOZ-API-KEY` header.
4. Set `SIGNOZ_URL` to the instance base URL — `https://<region>.app.signoz.cloud`
   for Cloud (`us`, `eu`, …), or your self-hosted host (default UI port `8080`).

Don't use an **ingestion** key (`signoz-ingestion-key`, write-only for telemetry);
the tile needs the read/query API key.

### `GCP_BILLING_TABLE` (+ Workload Identity, or `GCP_SA_KEY`)

Powers **cloud spend**. The tile queries BigQuery over its REST API — no `bq` or
`gcloud` CLI. There's no API key for BigQuery (a key doesn't identify a
principal), so it authenticates as a service account and gets an access token one
of two ways: in GKE the metadata server hands one out for the pod's own account
(Workload Identity, no key stored); locally, set `GCP_SA_KEY` to a service-account
key JSON and the tile signs a JWT and exchanges it for a token. The account needs
**BigQuery Job User** on the query project plus **BigQuery Data Viewer** on the
dataset.

1. Console → **Billing** → select the billing account → **Billing export**.
2. Create a BigQuery **dataset** to hold the export (a US or EU multi-region
   location lets it backfill).
3. Under **Billing export** → **Standard usage cost**, choose the project and
   dataset → **Save**. Data starts landing after a few hours.
4. The export table is named `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`; set
   `GCP_BILLING_TABLE` to `project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`.
   The query runs in that table's project, so the service account needs Job User
   there.
5. In the GKE deploy this is already provisioned: the infra repo's
   `tofu/gke/dashboard.tf` creates the service account, binds the pod's Kubernetes
   service account to it with Workload Identity, and grants **roles/bigquery.jobUser**
   on the project plus **roles/bigquery.dataViewer** on the export dataset (point
   `dashboard_billing_dataset` at that dataset). Enabling the tile is then just
   setting `GCP_BILLING_TABLE`.
6. For local development instead, grant those two roles to a service account,
   download a key for it, and set `GCP_SA_KEY` to the file's contents.

The tile sums the raw `cost` column, i.e. total spend across every project tied
to the exported billing account, gross of credits.

### `OPENAI_ADMIN_KEY`

Powers the OpenAI share of **model spend**. Needs an organization **Admin** key —
only an org **Owner** can create one, and a project key (`sk-proj-…`) gets a 401
on the costs endpoint.

1. Go to **platform.openai.com → Settings → Organization → Admin keys**.
2. **Create new admin key**, name it, **Create**.
3. Copy it (`sk-admin-…`, distinct from `sk-proj-…`, shown once). Treat it like a
   root credential — it grants full org management.

### `ANTHROPIC_ADMIN_KEY`

Powers the Anthropic share of **model spend**. Needs an **Admin** key
(`sk-ant-admin01-…`), created by an org admin/owner; a normal API key is rejected
by the cost-report endpoint.

1. **console.anthropic.com → Settings → Admin keys**.
2. **Create key**, name it, **Create**.
3. Copy the `sk-ant-admin01-…` secret (shown once). Console admin keys have no
   selectable scopes — they carry full Admin API access, so guard it like a root
   credential.

### `OPENROUTER_KEY`

Powers the OpenRouter share of **model spend**. A plain inference key (`sk-or-…`)
is enough — the tile only reads the key's own month-to-date usage via
`GET /api/v1/key`, so no admin/management key is needed.

1. **openrouter.ai → Settings → Keys** → **Create API Key**, name it, **Create**.
2. Copy the `sk-or-…` key (shown once).

Use a normal key, not a **Management** key — management keys can't call
`/api/v1/key`.

### `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID`

Powers **discord online**. Needs a bot with the **Server Members** and
**Presence** privileged intents, invited to the server, plus the server id.

1. **discord.com/developers/applications → New Application**, name it, **Create**.
2. **Bot** (left sidebar) → **Reset Token** → copy the token (shown once).
3. Still on the Bot page → **Privileged Gateway Intents** → toggle **Server
   Members Intent** and **Presence Intent** ON → **Save Changes**. Without both,
   the gateway closes the connection with error `4014` (disallowed intents).
4. Under **Installation** (or OAuth2 → URL Generator), select the **`bot`** scope,
   copy the install link, open it, pick your server, **Authorize**.
5. In Discord: **User Settings → Advanced → Developer Mode** ON, then right-click
   the server → **Copy Server ID** → that's `DISCORD_GUILD_ID` (an 18–20 digit
   number).

Resetting the token invalidates the previous one, breaking anything still using
it.

**Optional, non-secret knobs** (no key; they tune behavior):

| env var | tile | purpose |
|---|---|---|
| `GH_BILLING_ORG` | ci spend | org login for billing (default: the org from `DASHBOARD_REPO` — `commontoolsinc`). |
| `MODEL_MONTHLY_BUDGET` | model spend | combined monthly USD budget across providers. |
| `GCP_SA_KEY` | cloud spend | a service-account key JSON (the whole file, as the value) for local development; in GKE, Workload Identity supplies the token and this is unset. |
| `GCP_DAILY_BUDGET` | cloud spend | daily USD budget. |
| `PROD_URL` | production | the production **server**, as an origin — the tile checks `/_health` on it and links to it. Defaults to estuary, the production toolshed. Note `production.commontools.dev` is the shell, a static site in a GCS bucket: it has no health endpoint, and its index page answers 200 whether or not the server behind it is serving, so it cannot see an outage. |
| `PROD_PROXY` | production | optional proxy used only for the production health check. Use `socks5h://127.0.0.1:1055` with the Tailscale userspace proxy so the tailnet hostname resolves through it. Also accepts `socks5://`, `http://`, and `https://`; invalid values fail closed instead of fetching directly. |
| `COMMON_TOOLS_URL` | common.tools | override the public-site URL (e.g. the `www` host if the apex redirects). |
| `DASHBOARD_REPO` | CI tiles, github users | which repo the CI tiles read. Its owner is the organization the **github users** tile reads (default `commontoolsinc/labs`). |
| `DISCORD_HISTORY_FILE` | discord online | where the team/visitors history is persisted (default: a file in the temp dir). |
| `GITHUB_MEMBERS_HISTORY_FILE` | github users | where the Members/Collaborators history is persisted (default: an organization-specific file in the temp dir). |
| `BENCH_METRIC` | benchmark | substring that pins which benchmark the grid tile shows; unset, it rotates hourly through all of them (see the note below). |
| `SIGNOZ_UI_URL` | prod errors | browser-facing SigNoz URL for the "logs" pop-out. Defaults to `SIGNOZ_URL` when that is a public `https://` URL; set it when the server reaches SigNoz over an in-cluster URL a browser can't. |
| `PROD_SERVICE` | prod errors, dau | the `service.name` production reports under in SigNoz, which both trace-reading tiles scope to. Defaults to `toolshed-production`. A name outside `[A-Za-z0-9._-]` is ignored, since it lands inside a query expression. |
| `DAU_EXCLUDE_DIDS` | dau | comma-separated identity DIDs to leave out of the count — the server's own identity, `MEMORY_SERVICE_DIDS`, background services. Until it is set the count is an upper bound. See [dau](#dau) below. |

<a id="dau"></a>
**What the dau tile counts.** Distinct `user.did` values per UTC day, over the
`memory.transact` and `memory.subscriber.sync` spans of one named service, read from
the same SigNoz the prod errors tile uses. `user.did` is the memory session principal,
which is the signature-checked `session.open` issuer, so no new instrumentation is
involved. `docs/development/active-user-counting.md` records what the number means.
Four things bound it, and they are worth knowing before quoting it:

- **It counts identities, not people.** An identity is a keypair. One person with a
  browser mnemonic and a `cf id derive` passphrase is two; one key shared across a team
  is one. The tile says "active identities" for that reason.
- **Some identities are not people at all.** The server's own identity and the DIDs in
  `MEMORY_SERVICE_DIDS` are principals in the same way a user is. Name them in
  `DAU_EXCLUDE_DIDS`; until then the count is an upper bound.
- **Read-only sessions are invisible.** `session.open` emits no span, so someone who
  connects and only reads is never attributed, and a day of purely read-only traffic
  reports zero.
- **The history is as long as trace retention**, roughly a fortnight, and that retention
  is a live setting on the SigNoz database rather than anything this repository holds.

Head sampling below 1.0 would not scale this number down, it would drop identities out
of it, and no arithmetic afterwards would put them back.

The tile is gray whenever the named service has no identity-bearing spans in the
retained window, which is the resting state for a deployment whose tracing is switched
off. It needs no second change to light up once that deployment starts exporting.

Notes:

- **One GitHub token:** every GitHub tile uses `GH_TOKEN`. The github-ci-spend
  tile also needs org billing read. The **github users** tile needs org Members
  read. A second token would not reduce exposure because the process would hold
  both, so there is just one. With Actions read alone, those two tiles gray out
  and the other GitHub tiles still work.
- **`ci spend`** shows the org's **projected** full-month Actions spend —
  extrapolated from the billable daily rate over a trailing window of at least two
  weeks (spilling into last month's daily data early in the month), or the whole
  month-to-date when that's longer, so a couple of noisy early-month days don't
  dominate. It's measured against the Actions **budget configured in GitHub**
  (Settings → Billing → Budgets), which the tile reads automatically via the
  budgets API. The spend is billable USD **net of discounts**, so the included-usage
  allowance is already deducted; the sub-line shows the actual month-to-date. GitHub's
  billing data is per-day (and per-SKU, per-repo) — no finer. If GitHub has no
  Actions budget set, the tile shows the projection without a budget comparison.
  (Classic-plan orgs fall back to minutes vs the included allowance.)
- **`benchmark`** trends one `deno bench` measurement over ~45 days. The
  `benchmarks.yml` job on main runs `deno bench --json` over the runner, cache,
  and deep-equal benchmarks and uploads the report as a `bench-results` artifact
  (90-day retention; there is no committed history). The tile lists benchmark runs
  on main, samples one run per 4-hour window, downloads that artifact, unzips it
  in-process, and reads each benchmark's timings; per-run results are cached, so
  only new runs are fetched after the first fill. The grid tile plots **p99**. With
  `BENCH_METRIC` set it pins to the benchmark whose `<file> > <group>/<name>` key
  contains that substring; otherwise it **rotates** — showing one benchmark per
  clock-hour, chosen deterministically from the hour so a fresh dashboard on any
  machine shows the same one for the same hour. It goes **orange** when that
  benchmark's 45-day trend rises past 5% and **red** past 20% ("trending up
  rapidly"); flat or falling is green. A large regression reads as a fold
  multiplier (`▲44×`) once it passes 4x, rather than a long percentage. The trend
  is a robust **daily-median Theil–Sen** fit: the sub-daily samples are first
  collapsed to one median per calendar day, then the trend is the median of the
  pairwise log-slopes between days, projected across the day span. The daily median
  absorbs within-day spikes, the median-of-slopes tolerates roughly a third of the
  days being outliers, and working per calendar day (not per sample or per
  millisecond) keeps it time-aware without letting two noisy runs a few hours apart
  blow up the slope — which is what naive per-millisecond weighting does. A
  benchmark with fewer than 7 distinct days in the window is reported as flat: too
  little data to claim a trend. The window is capped by the 90-day artifact
  retention, so it shows at most ~45 days and only as far back as the job has run.
  (4-hour sampling means many more points than daily, so the first cache fill
  downloads correspondingly more artifacts.)
  - Its **`/bench` drill-down** shows a sparkline for **every** benchmark on a
    shared calendar-time axis, so a late-starting benchmark sits at the right and a
    stale one visibly ends short of it. Selectors choose which measurement to plot
    (a percentile ladder — **p0** = min, **p50** = the mean, **p75**, **p99**,
    **p99.5**, **p99.9**, **p100** = max) and whether to sort by source **file** or
    by **trend** (biggest rise first); a "hide green" checkbox drops the steady
    ones. Each row is coloured by its own trend, and the page reads from the tile's
    cache so it re-renders instantly.
- **Deploying these gated tiles** follows the same pattern as the existing ones:
  add the value to Secret Manager, wire an ExternalSecret in
  `dashboard-secrets.yaml`, and add the env to `03-deployment.yaml` (see the
  Deploying section below).

Everything below is a tunable constant in `config.ts`:

- **Status thresholds:** `TRUST_GOOD`/`TRUST_WARN` (first-try-green %), `DUR_GOOD`/`DUR_WARN` (median CI minutes).
- **Data windows:** the shared fetch is `min(CI_RUNS_MAX=200 commits, CI_RUNS_MAX_AGE_DAYS=60)`; ci-trust uses all of it, ci-duration's median uses `max(DUR_MIN_RUNS=20, DUR_MAX_AGE_HOURS=6)` and says which basis it's on, recent-runs shows `RECENT_DISPLAY=50`.
- **ci-trust cell grid:** `TRUST_COLS=40` columns, count rounded down to whole rows, up to `TRUST_STRIP=200` cells.

## Local development

Local-first: no build step, no deployment, a single process on `localhost`.

- One-shot: `deno task dashboard`.
- Watch mode from `packages/dashboard` (reloads the server on any edit to a tile
  or the core): `deno task watch`.

Env knobs for the dev loop:

- `GH_TOKEN` (or `GITHUB_TOKEN`) — required for the GitHub tiles. CI spend also
  needs Administration read. GitHub users also needs Members read. Without the
  token, those tiles stay gray.
- `DASHBOARD_PORT` — run several instances at once (e.g. one per branch) without clashing.
- `DASHBOARD_REPO` — point the CI tiles at any repo. Its owner selects the
  organization for GitHub users.
- `PROD_URL` — point the production tile at a local server (`http://localhost:8000/`) instead of prod. It checks `/_health` on that origin.
- `PROD_PROXY` — route only the production health check through a proxy, for example `socks5h://127.0.0.1:1055` with a local Tailscale userspace proxy.
- The other credential envs (see **Credentials** above — `SIGNOZ_*`, `GCP_*`, `OPENAI_ADMIN_KEY`/`ANTHROPIC_ADMIN_KEY`/`OPENROUTER_KEY`, `DISCORD_*`) — set one to develop that gated tile against its real backend.

It never crashes on a missing credential: the GitHub tiles need `GH_TOKEN` and
the other private-source tiles each need their own env var, and any tile whose
`collect()` throws (missing token, offline) just shows a gray "unknown" while the
rest of the board keeps working — so you can develop against whatever you happen
to have access to.

Developing one tile in isolation: a tile is a pure `collect(ctx) -> TileView`, so
you can exercise it with a hand-made `Ctx` in a `deno test`, no server or live
source required:

```ts
const fakeCtx = { runs: async () => FIXTURE_RUNS, env: (_: string) => undefined };
const view = await myTile.collect(fakeCtx);
// assert on view.status / view.value …
```

### Tests

```bash
cd packages/dashboard
deno task test
```

`lib.test.ts` covers the pure helpers; `tiles.test.ts` covers each tile's
`collect()` — the CI tiles against canned runs, and the token-gated tiles'
gray-out contract. These ordinary unit tests are hermetic and need only
`--allow-env` for module-load configuration reads. The full `test` task also
verifies that Resvg reproduces the embedded PNGs and runs the favicon
behavior in the local browser test runner. The package tasks grant the additional
permissions those two checks need. The one live tile, `production`, is exercised
by running the board rather than in the unit suite. This is a workspace package,
so its ordinary unit tests also run as part of the repo-wide `deno task test`.

## Deploying (stage GKE, tailnet-only)

The deploy artifacts follow the golink pattern. `Dockerfile.dashboard` (labs repo
root) builds the image; the manifests, ExternalSecrets, and tofu secret
containers live in the **infra** repo (`k8s/manifests/dev-dashboard/`,
`k8s/overlays/stage/external-secrets/dashboard-secrets.yaml`,
`tofu/gke/secrets.tf`), and it is wired into `make apply-dev-dashboard-stage` and
`apply-all.sh`. Access is tailnet-only at `https://dashboard.<tailnet>.ts.net`
via a userspace Tailscale sidecar (the one adaptation golink gets for free from
its embedded tsnet).

**One-time setup (human steps):**

1. Tailscale admin console: add `tag:dashboard` to `tagOwners`, grant who may
   reach it, and configure a federated identity restricted to `auth_keys` and
   `tag:dashboard`. The infra overlay supplies that identity's public client ID
   with `ephemeral=false&preauthorized=true` and its audience; no Tailscale auth
   key or OAuth secret is stored in Kubernetes or Secret Manager. The tailnet
   also needs MagicDNS and HTTPS certificates enabled — `tailscale serve`
   fetches a cert for `dashboard.<tailnet>.ts.net` and can't without them.
2. `tofu apply` in `infra/tofu/gke` creates the dev-dashboard Secret Manager
   containers and Workload Identity/BigQuery grants. Store the required GitHub
   token (and each provider credential you want to enable):
   ```bash
   printf %s "github_pat_…" | gcloud secrets versions add k8s-stage-dashboard-github-token --data-file=-
   ```
   The GitHub token is fine-grained and read-only. It has Actions read for the
   dashboard repositories. The GitHub users tile also needs org Members read;
   CI spend also needs org Administration read.
3. The infra manifests create separate 1 Gi `standard-rwo` PVCs for the Discord
   history file and Tailscale node state. The dashboard remains a one-replica
   `Recreate` Deployment; pod replacement reuses the same non-ephemeral
   Tailscale node ID and `dashboard.<tailnet>.ts.net` name.

**Build, push, deploy**

`.github/workflows/dashboard-image.yml` runs only when the dashboard image,
dashboard package, Gantt drill-down, Deno dependency metadata, or the workflow
itself changes. Pull requests always run the dashboard tests and an amd64 image
build without cloud credentials.

For organization-member pull requests, a passing dashboard test and image build
publish the source commit as `dev-dashboard:<full-sha>`. A controlled rerun may
override a failed dashboard test by temporarily setting the repository Actions
variable `PUSH_BRANCH=true`; the image build must still pass, the rerun must have
`github.run_attempt > 1`, and GCP independently verifies the actor's numeric org
membership ID. Reset `PUSH_BRANCH=false` immediately after testing. Main-branch
pushes publish both the immutable SHA tag and `latest`. Once a SHA tag exists,
reruns reuse its digest instead of rebuilding or moving the tag.

The publish job authenticates with GitHub OIDC and GCP Workload Identity
Federation. It emits the immutable `sha256:` image reference in the workflow
summary; no service-account JSON key is used.

Manual build fallback:

```bash
SHA=$(git rev-parse HEAD)
IMG=us-central1-docker.pkg.dev/commontools-core/containers/dev-dashboard
docker build --platform=linux/amd64 -f Dockerfile.dashboard -t "$IMG:$SHA" .
docker push "$IMG:$SHA"
```

Copy the published digest from the workflow summary into the infra stage
overlay's `images[].digest`, commit that immutable pin, then run
`make apply-dev-dashboard-stage` from `infra/k8s`. The node then appears in the
Tailscale console as `tag:dashboard`; open
`https://dashboard.<tailnet>.ts.net/`. (The sidecar image is already pinned by
`@sha256` digest in `03-deployment.yaml`, matching golink.)

**Provider-gated tiles** stay gray until their credential or public configuration
is wired: add the Secret Manager *value* (the container already exists from
`tofu apply`), enable the matching ExternalSecret/env when needed, then re-run
`make apply-dev-dashboard-stage`. Stage's Cloud Billing table is already wired;
during Google's initial export backfill it reports `no billing data yet` rather
than a false zero.

Every backend is reached over its REST API, so the image carries no cloud CLI.
The GitHub tiles use `GH_TOKEN`; the cloud-spend tile queries BigQuery as the
pod's own service account through Workload Identity — the infra repo's
`tofu/gke/dashboard.tf` provisions that account, the Workload Identity binding,
and its BigQuery Job User + Data Viewer grants, so no key is stored in the
cluster. The stage deployment sets `GCP_BILLING_TABLE` to the standard export
table, and `dashboard_billing_dataset` scopes its dataset reader grant.

## Design notes

A couple of choices the code alone doesn't explain:

- **Calm by default, three signals.** A tile is only ever good, warn, or bad,
  plus a gray "unknown" when its source is missing or a collector errors. There
  is no finer severity scale: green means fine, red means act now, and anything
  the board can't judge goes gray rather than crying wolf. The layout is built
  for glanceability — readable in a second from across the room — so it stays
  dark and free of attention-grabbing animation, and it reports on the system
  rather than on individuals. A failing collector degrades to gray with a short
  reason instead of blanking or alarming, and the header's "updated Ns ago" is a
  deliberately honest liveness signal. `/healthz` reports whether the board has
  collected anything; point an external uptime check (on a different host) at it,
  since a board that can't reach its own sources can't page you about itself.
- **Why Deno + TypeScript.** The dashboard lives in the labs workspace and shares
  its one toolchain and the team's TypeScript fluency. An earlier rationale — that
  it would import the repo's performance tooling in-process — no longer holds: it
  fetches the same GitHub JSON directly. If it ever needs a single self-contained
  binary with no runtime dependencies, a compiled language would be worth
  reconsidering; today the workspace fit wins.
