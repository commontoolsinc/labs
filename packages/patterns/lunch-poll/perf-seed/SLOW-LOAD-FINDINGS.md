# Lunch Poll — slow initial load: instrumented root cause

**Status:** root cause **measured and grounded**, no fix applied yet. Fix levers
below are ranked + attribution-backed but **not yet verified by experiment**.

**TL;DR.** Initial load is slow because the poll instantiates a **huge reactive
graph (~2.4–3.1k nodes for a 10-option poll)** *and* that graph **re-settles
~6× on load** (6,654 computation runs over ~1,100 nodes). The cost is the
runtime's per-value machinery (SES deep-freeze, schema traverse/validate,
read-provenance, encode/clone) executed over that node×rerun product — **not**
the bundle, the pattern compile, the network, the main thread, or the data
(inline art was tested and **exonerated**). Two source sites dominate:
`main.tsx:1166` (350 nodes) and the per-option `poll-option-card.tsx` web-search
fetch (~2,350 reruns).

---

## 1. Symptom & environment

- Reported: extremely slow initial load, socket-error cascades, vote flicker.
  **This doc is the slow-load investigation only** (separate from sockets/flicker).
- Rapids staging (`rapids.saga-castor.ts.net`, build `040b201f0`,
  `ENVIRONMENT=development`) reproduces for real users. Dataset is tiny:
  **10 options · 35 votes · 4 users**.
- Reproduced locally (same dev build) at **~2.2s** time-to-interactive (rapids
  ~3.4s; the delta is just tailnet latency). Local mirror via
  [`seed.sh`](./seed.sh).

## 2. Method (tools used — all read-only, no runtime edits)

- `agent-browser` for cold-load timing, console, network, screenshots.
- Chrome DevTools **trace** (`agent-browser trace`) → thread/event self-time.
- Chrome **CPU profile** (`agent-browser profiler`) → function self-time.
- The built-in **Shell Debugger** (menu → "Toggle debug mode"): Scheduler graph,
  Loggers, Diagnosis. Reached programmatically via the page global
  **`commonfabric.rt`** (`getGraphSnapshot()`, `getLoggerCounts()`),
  `commonfabric.getTimingStatsBreakdown()`, and `commonfabric.detectNonIdempotent()`.
- Scaling A/B via `seed.sh --empty | --no-art | (full)`.

## 3. Where the 2.2s goes

| Signal | Value | Source |
|---|---|---|
| Worker (`DedicatedWorker`) busy | ~2.7s | trace |
| Main/UI thread busy | ~0.09s | trace |
| `RunMicrotasks` self-time | ~2.5s | trace |
| V8 GC | ~0.6–0.9s | trace |
| Scheduled tasks (`wakeup.flow`) | 18k (empty) → 30k (full) | trace |
| First-contentful-paint | ~40ms | `performance` |
| Document + bundle load-event | ~0.14s | navigation |

The work is in the **client-side runtime worker**, dominated by async/microtask
reactive evaluation + GC. The page only paints once (40ms FCP); the ~2.2s is
graph settling behind it.

## 4. Scaling A/B (via seed.sh) — fixed cost **and** per-item cost

| variant | worker busy | RunMicrotasks | GC | wakeup.flow |
|---|---|---|---|---|
| `--empty` (0 opt) | 916ms | 670ms | 187ms | 17,711 |
| 3 options | 2050ms | 1656ms | 517ms | 25,032 |
| full (10 opt) | 2721ms | 2225ms | 944ms | 29,302 |

An **empty** poll still burns ~0.9s + 17.7k wakeups → a large **fixed graph-boot
cost**. Options add ~100–180ms each on top, GC scaling 5×.

**Art is not the cause:** stripping `imageUrl` (63,690 → 1,217 bytes,
`--no-art`) left load **unchanged at 2.2s**.

## 5. Root cause — measured from the scheduler graph

`commonfabric.rt.getGraphSnapshot()` on a fresh settled load:

- **~2,400–3,100 nodes / ~4,600 edges** (fluctuates as it settles).
- By kind: **~1,061 input · ~739 action · ~309 sink · ~271 raw · ~1,000 computation**.
- **Redundancy:** node `stats.runCount` summed = **6,654 computation runs over
  ~1,109 nodes ≈ ~6× reruns per node** for a single static load. The graph
  re-settles several times instead of converging in 1–2 passes.
