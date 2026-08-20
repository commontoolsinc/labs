# Deploying, updating & sharing lunch-poll state

How to deploy the lunch poll, update it in place without losing data, share it,
verify it actually worked, and recover it when it breaks. Written for someone
(human or agent) operating the poll for the first time — read top to bottom
once.

> **Status (2026-08-20): live-deployable.** Every command below was run against
> `rapids`: a fresh `cf piece new`, a `setsrc` over a populated piece, the smoke
> test, the state copy, and the reset handlers. The visit history and its
> per-visit vote snapshots live in a plain **`PerSpace<HistoryEntry[]>` array**
> (`visits`), each entry embedding its own vote snapshot.

## Where the data lives (mental model)

A poll's durable state belongs to **one deployed piece instance in one space**,
addressed by `(space, causal-cell-id)` — not to "the pattern" in the abstract.
So "share the state" = "everyone points at the same piece"; "copy the state" =
"move that piece's values into a new piece." It all lives in **`PerSpace` input
cells**, shared by everyone in the space: `question`, `options`, `votes`,
`users`, `participantProfiles` (the object-wrapped directory of live canonical
profile links for profile-backed joiners), `adminName`, and **`visits`** (the
"Recently eaten" log + embedded vote snapshots that feed "Lunch stats"). Plus
**`myName`**, which is **`PerUser`** (keyed by your DID).

All of these survive an in-place `setsrc` (Option A). All but `visits` copy to
another piece with a plain read-and-write; `visits` needs one edit on the way
across, because each entry holds a live link into the source piece's roster
(Option B).

## The live pieces

**These are deployment pointers, not stable identifiers.** A piece is tied to
one space on one server, and it can be reset, wedged, or lost. When one stops
answering, re-establish it (see "Recovering the piece") and update this block.

### `estuary` — the stately instance, holding the real poll

`estuary.saga-castor.ts.net` carries the team's **populated** poll — real
participants, options and votes. Treat its state as production data.

```
space:  team-lunch
piece:  fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4
url:    https://estuary.saga-castor.ts.net/team-lunch/fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4
```

This host deploys by manual dispatch, so its build trails `main`; see
[`docs/development/deploying.md`](../../../docs/development/deploying.md). The
host's build and the piece's source move independently — a host upgrade leaves
the piece on whatever source it was deployed with. `/api/meta` gives the commit
the host runs, and `cf piece inspect` gives the source ref the piece is on:

```bash
curl -s https://estuary.saga-castor.ts.net/api/meta
```

**Its space holds real data, so an update here is rehearsal-grade.** Rehearse
against a clone before any `setsrc` the compatibility checker rejects — see
[`docs/development/space-clone-rehearsal.md`](../../../docs/development/space-clone-rehearsal.md).
Estuary serves production, so its whole-space dump endpoint is off and the
snapshot has to be taken on the host itself. The space DID is
`did:key:z6MkhAKxuP8cXuDNjyUJ2xgmjjgENQGm7zzo5Tg3V7vyYnzr`, and reaching the
host needs a key in the infra repository's `ssh_authorized_keys`.

```bash
sqlite3 <store>/engine-v3/engine-v3/<did>.sqlite "VACUUM INTO '<destination>'"
```

### `rapids` — the fast-moving instance

`rapids.saga-castor.ts.net` redeploys on every push to `main`, so it runs close
to tip and can move under you mid-session. Iterate here, in **a space of your
own**: a scratch space costs nothing and leaves the shared ones alone.

The `team-lunch` space on this host is unusable as it stands. Its stored root
pattern does not compile against the current API, so every command that loads
the space's piece registry fails there — `cf piece ls` and `cf piece inspect`
with `Could not load pattern <identity>#default`, and `cf piece new` with:

```
Could not initialize the space's default pattern: ...
The new piece cannot be registered in the space's piece list without it.
If this space's root pattern predates a runtime format change, repair it with: cf piece recreate-root
```

