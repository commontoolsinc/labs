---
name: state-inspector
description: Debug Common Fabric runtime/multiplayer state from the durable store, offline, with `cf inspect`. Use when investigating "what is actually stored", a cell that looks different for two users, a lost/overwritten write, divergence across spaces, how state reached its current value, who/what touched a space, or any memory-v2 question you'd otherwise guess at from a live runtime. Reads space SQLite DBs read-only — no live server, no capture step.
---

# State Inspector — debugging Fabric state from the durable store

The thesis you can't derive: **the durable store the server already wrote is the
flight recorder.** Every commit, every per-scope revision, every read a commit
observed is on disk. `cf inspect` opens a space SQLite file read-only and
answers who/what/when/why-different questions with no live runtime. Reach for it
whenever you'd otherwise reason about runtime state from the outside — it
replaces a guess with the ground truth the engine itself reads.

Full command reference + flags: `packages/state-inspector/README.md`. This skill
is the **map** — what the tool sees, what to trust, and which question each
command answers. Run commands with `deno task cf inspect <cmd>`; every command
takes `--json` for machine reading, and a `<space>` is a DID, a unique
DID-prefix, or a path (local DBs auto-discovered — start with
`cf inspect spaces`).

## What it can — and can't — answer

It reads ONE durable store, offline and read-only. That single boundary tells
you when to trust it and when to reach for something else:

**It answers authoritatively** (the same bytes the engine reads): what is
_stored_ for any entity at any `(branch, seq)`; who/what/when wrote it (per
commit, wall-clock to the second); how a value got there
(`history`/`diff`/`timeline`); whether identities _see different values_
(`overlay`); whether the store is _internally consistent_ (anomalous stale
reads); whether the same id agrees across spaces (`converge`); and the structure
of it all (`entities`/`piece`/`graph`).

**It can't — and reaching for it here will mislead you:**

- _Anything client-side_ — optimistic writes, cursor lag, what a browser is
  actually rendering. "Converged" / "consistent" describes the durable store,
  not what any client is showing.
- _A live or production bug from a local snapshot_ — a clean local store does
  not explain a prod-only misbehaviour; at most it says the local data is
  healthy, so the cause is concurrency / scale / timing or client-side. To
  inspect prod you need that space's actual `.sqlite` (no remote mode — copy the
  file off the box).
- _How long anything took_ — it has logical order (`seq`) plus
  second-granularity commit times ("what happened and when"), never latencies or
  durations.
- _What was rejected_ — the engine rejects stale reads _before_ they persist, so
  they are not here. Zero anomalies means consistent, not "no concurrency."
- _The live reactive graph_ — scheduler dependency tables are usually absent on
  disk; entity/commit history always works, the reactive graph is opt-in.
- _Change anything_ — it is read-only; it explains, it never reproduces or
  fixes.

So **reach for it whenever you would otherwise guess at durable or multiplayer
state from outside a live runtime**; reach for something else for live
behaviour, client rendering, performance profiling, or reproducing a bug.

## The mental model the output assumes

You will misread the tool without these — they are facts about how memory-v2
stores state, not things a model infers from the data:

- **An entity is a tree of top-level paths**, not a bare value: `value` plus
  meta paths `argument` / `result` / `patternIdentity` / `internal` / `schema` /
  `cfc`. The tool classifies an entity (piece / module / stream / schema /
  owned-cell / free-cell) by _which paths exist_, and resolves lineage from them
  — so "what is this entity" is answerable structurally, and `entities` /
  `piece` / `graph` speak that vocabulary.
- **`scope_key` partitions an entity by identity.** The _same_ cell id can hold
  a shared `space` value AND a per-`user:<DID>` override AND a
  per-`session:<DID>:<sid>` override, stored side by side and genuinely
  different. This is where "looks different for me" multiplayer bugs live. The
  runtime resolves what one identity sees by following a link planted at the
  base scope at _write_ time — **not** by a read-time session→user→space
  fallback (see the honesty contract).
- **Multi-USER ≠ multi-SESSION.** A cell written by two _sessions_ of one person
  (many tabs/devices) is benign; two distinct _principals_ is real cross-user
  contention. The tool draws this line for you — trust the `multiUser` flag, not
  the raw session count.