- Corroborated page-side: **~117–164 VDOM apply-batches** per load
  (`commonfabric.getLoggerCountsBreakdown()['vdom-applicator']`) and **~81.5k**
  worker logger events.

So: **big graph × ~6× reruns × per-value runtime machinery (freeze / schema /
read-provenance / encode) = ~2s.**

## 6. The dominant source sites (node + rerun attribution)

Bucketing nodes by the source site encoded in `node.id`:

| Site | Nodes | Runs | What it is |
|---|---|---|---|
| **`main.tsx:1166`** | **350** | 700 | `votes.filter(v => v.optionId===oid).map(...)` vote-swatches **nested in the per-option loop** → O(options×votes) |
| **`raw:fetch`** | 20 | **2,350** | per-option web-search POST (homepage enrichment) re-firing ~117×/node |
| **`poll-option-card.tsx:343`** | — | **2,347** | per-option `fetchedHomePageUrl` / `homePageSearch` computeds re-firing ~235×/card |
| `raw:if` | 196 | 232 | conditional nodes (`ifElse`/`when`/`unless` swarm) |
| `poll-option-card.tsx:262-264,307,315` | 10 ea | 67–77 | per-option-card computeds (`myVote`, `refresh`, image) |
| `main.tsx:1180/1184/1189` | 35 ea | 35–70 | per-vote swatch span attributes |

Structural drivers:
1. **Per-option `poll-option-card` sub-pattern (×10)** each runs a **web-search
   `raw:fetch` + homepage computeds** that re-fire hundreds of times → biggest
   rerun cost. (This is what the `lunch-poll-remove-web-search` branch targets.)
2. **`main.tsx:1166` nested `votes.filter().map()`** per option → 350 nodes for
   vote badges, O(options×votes).
3. A **`participant-identity-card` sub-pattern per participant** + a large
   conditional-node swarm inflate the fixed graph.

## 7. What it is NOT
Bundle parse/eval (~60ms), pattern compile (~0ms), network/document (0.14s),
main-thread render (~90ms), inline art (refuted §4), data volume (tiny dataset).

## 8. Fix levers (ranked; verify each against the metrics in §9)
1. **Drop / defer the per-option web search** (`poll-option-card` `raw:fetch` +
   homepage computeds) — #1 rerun source (2,350 runs). Don't run grounded web
   search on every load; persist results (already partly persisted via
   `homePageUrl`) and gate the fetch behind an explicit refresh.
2. **Flatten the vote-swatch render** (`main.tsx:1166`): precompute a
   `votesByOption` map once, instead of `votes.filter()` per option (kills the
   O(options×votes) 350-node site).
3. **Lighten / de-compose the per-option and per-participant cards** — composing
   a full sub-pattern per item is the fixed-graph driver.
4. **Investigate the ~6× re-settling** — over-triggered dependencies cause the
   graph to recompute ~6× on load; converging in 1–2 passes would cut the rerun
   product directly. (Use `commonfabric.detectNonIdempotent(ms)` during a load.)

## 9. Repeatable metrics (no edits needed — measure any fix with these)
- **Graph size / reruns:** `await commonfabric.rt.getGraphSnapshot()` →
  `nodes.length`, sum of `n.stats.runCount`.
- **VDOM re-emits:** `commonfabric.getLoggerCountsBreakdown()['vdom-applicator'].total`.
- **Wakeups / worker time:** DevTools trace (`agent-browser trace`).
- **Wall time:** time-to-interactive via `agent-browser` snapshot polling.
- **Reset between runs:** reload the page (fresh worker = fresh counts) — do
  **not** use "Recreate Root Pattern" (that destroys/recreates the space root).
- **Configurations:** `seed.sh --empty | --no-art | (full)`.

## 10. Open / next
- Verify lever #1 (remove web search) and #2 (votesByOption) against §9 metrics.
- Attribute the ~6× re-settling to specific over-triggering dependencies.
- The `getLineAndColumnAtOffset` ~84ms CPU-profile anomaly (source-position
  mapping on the load path) is unexplained — likely minor, but odd.
