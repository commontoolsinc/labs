# Deploying, updating & sharing lunch-poll state

How to deploy the lunch poll, update it in place without losing data, share it,
verify it actually worked, and recover it when it breaks. Written for someone
(human or agent) operating the poll for the first time — read top to bottom
once.

> **Status (2026-06-22): live-deployable.** The visit history + per-visit vote
> snapshots live in a plain **`PerSpace<HistoryEntry[]>` array** (`visits`),
> each entry embedding its own vote snapshot. (History was briefly on the SQLite
> builtin, #4144/#4145; that's been reverted — see `LUNCH-COORDINATOR-TODO.md`
> for the history. There is no longer any `sqliteDatabase`, `db.exec`, or
> `sqliteRev`.)

## Where the data lives (mental model)

A poll's durable state belongs to **one deployed piece instance in one space**,
addressed by `(space, causal-cell-id)` — not to "the pattern" in the abstract.
So "share the state" = "everyone points at the same piece"; "copy the state" =
"move that piece's values into a new piece." It all lives in **`PerSpace` input
cells**, shared by everyone in the space: `question`, `city`, `options`,
`votes`, `users`, `adminName`, `webSearchUrl`, and **`visits`** (the "Recently
eaten" log + embedded vote snapshots that feed "Lunch stats"). Plus
**`myName`**, which is **`PerUser`** (keyed by your DID).

All of these survive an in-place `setsrc` (Option A) and — because `visits` is
now an ordinary `PerSpace` cell — can all be copied to another piece via the CLI
(Option B).

## The canonical piece

One shared instance everyone iterates on. **This is a deployment pointer, not a
stable identifier — current as of 2026-06-22.** A piece is tied to one
space/server and can be reset, wedged, or lost; if it 404s, `inspect` fails, or
it stops responding, re-establish it (see "Recovering" below) and update this
block.

The poll lives on **`rapids`** (`rapids.saga-castor.ts.net`), the intended
successor to `toolshed`.

```
space:  team-lunch
piece:  fid1:2ZMvtKFGBMSem8sp6FskXKro5qLbAhbW6dBLUcX8vu0
url:    https://rapids.saga-castor.ts.net/team-lunch/fid1:2ZMvtKFGBMSem8sp6FskXKro5qLbAhbW6dBLUcX8vu0
```

### Historical: the `toolshed` piece

Before `rapids`, the canonical poll ran on `toolshed`
(`toolshed.saga-castor.ts.net`). Retained here for reference, and in case the
`rapids` migration is rolled back:

```
space:  team-lunch
piece:  fid1:zJT0lRy-Hd6p_ZsK_h6CZoK3rLcWOmsqwzqnHCAOlAg
url:    https://toolshed.saga-castor.ts.net/team-lunch/fid1:zJT0lRy-Hd6p_ZsK_h6CZoK3rLcWOmsqwzqnHCAOlAg
```

## Environment setup

```bash
export CF_API_URL=https://rapids.saga-castor.ts.net/   # current prod; toolshed.saga-castor.ts.net is the predecessor; http://localhost:8000 for local dev
export CF_IDENTITY=./your-identity.key
PIECE=fid1:2ZMvtKFGBMSem8sp6FskXKro5qLbAhbW6dBLUcX8vu0    # rapids; current as of 2026-06-22
SPACE=team-lunch
```

**Identity key:**

- **Local dev** — the local toolshed trusts the identity derived from the
  passphrase `"implicit trust"`. Mint a matching key (use `deno run`, **not**
  `deno task`, when redirecting — the task wrapper prints ANSI preamble that
  pollutes the file):
  ```bash
  deno run -A packages/cli/mod.ts id derive "implicit trust" > cf.key
  chmod 600 cf.key
  ```
- **Prod** — deploy with your own identity, or mint a fresh one
  (`deno run -A packages/cli/mod.ts id new > prod.key`) and share that key with
  whoever should be able to update the piece. Whoever deployed owns it; the
  **host** is a separate, in-poll role (first joiner — see Identity below).

## Option A — update the existing piece in place (recommended)

To push code changes **and keep all accumulated state**, update the source of
the existing piece. Do **not** run `cf piece new` — that mints a fresh, empty
instance.

```bash
deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  packages/patterns/lunch-poll/main.tsx
deno task cf piece step --piece "$PIECE" -s "$SPACE"
```

**What survives `setsrc` (verified):** all the `PerSpace` cells
(`users`/`votes`/`options`/`visits`/…). Cell ids derive from the causal
generation chain (not contents, scope excluded), so `setsrc` keeps the same
result cell and its populated inputs. **Adding a new `PerSpace` field is safe**
— on an existing piece it hydrates to its `Default<>` while populated fields
keep their data.

**Caveat:** this holds only while each input's identity in the recipe stays
stable. Adding fields is safe; heavily **reordering or renaming** pattern inputs
can shift the causal chain and orphan old data. Don't refactor the input
interface casually against a piece you care about.

## Option B — copy the state into your own piece

To get your **own** instance seeded with the current data (e.g. to experiment
without touching the shared poll):

```bash
# 1. Create your own empty piece (note the new ID it prints).
MINE=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

# 2. Copy each PerSpace field from the canonical piece into yours.
#    `--input` reads/writes the input cell where these live.
for field in question city users options votes adminName webSearchUrl visits; do
  deno task cf piece get --piece "$PIECE" -s "$SPACE" "$field" --input -q \
    | deno task cf piece set --piece "$MINE" -s "$SPACE" "$field" --input -q
done

# 3. Recompute so derived values (counts, ranking) refresh.
deno task cf piece step --piece "$MINE" -s "$SPACE"
deno task cf piece inspect --piece "$MINE" -s "$SPACE" --summary
```

This is a **one-time snapshot copy**, not a live link — the pieces diverge
after. Because the copy loop includes `visits`, the "Recently eaten" log and
"Lunch stats" come across too. (This is a change from the SQLite era, when the
history lived in a per-piece, cell-derived db the CLI couldn't copy or repoint;
the fabric-array model restores CLI portability — history copies like any other
`PerSpace` cell.)

## Verifying a deploy actually worked

History is now a plain `PerSpace` cell with computeds over it, so it reads back
over the CLI like the rest of the poll's state — no subscription/`{ pending }`
gotcha and no SQLite files to inspect.

- **Read the `visits` input directly** to confirm a write landed (no browser
  needed):
  ```bash
  deno task cf piece get --piece "$PIECE" -s "$SPACE" visits --input -q
  ```
  The derived outputs (`recentVisits`, `placeStats`, `historyCount`,
  `mostRecentTitle`, `voteHistoryCount`) recompute on `step` and read back the
  same way.

**Smoke test after deploy** (host-gated handlers need a join first):

```bash
deno task cf piece call --piece "$PIECE" -s "$SPACE" joinAs '{"name":"Host"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
deno task cf piece call --piece "$PIECE" -s "$SPACE" addOption '{"title":"Test Cafe"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
deno task cf piece call --piece "$PIECE" -s "$SPACE" logVisit '{"title":"Test Cafe"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
# Confirm the entry landed (no browser needed):
deno task cf piece get --piece "$PIECE" -s "$SPACE" visits --input -q
```

## Identity & joining

`myName` is `PerUser` (keyed by your authenticated DID); `adminName` (host) and
the `users` directory are `PerSpace`. Consequences that bite:

1. **This build joins by free-text name.** Type a name in the join field and
   click Join — no profile needed; the **first person to join becomes host**.
   (On `main`, joining instead goes through the shared-profile `wish` flow,
   which requires a profile in your home space. This `freetext-join` variant
   removes that gate. The `joinAs` handler still honors an explicit `name`, so
   CLI/headless joins work either way.)

2. **CLI and browser are different identities unless you make them the same.**
   If you join/seed from the `cf` CLI (one DID) then open the piece in a browser
   (a different DID), the browser's `myName` is empty and it won't treat you as
   host. To act as the same person in both, import your CLI key in the browser
   via **Import CLI Key**; see
   [`docs/development/SHARED_IDENTITY.md`](../../../docs/development/SHARED_IDENTITY.md).
   Verify with `cf id did "$CF_IDENTITY"`.

3. **Names are unique.** `joinAs` rejects a name already in `users`. If a
   test/seed claimed your name, pick another or clear the stale entry.

4. **Host role is claimable.** Any joined participant can take the host seat
   with **Become host** (`claimHost`). A squatted/stale host seat doesn't need
   an operator reset — just join and click Become host. (You can also reset
   `adminName` to `""` directly when no one is joined.)

## Resetting / re-seeding state (host or operator)

**Coordinate before running this against the shared piece — it mutates state
everyone sees, and direct `set` races anyone's live browser session.**

- **Votes:** use the in-app `resetVotes` (host) — or call it via CLI.
- **History:** use the **`clearHistory` handler** (host-gated) — it empties the
  `visits` log (and its embedded vote snapshots):
  ```bash
  deno task cf piece call --piece "$PIECE" -s "$SPACE" clearHistory '{}'
  deno task cf piece step --piece "$PIECE" -s "$SPACE"
  ```
  Or, since `visits` is an ordinary `PerSpace` cell, write it directly (below).
- **PerSpace cells:** write the input cells directly:
  ```bash
  echo '[]' | deno task cf piece set --piece "$PIECE" -s "$SPACE" users     --input -q
  echo '""' | deno task cf piece set --piece "$PIECE" -s "$SPACE" adminName --input -q
  echo '[]' | deno task cf piece set --piece "$PIECE" -s "$SPACE" options   --input -q
  echo '[]' | deno task cf piece set --piece "$PIECE" -s "$SPACE" votes     --input -q
  echo '[]' | deno task cf piece set --piece "$PIECE" -s "$SPACE" visits    --input -q
  deno task cf piece step --piece "$PIECE" -s "$SPACE"
  ```
  After this, the first person to join in the browser becomes host as their own
  browser identity.

## Recovering the piece

### Re-establishing (if it's lost / 404s)

```bash
deno task cf piece new packages/patterns/lunch-poll/main.tsx -s "$SPACE"
# → prints a new fid1:… — update the "canonical piece" block above.
```

You need `WRITE`/`OWNER` on the space (ACL-gated); a denied write changes
nothing.

### Recovering a wedged piece

A piece can get into a bad **process** state — UI renders but **clicks do
nothing**, no console errors (a settle loop flickers / logs warnings). Observed
once when a "reset votes" click wedged the running instance. `setsrc` does
**not** fix this (it reuses the same process cell); the cure is a fresh process:

```bash
# 1. Confirm it's instance-specific: deploy the same code to a NEW piece. If the
#    fresh piece works, the old one's process is wedged.
NEW=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

# 2. Copy the PerSpace state across with the Option B loop (history carries too,
#    since `visits` is now a PerSpace cell). Tip: leave users/adminName empty so
#    the first joiner becomes host, or copy them and use Become host.

# 3. Make the fresh piece canonical: update the "canonical piece" block above.
```

### Home space won't load (profile setup, `main`-style builds)

Unrelated to the poll itself, but bites colleagues setting up a profile: if a
home space fails to load with
`Handler used as lift, because $stream: true was
overwritten`, the space's
**stored** root pattern is a stale compiled artifact. Fix: open the header menu
→ **Toggle debug mode** (🐛) → click the red **Recreate Root Pattern** button in
the debugger drawer, then reload. (Console fallback:
`localStorage.setItem("showDebuggerView","true")` then reload.) The
free-text-join build of this poll sidesteps the profile requirement entirely.

## Performance notes

Cold loads of a poll with many options can take **minutes** — this is **not**
graph/runtime cost (instantiation measures ~linear, ~12ms/option), it's the
**per-option AI work done host-side on load**: each option triggers an image
generation, a web search, and a `generateText` homepage-verification call,
serialized behind a 30s mutex. Results are cached (`option.imageUrl` etc.), so
warm loads are cheaper; the pain is the first host load of un-cached options.
See willkelly's perf investigation in
[labs#4141](https://github.com/commontoolsinc/labs/pull/4141) (keyed-collection
/ runtime-aggregate direction) for the deeper aggregate + write-conflict
findings.