- **Two at-rest value formats coexist, both handled:** modern `fvj1:`-prefixed
  codec-json (ids `of:fid1:…`) and legacy plain-JSON sigils (ids `of:baedrei…`).
  You don't route between them; just know an id's shape tells you the era.
- **Reconstruction is engine-faithful, and proven so.** State-at-`(branch, seq)`
  replays through the server's own `applyPatch`, honors branch inheritance and
  snapshots exactly like `read()`, and is locked to the real engine by a parity
  test that drives it. So a reconstructed value _is_ what the runtime would read
  — you can build on it without hedging.

## The honesty contract — what is ground truth vs. a hint

The tool is deliberate about this, and so must you be when you report findings.
Confusing an approximation for truth is the failure mode that matters here:

- **`overlay <space> <id>` is the ground truth** for "who sees what." It shows
  the entity's value in _every_ scope side by side and flags real divergence
  (compared on the raw stored value, depth-complete). For "this cell looks
  different for two users," this is the answer.
- **`value-at --as <DID>` is an APPROXIMATION** — the most-specific stored scope
  that holds the id. It cannot, from an id alone, know which declared scope a
  real read targets or follow the base-scope link. Useful as a quick "roughly
  what they see"; never quote it as the runtime read. Prefer `overlay`.
- **`conflicts` stale-reads are an ANOMALY detector, not lost-update history.**
  The engine validates every confirmed read _before_ committing, so a healthy
  store yields **zero**. A hit means an invariant violation / corruption —
  surface it loudly as such, and read "0 anomalies" as "the store is
  consistent," not "no concurrency happened." (The separate writer-timeline /
  `multiUser` contention view _is_ normal history.)
- **`converge` / `converge-scan` are server-view only** — durable values
  compared. "Converged" means the stored values agree, not that every client is
  rendering them; client cursor lag and optimistic writes aren't visible here.
- **Same id across spaces is usually NOT replica drift.** Content-addressed ids
  mean two spaces often hold independent _instances of the same pattern_, which
  legitimately differ. The scan labels `cross-space-linked` (real replica →
  drift bug) vs `no-cross-space-link` (likely independent instance). Don't cry
  wolf on the latter.

## Which question → which command

Start from the symptom; let the model below generate the path rather than a
fixed recipe. The recurring debugging questions and where they resolve:

- _"What's actually in this space / what is this entity?"_ → `spaces` →
  `summary` / `entities` / `piece`; `graph` for how pieces, cells, modules and
  streams connect (`--root <id> --depth` to drill, `--dot` for Graphviz).
- _"This cell looks different for user A vs B."_ → `overlay <space> <id>`
  (truth); `scopes` / `users` to see who has per-user/session state;
  `identity <DID>` for one identity's whole world (its spaces + the scopes it
  owns).
- _"A write seems lost / overwritten / a read was stale."_ → `conflicts <space>`
  to find contested cells, then `conflicts <space> <id>` for the writer
  timeline + the anomaly analysis. Remember: a _clean_ result means consistent,
  and a hit is an anomaly worth escalating.
- _"How did this entity reach its current value?"_ → `history` (every write,
  who), `timeline <space> <id>` (value after each write),
  `diff <space> <id> --from --to` (what changed between two seqs),
  `value-at … --seq` (state at a point).
- _"Is this entity the same across spaces / did a replica drift?"_ →
  `converge <id>
  --all` / `converge-scan --all`, trusting the
  replica-vs-instance label.
- _"I want to explore everything for a space interactively."_ →
  `html <space> --out
  file.html` (self-contained: tree + graph + detail pane
  with value, schema, CFC labels, lineage, links, source; `--app-url` adds live
  deep-links).

## Gotchas that will mislead you if unflagged

- **Scheduler tables are usually absent** on disk (only present when
  `persistentSchedulerState` was on). The entity-history surface always works;
  the reactive dependency graph is opt-in — absence is normal, not a broken DB.
- **Lists and the bundle are capped** (e.g. history/hot/graph/contention have
  limits; the HTML stale-read pass caps per bundle and _marks_ un-analyzed cells
  rather than showing them clean). When a count equals a round cap, suspect
  truncation and narrow with flags or a per-entity command.
- **`--json` is the agent path.** Human output elides; for anything you parse or
  chain, pass `--json`.
- **It reads DBs it didn't write.** A corrupt/partial row degrades that one
  entity, not the whole command — but if a value looks absent where you expect
  data, check for a decode error before concluding the entity is empty.