Commands that address a piece by id and never read the registry still work
there: `cf get` and `cf piece getsrc` both do. The poll piece that used to serve
this space does not start either — a nested `participant-identity-card` argument
is missing a required field, so setup refuses it (see "A piece that saved its
source and will not start"). Re-establishing a poll on this host means repairing
the space root first, with `cf piece recreate-root`, and then `cf piece new`.
`recreate-root` rewrites the space's root pattern for everyone in it, so agree
on it before running it against a shared space.

## Environment setup

```bash
export CF_API_URL=https://estuary.saga-castor.ts.net/   # the populated poll; rapids.saga-castor.ts.net to iterate; http://localhost:8000 for local dev
export CF_IDENTITY=./your-identity.key
PIECE=fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4   # estuary
SPACE=team-lunch

# Keep this complete set on every source deployment in this guide.
LUNCH_POLL_TEST_ARGS=(
  --test packages/patterns/lunch-poll/art-sync.test.tsx
  --test packages/patterns/lunch-poll/generated-art.test.tsx
  --test packages/patterns/lunch-poll/lunch-stats.test.tsx
  --test packages/patterns/lunch-poll/main.test.tsx
  --test packages/patterns/lunch-poll/multi-user.test.tsx
  --test packages/patterns/lunch-poll/participant-identity-card.test.tsx
  --test packages/patterns/lunch-poll/poll-option-card.test.tsx
)
```

`CF_API_URL` is the one variable to re-read before every command that writes.
The exported value is what stands between a smoke test and the same commands
landing on the team's real poll, and nothing in the command line itself says
which host it reached. Pass `-a`/`--api-url` per command when you are moving
between hosts in one session.

Before any `piece new` or `piece setsrc` command below, run every authored
pattern test and stop if one fails:

```bash
deno task cf test packages/patterns/lunch-poll/art-sync.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/generated-art.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/lunch-stats.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/main.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/multi-user.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/participant-identity-card.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/poll-option-card.test.tsx --root packages/patterns
```

The quoted `"${LUNCH_POLL_TEST_ARGS[@]}"` expansion below repeats every `--test`
entry. Deployment packages and type-checks the tests but does not run them,
which is why both the test commands and the flags are required.

**Identity key:**

- **Local dev** — mint your own unique key (use `deno run`, **not** `deno task`,
  when redirecting — the task wrapper prints ANSI preamble that pollutes the
  file):
  ```bash
  mkdir -p .cf
  deno run -A packages/cli/mod.ts id new > .cf/shared-dev.key
  chmod 600 .cf/shared-dev.key
  export CF_IDENTITY="$PWD/.cf/shared-dev.key"   # replaces the ./your-identity.key placeholder above
  ```
  The local toolshed accepts any identity; import the same key in the browser
  (`Import CLI Key` on the login screen) when the CLI and browser should act as
  one user. Do NOT derive the shared `"implicit trust"` passphrase for deploys —
  that fixed, publicly-derivable DID is reserved for acting as the local
  server's own operator identity, and it collapses you into the server
  principal. See `docs/features/shared-identity.md`.
- **Prod** — deploy with your own identity, or mint a fresh one
  (`deno run -A packages/cli/mod.ts id new > prod.key`) and share that key with
  whoever should be able to update the piece. Whoever deployed owns it; the
  **host** is a separate, in-poll role (first joiner — see Identity below).

**Command spellings:** the data commands are `cf get`, `cf set` and `cf call`.
The `cf piece get` / `cf piece set` / `cf piece call` spellings still run, print
a deprecation notice on stderr, and stop working on 2026-08-31. The
piece-lifecycle commands keep the `cf piece` prefix: `new`, `setsrc`, `getsrc`,
`step`, `inspect`, `render`, `ls`, `rm`, `verbs`, `recreate-root`.

## Option A — update the existing piece in place (recommended)

To push code changes **and keep all accumulated state**, update the source of
the existing piece. Do **not** run `cf piece new` — that mints a fresh, empty
instance.

```bash
deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  packages/patterns/lunch-poll/main.tsx
deno task cf piece step --piece "$PIECE" -s "$SPACE"
```

**What survives (verified):** all the `PerSpace` cells
(`users`/`votes`/`options`/`visits`/…). Cell ids derive from the causal
generation chain (not contents, scope excluded), so `setsrc` keeps the same
result cell and its populated inputs. **Adding a new `PerSpace` field is safe**
— on an existing piece it hydrates to its `Default<>` while populated fields
keep their data.

**Removing one is refused.** The compatibility check reads the deployed schema
and rejects a source that drops a field, without touching the piece:

```
Pattern schemas are not backward compatible:
- argument.motto: existing argument field was removed
- result.motto: existing result field was removed
```

`--dangerously-allow-incompatible-schema` replaces the source anyway. Adding
fields is safe, but heavily **reordering or renaming** pattern inputs can shift
the causal chain and orphan old data. Don't refactor the input interface
casually against a piece you care about.

> **Precondition:** `setsrc` loads the piece's _currently deployed_ source
> before it compares schemas, so a piece whose deployed generation no longer
> compiles against today's API cannot be updated in place at all. It fails while
> loading that source, with whatever the stale source imports, e.g.
> `Module '"./commonfabric.js"' has no exported member '<name>'`.
> `--dangerously-allow-incompatible-schema` does **not** help: it only skips the
> compatibility proof, which runs _after_ the load. Recover with `cf piece new`
> (see "Recovering the piece").

> **`setsrc` can half-succeed.** Saving the source and refreshing the running
> piece are separate steps, and the second can fail on its own:
>
> ```
> Piece source was saved, but refreshing the running piece failed: [Error: updated arguments do not match the candidate schema: profileAvatar: value does not match type string]
> ```
>
> The piece is now on the new source and will not start. That line comes
> _before_ the usual `Updated source for piece …` line and the next-step hints,
> so a caller reading only the tail of the output takes it for a clean deploy.
> See "A piece that saved its source and will not start".

## Option B — copy the state into your own piece

To get your **own** instance seeded with the current data (e.g. to experiment
without touching the shared poll):

```bash
# 1. Create your own empty piece (note the new ID it prints).
MINE=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

# 2. Resolve your piece's argument document. This is the cell the copy writes
#    into; `cf set --input` cannot do it (see the note below).
ARG=$(deno task cf get --piece "$MINE" -s "$SPACE" --input --select '@' -q \
  | grep -oE '/of:fid1:[A-Za-z0-9_-]+')

# 3. Copy each PerSpace field except the visit log.
for field in question users options votes participantProfiles adminName; do
  deno task cf get --piece "$PIECE" -s "$SPACE" "$field" --input -q \
    | deno task cf set -s "$SPACE" "$ARG/$field" -q
done

# 4. Copy the visit log, dropping its roster links (see below).
deno task cf get --piece "$PIECE" -s "$SPACE" visits --input -q \
  | deno eval '
      const v = JSON.parse(await new Response(Deno.stdin.readable).text());
      for (const e of v) {
        e.loggedBy = null;
        for (const s of e.votes) s.voterLink = null;
      }
      console.log(JSON.stringify(v));
    ' \
  | deno task cf set -s "$SPACE" "$ARG/visits" -q

# 5. Recompute so derived values (counts, ranking) refresh.
deno task cf piece step --piece "$MINE" -s "$SPACE"
deno task cf piece inspect --piece "$MINE" -s "$SPACE" --summary
```

> **Why the copy writes to `$ARG` and not `cf set --input`.** A `cf set --input`
> write validates the piece's whole input object, and this pattern's `myName`
> slot holds a link to a per-user cell rather than a string. Every field fails
> the same way, on `myName` rather than on the field being written:
>
> ```
> updated input does not match its schema: myName: value does not match type string
> ```
>
> This bites any lunch-poll piece, including one created seconds ago, and a
> nested path (`users/0/name`) fails alongside a top-level one. Two writes are
> exempt: `cf set --input myName`, because the write path replaces exactly that
> slot with the string it is given, and a write addressed to the argument
> document itself, which is what step 2 resolves and what the loop above uses.

> **Why `visits` needs the edit.** Each entry's `loggedBy`, and each embedded
> vote's `voterLink`, is a live `Cell<User>` link into the **source** piece's
> roster, and the destination cannot prove a contract for a link it did not
> mint:
>
> ```
> input link at visits.0.loggedBy schema is not compatible: source has no durable schema contract
> ```
>
> Both fields are nullable and the names travel separately, in `loggedByName`
> and `voter`, so nulling the links costs the "who logged this" navigation and
> nothing else — the "Recently eaten" log and the "Lunch stats" tallies come
> across intact.

This is a **one-time snapshot copy**, not a live link — the pieces diverge
after.

## Verifying a deploy actually worked

A piece has two faces, and they answer differently:

- **The input cell (`--input`) is always current.** It is the durable argument,
  and a handler's write lands there immediately.
- **The result cell can lag.** Some outputs hold a value cached at the last
  recompute — `adminName`, `myName`, `mostRecentTitle`, `recentVisits` and
  `placeStats` all do. Others track the argument live, among them `question`,
  `options`, `users`, `votes` and the counts (`userCount`, `optionCount`,
  `voteCount`, `historyCount`). Nothing in the output's name or type says which
  kind it is, and one handler call can move both at once: after a `logVisit`
  with no recompute, `historyCount` reads 3 while `recentVisits` still lists 2.

So don't sort outputs into the two groups. Read `--input` when you want the
stored value, and pass `--step` when you want a result:

```bash
# The stored visit log — what a write actually landed.
deno task cf get --piece "$PIECE" -s "$SPACE" visits --input -q

# A derived output, recomputed in the same CLI session before it is read.
deno task cf get --piece "$PIECE" -s "$SPACE" recentVisits --step -q
```

`--step` starts and recomputes the piece before reading, so it also writes; a
plain `cf piece step` before the read does the same job. Reserve both for a
piece you are allowed to move.

**Smoke test after deploy** (host-gated handlers need a join first):

```bash
deno task cf call --piece "$PIECE" -s "$SPACE" joinAs '{"name":"Host"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
deno task cf call --piece "$PIECE" -s "$SPACE" addOption '{"title":"Test Cafe"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
deno task cf call --piece "$PIECE" -s "$SPACE" logVisit '{"title":"Test Cafe"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
# Confirm the entry landed (no browser needed):
deno task cf get --piece "$PIECE" -s "$SPACE" visits --input -q
```

Put the inline JSON argument last: a flag after it makes `cf call` report
`Use a single inline JSON argument or "--" before schema-derived flags.`

`cf piece render` renders the same tree a browser would show, so it is the
cheapest whole-UI check — and, because it starts the piece, the cheapest way to
find out that a piece will not start at all.

## Identity & joining

`myName` is `PerUser` (keyed by your authenticated DID); `adminName` (host) and
the `users` directory are `PerSpace`. Consequences that bite:

1. **Joining is profile-first, with a free-text fallback.** When your shared
   profile resolves (`#profileName`), the card offers a one-click **Join as
   \<name\>** — carrying your profile name and avatar — plus a **Use a different
   name** escape hatch. When no profile resolves, it falls back to a **Your
   name…** field: type a name and click **Join**. Either way the **first person
   to join becomes host**. The `joinAs` handler honors an explicit `name`, so
   CLI/headless joins work regardless of the UI path.

2. **CLI and browser are different identities unless you make them the same.**
   If you join/seed from the `cf` CLI (one DID) then open the piece in a browser
   (a different DID), the browser's `myName` is empty and it won't treat you as
   host. To act as the same person in both, import your CLI key in the browser
   via **Import CLI Key**; see
   [`docs/features/shared-identity.md`](../../../docs/features/shared-identity.md).
   Verify with `cf id did "$CF_IDENTITY"`.

3. **Names are unique, and `joinAs` refuses quietly.** A name already in `users`
   is rejected; so is a second `joinAs` from a viewer who already has a name.
   Both refusals return from the handler without writing, and the invocation
   still reports `settled` — read back `myName --input` to find out whether the
   join took. If a test or seed claimed your name, pick another, or clear the
   stale roster entry (see "Resetting / re-seeding state").

4. **Host role is claimable.** Any joined participant can take the host seat
   with **Become host** (`claimHost`). A squatted/stale host seat doesn't need
   an operator reset — just join and click Become host. (You can also clear
   `adminName` directly when no one is joined — see "Resetting / re-seeding
   state" for the write that works.)

## Resetting / re-seeding state (host or operator)

**Coordinate before running this against the shared piece — it mutates state
everyone sees, and a direct write races anyone's live browser session.**

Prefer the handlers. They are host-gated, they keep the derived values honest,
and they are the only path the browser also takes:

- **Votes:** use the in-app `resetVotes` (host) — or call it via CLI.
- **History:** use the **`clearHistory` handler** (host-gated) — it empties the
  `visits` log and its embedded vote snapshots:
  ```bash
  deno task cf call --piece "$PIECE" -s "$SPACE" clearHistory '{}'
  deno task cf piece step --piece "$PIECE" -s "$SPACE"
  ```

No handler clears the roster or the host seat, so those two need a direct write,
addressed to the piece's argument document. `cf set --input` cannot serve here
for the reason Option B gives: it validates the whole input object and fails on
`myName`.

```bash
ARG=$(deno task cf get --piece "$PIECE" -s "$SPACE" --input --select '@' -q \
  | grep -oE '/of:fid1:[A-Za-z0-9_-]+')
echo '[]' | deno task cf set -s "$SPACE" "$ARG/users"     -q
echo '""' | deno task cf set -s "$SPACE" "$ARG/adminName" -q
echo '[]' | deno task cf set -s "$SPACE" "$ARG/options"   -q
echo '[]' | deno task cf set -s "$SPACE" "$ARG/votes"     -q
echo '[]' | deno task cf set -s "$SPACE" "$ARG/visits"    -q
deno task cf piece step --piece "$PIECE" -s "$SPACE"
```

That write goes in without the piece's own schema check, so it will store
whatever you hand it. Send values that match the field's declared shape. After
this, the first person to join in the browser becomes host as their own browser
identity.

## Recovering the piece

### Re-establishing (if it's lost / 404s)

```bash
deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  --root packages/patterns "${LUNCH_POLL_TEST_ARGS[@]}" -s "$SPACE"
# → prints a new fid1:… — update the "live pieces" block above.
```

You need `WRITE`/`OWNER` on the space (ACL-gated); a denied write changes
nothing. The command also needs the space's root pattern to load, because it
registers the new piece in the space's piece list — see the `rapids` note above
for what it says when that fails.

### A piece that saved its source and will not start

The piece answers `cf get`, but anything that starts it — `cf piece render`,
`cf piece step`, `cf get --step` — refuses with a stored-argument complaint
naming a field of a nested pattern:

```
updated arguments do not match the candidate schema: myName: value does not match type string
```

The named field belongs to a sub-pattern instance (`participant-identity-card`
supplies both `myName` and the profile fields), whose stored argument document
is missing that required key. There is no in-place repair: another `setsrc`
saves the source and fails the refresh the same way, and a direct write to the
sub-pattern's argument document is refused with
`updated result write destination has no durable schema contract`. Move to a
fresh piece, as below.

### Recovering a wedged piece

A piece can also get into a bad **process** state — UI renders but **clicks do
nothing**, no console errors (a settle loop flickers / logs warnings). Observed
once when a "reset votes" click wedged the running instance. `setsrc` does
**not** fix this either (it reuses the same process cell); the cure is a fresh
process:

```bash
# 1. Confirm it's instance-specific: deploy the same code to a NEW piece. If the
#    fresh piece works, the old one's process is wedged.
NEW=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

# 2. Copy the PerSpace state across with the Option B loop (the visit log
#    carries too, once its roster links are nulled). Tip: leave users/adminName
#    empty so the first joiner becomes host, or copy them and use Become host.

# 3. Make the fresh piece the shared one: update the "live pieces" block above.
```

### Home space won't load (profile setup, `main`-style builds)

Unrelated to the poll itself, but bites colleagues setting up a profile: if a
home space fails to load with
`Handler used as lift, because $stream: true was overwritten`, the space's
**stored** root pattern is a stale compiled artifact. Fix: open the header menu
→ **Toggle debug mode** (🐛) → click the red **Recreate Root Pattern** button in
the debugger drawer, then reload. (Console fallback:
`localStorage.setItem("showDebuggerView","true")` then reload.) The poll's
free-text join fallback lets you in even when your profile / home space won't
load — you just don't get your profile name and avatar pre-filled.

## Performance notes

Cold-load cost is dominated by graph/runtime instantiation, which measures
~linear at ~12ms/option. `main.tsx` makes no network calls of its own: no
web-search, no homepage verification, no model call.

Per-option cuisine art is generated in the browser, and only on the **host's**
client: `generated-art.tsx` requests `/api/ai/img` via `fetchBinary` under a 30s
mutex, and skips the request entirely for any option that already carries a
stored image. The host keeps a thumbnail with the card's keep action, which
fires `setOptionImage` to persist the data URL onto that option's `imageUrl`;
every other viewer reads the stored value rather than generating its own. Art
therefore costs at most one request per option across the whole poll, not one
per option per viewer.

For the deeper aggregate + write-conflict findings that still apply to a poll
with many options and voters, see willkelly's perf investigation in
[labs#4141](https://github.com/commontoolsinc/labs/pull/4141) (keyed-collection
/ runtime-aggregate direction).
