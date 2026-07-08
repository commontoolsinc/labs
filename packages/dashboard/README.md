# Fabric wall — modular dev/company dashboard

A small Deno server that renders a dark, glanceable wall of status tiles and
refreshes browsers over Server-Sent Events. Every tile is one file with a fixed
interface; a single file registers them.

## Run

```bash
cd <repo root>
deno task dashboard      # = deno run … packages/dashboard/server.ts
# open http://localhost:8731
```

Tiles that read GitHub need `GH_TOKEN` (or `GITHUB_TOKEN`) set in the
environment. The other token-gated tiles gray out cleanly until their env vars
are set (see below).

Tasks: `deno task dashboard` (run), `deno task dashboard-watch` (reload on edit),
`deno task dashboard-test` (unit tests).

## Architecture

```
dashboard/
  types.ts      the interface: Tile, TileView, Status, Ctx, Route
  config.ts     port, repo, tunable status thresholds
  lib.ts        shared helpers (github, memo, escapeHtml, sparkline, strip, …)
  ctx.ts        shared, memoized data sources handed to every tile (ctx.runs)
  render.ts     renderTile(view) + the page shell/CSS
  server.ts     generic runtime: scheduler, SSE, route mounting, page assembly
  registry.ts   THE ONE REGISTRATION POINT — the array of tiles
  tiles/*.ts     one tile per file
```

`server.ts` knows nothing about individual tiles. It runs a single ticker,
collects each tile that is due (respecting its `intervalMs`), renders the
results uniformly, mounts any drill-down routes a tile declares, and pushes an
SSE reload when anything changes. A tile whose `collect()` throws is desaturated
to a gray "unknown" — it keeps its last-known value and shows a short reason
(e.g. "source unreachable"), with the full error in the server log — so one
unreachable source never blanks or breaks the board.

## Add a tile

1. Create `tiles/my-tile.ts`:

```ts
import type { Status, Tile, TileView } from "../types.ts";

export const myTile: Tile = {
  id: "my-tile",          // unique, stable
  intervalMs: 60_000,     // how often collect() runs
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
| `aside` | trusted inline HTML minor header facet |
| `href` | makes the whole tile a link (an `http…` link opens a new tab) |
| `hint` | small drill affordance, e.g. `"commits ↗"` |
| `wide` | render full-width below the grid instead of as a grid cell |

## Tiles

| tile | source | needs |
|---|---|---|
| main build, ci trust, ci duration, recent runs | GitHub Actions (`deno.yml` on main), via the REST API | `GH_TOKEN` (or `GITHUB_TOKEN`) |
| ci duration → `/ci` | runs `scripts/ci-gantt.ts` with live controls | — |
| production | synthetic HTTP check | `PROD_URL` (optional; defaults to production) |
| common.tools | synthetic HTTP check of the public site | `COMMON_TOOLS_URL` (optional; defaults to `https://common.tools`) |
| prod errors | SigNoz 5xx rate | `SIGNOZ_URL`, `SIGNOZ_API_KEY` |
| cloud spend | BigQuery billing export, via the REST API | `GCP_BILLING_TABLE` (+ Workload Identity, or `GCP_SA_KEY` locally), optional `GCP_DAILY_BUDGET` |
| github ci spend | GitHub Actions billing, projected to month-end (USD), with a 45-day daily-spend sparkline | `GH_TOKEN` (with org billing read); optional `GH_BILLING_ORG` |
| benchmark | a runtime benchmark's ~45-day trend, from the `benchmarks.yml` deno-bench artifacts on main | `GH_TOKEN`; optional `BENCH_METRIC` |
| model spend | OpenAI + Anthropic + OpenRouter usage APIs, summed | any of `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`, `OPENROUTER_KEY`; optional `MODEL_MONTHLY_BUDGET` |
| discord online | Discord gateway presence, team vs visitors over time | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` (Server Members + Presence intents) |

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

Powers **main build**, **ci trust**, **ci duration**, **recent runs**, and
**github ci spend**. Needs repo **Actions: read** on `commontoolsinc/labs`; the
github-ci-spend tile additionally needs org **Administration: read** on
`commontoolsinc`, which only an org owner or billing manager can grant. One
fine-grained token can carry both:

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal
   access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Set **Resource owner** to the **commontoolsinc** organization (not your
   personal account) — org ownership is what unlocks the billing permission.
3. **Repository access** → **Only select repositories** → `commontoolsinc/labs`.
4. **Repository permissions**: set **Actions** and **Contents** to **Read-only**.
5. **Organization permissions**: set **Administration** to **Read-only** — this
   is how github-ci-spend reads the billing usage and budget APIs. Skip it if you
   only want the CI tiles.
6. **Generate token** and copy it (`github_pat_…`, shown once).

If you only need the CI tiles, a token owned by your own account and scoped to
just `labs` with Actions/Contents read is enough. Classic PATs also work (use
`admin:org` for the billing scope). If the org requires approval for fine-grained
tokens, yours stays pending until an owner approves it.

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

The tile sums the raw `cost` column, i.e. total GCP spend across all services,
gross of credits.

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
| `GH_BILLING_ORG` | github ci spend | org login for billing (default: the org from `DASHBOARD_REPO` — `commontoolsinc`). |
| `MODEL_MONTHLY_BUDGET` | model spend | combined monthly USD budget across providers. |
| `GCP_SA_KEY` | cloud spend | a service-account key JSON (the whole file, as the value) for local development; in GKE, Workload Identity supplies the token and this is unset. |
| `GCP_DAILY_BUDGET` | cloud spend | daily USD budget. |
| `PROD_URL` | production | override the production URL. |
| `COMMON_TOOLS_URL` | common.tools | override the public-site URL (e.g. the `www` host if the apex redirects). |
| `DASHBOARD_REPO` | CI tiles | which repo the CI tiles read (default `commontoolsinc/labs`). |
| `DISCORD_HISTORY_FILE` | discord online | where the team/visitors history is persisted (default: a file in the temp dir). |
| `BENCH_METRIC` | benchmark | substring that pins which benchmark the grid tile shows; unset, it rotates hourly through all of them (see the note below). |

Notes:

- **One GitHub token:** every GitHub tile uses `GH_TOKEN`. The github-ci-spend
  tile needs it to also carry org billing read; a second token wouldn't reduce
  exposure (the process holds both anyway), so there is just the one. If you keep
  `GH_TOKEN` at Actions:read only, that tile grays out and the rest still work.
- **`github ci spend`** shows the org's **projected** full-month Actions spend —
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
- Watch mode (reloads the server on any edit to a tile or the core): `deno task dashboard-watch`.

Env knobs for the dev loop:

- `GH_TOKEN` (or `GITHUB_TOKEN`) — required for the GitHub tiles (main build, ci trust, ci duration, recent runs, and, with billing read, github ci spend); without it those tiles stay gray.
- `DASHBOARD_PORT` — run several instances at once (e.g. one per branch) without clashing.
- `DASHBOARD_REPO` — point the CI tiles at any repo.
- `PROD_URL` — point the production tile at a local server (`http://localhost:8000/`) instead of prod.
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
deno task dashboard-test     # = deno test --allow-env packages/dashboard/
```

`lib.test.ts` covers the pure helpers; `tiles.test.ts` covers each tile's
`collect()` — the CI tiles against canned runs, and the token-gated tiles'
gray-out contract. The suite is hermetic (no network, subprocess, or filesystem),
so it needs only `--allow-env` (for the module-load config reads). The one live
tile, `production`, is exercised by running the board rather than in the unit
suite. This is a workspace package, so its `deno test --allow-env` also runs as
part of the repo-wide `deno task test`.

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
   reach it, and mint an **ephemeral** `tag:dashboard` auth key. The tailnet
   also needs MagicDNS and HTTPS certificates enabled — `tailscale serve` fetches
   a cert for `dashboard.<tailnet>.ts.net` and can't without them.
2. `tofu apply` in `infra/tofu/gke` creates all the dev-dashboard Secret Manager
   containers (authkey, github token, and the optional discord/signoz ones). Then
   store the two required values:
   ```bash
   printf %s "tskey-auth-…" | gcloud secrets versions add k8s-stage-dashboard-authkey --data-file=-
   printf %s "github_pat_…" | gcloud secrets versions add k8s-stage-dashboard-github-token --data-file=-
   ```
   The GitHub token is fine-grained, read-only (repo `commontoolsinc/labs`, Actions: read).
   For the github-ci-spend tile it must additionally carry org billing read.

**Build, push, deploy** — two commands:

```bash
# labs repo: build the amd64 image, push it under the commit SHA and :latest
SHA=$(git rev-parse HEAD)
IMG=us-central1-docker.pkg.dev/commontools-core/containers/dev-dashboard
docker build --platform=linux/amd64 -f Dockerfile.dashboard -t "$IMG:$SHA" -t "$IMG:latest" . \
  && docker push "$IMG:$SHA" && docker push "$IMG:latest"

# infra repo: sync tile secrets, apply manifests, pin the SHA, wait for the rollout
cd ../infra/k8s && make apply-dev-dashboard-stage IMAGE="$IMG:$SHA"
```

`make apply-dev-dashboard-stage` ensures the namespace, syncs the dev-dashboard
ExternalSecrets, applies `manifests/dev-dashboard/` with the app image pinned to
`IMAGE`, and waits for the rollout. (`IMAGE` is required; the `:latest` in the
manifest is only the bootstrap default that `apply-all.sh` uses.) The node then
appears in the Tailscale console as `tag:dashboard`; open
`https://dashboard.<tailnet>.ts.net/`. (The sidecar image is already pinned by
`@sha256` digest in `03-deployment.yaml`, matching golink.)

**Gated tiles** stay gray until wired: add the Secret Manager *value* (the
container already exists from `tofu apply`), uncomment the ExternalSecret in
`dashboard-secrets.yaml` and the env block in `03-deployment.yaml`, then re-run
`make apply-dev-dashboard-stage IMAGE="$IMG:$SHA"`. So you can deploy green and
light tiles up one at a time.

Every backend is reached over its REST API, so the image carries no cloud CLI.
The GitHub tiles use `GH_TOKEN`; the cloud-spend tile queries BigQuery as the
pod's own service account through Workload Identity — the infra repo's
`tofu/gke/dashboard.tf` provisions that account, the Workload Identity binding,
and its BigQuery Job User + Data Viewer grants, so no key is stored in the
cluster. Lighting the tile up is then just setting `GCP_BILLING_TABLE` (and
`dashboard_billing_dataset` for the export dataset).

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
