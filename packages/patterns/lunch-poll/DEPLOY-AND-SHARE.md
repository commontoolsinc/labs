# Lunch poll deployment and recovery

This is the operator runbook for deploying the lunch poll without losing its
shared state. The safe default is: update the existing piece through its stable
slug, verify that its durable inputs did not change, and do mutation testing on
a disposable canary.

> **Status (2026-07-14): live-deployable.** Visit history and vote snapshots
> are stored in the ordinary `PerSpace` input `visits`. There is no SQLite
> database or separate process state to migrate.

## Production address and state contract

The public address is the stable slug, not the current causal piece id:

```text
host:      https://rapids.saga-castor.ts.net
space:     team-lunch
slug:      lunch-poll
public:    https://rapids.saga-castor.ts.net/team-lunch/lunch-poll
piece id:  fid1:uC_TJ5p2vRMf9sDtci7pPKG7GThHYY7GFPbRJVSE71g
```

The piece id is recorded only for recovery. Normal deploys and links should use
`lunch-poll`; if a migration ever creates a replacement piece, repoint the slug
only after the replacement has passed verification.

Durable shared inputs are:

```text
question options votes users adminName visits
```

`myName` is `PerUser`. Do not copy it during a migration. Form drafts, the
current-day override, and confirmation state are `PerSession` internals and are
intentionally fresh in each browser/runtime session.

## One-time operator setup

Run commands from the repository root:

```bash
set -euo pipefail
export CF_API_URL=https://rapids.saga-castor.ts.net
export CF_IDENTITY="${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}"
SPACE=team-lunch
POLL=lunch-poll
PATTERN=packages/patterns/lunch-poll/main.tsx

test -r "$CF_IDENTITY"
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

The DID printed by the final command should be the intended deployer. Import
the same key in the browser when the browser and CLI must act as the same user;
see
[`SHARED_IDENTITY.md`](../../../docs/development/SHARED_IDENTITY.md).

For local development, derive the trusted local identity with `deno run` so
shell redirection contains only the key:

```bash
deno run -A packages/cli/mod.ts id derive "implicit trust" > cf.key
chmod 600 cf.key
```

### Bootstrap the stable slug

A first deployment can create the slug atomically:

```bash
deno task cf piece new "$PATTERN" -s "$SPACE" --slug "$POLL"
```

For the existing production piece, or after recovering an old deployment that
predates slugs, bind it once:

```bash
RAW_PIECE=fid1:uC_TJ5p2vRMf9sDtci7pPKG7GThHYY7GFPbRJVSE71g
deno task cf piece set-slug -s "$SPACE" "$POLL" "$RAW_PIECE"
```

## Normal deployment: update in place

Start from the intended revision and run the focused tests before touching
production:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
deno task cf test --timeout 180000 --root packages/patterns \
  packages/patterns/lunch-poll/main.test.tsx
deno task cf test --timeout 180000 --root packages/patterns \
  packages/patterns/lunch-poll/multi-user.test.tsx
```

Snapshot every durable input, update the source in place, then prove those
inputs are byte-for-byte unchanged:

```bash
SNAPSHOT_DIR=$(mktemp -d)
STATE_FIELDS=(question options votes users adminName visits)

for field in "${STATE_FIELDS[@]}"; do
  deno task cf piece get -s "$SPACE" --piece "$POLL" \
    "$field" --input > "$SNAPSHOT_DIR/$field.before.json"
done

deno task cf piece setsrc -s "$SPACE" --piece "$POLL" "$PATTERN"
deno task cf piece step -s "$SPACE" --piece "$POLL"

for field in "${STATE_FIELDS[@]}"; do
  deno task cf piece get -s "$SPACE" --piece "$POLL" \
    "$field" --input > "$SNAPSHOT_DIR/$field.after.json"
  cmp "$SNAPSHOT_DIR/$field.before.json" "$SNAPSHOT_DIR/$field.after.json"
done

deno task cf piece inspect -s "$SPACE" --piece "$POLL" --summary --json
```

`setsrc` retains the piece/result identity and its populated input cells. Adding
a new defaulted input is safe. Renaming or heavily reordering inputs can change
their causal identities, so treat that as a migration and test it against a
copy first.

Open the stable URL after the CLI checks:

```text
https://rapids.saga-castor.ts.net/team-lunch/lunch-poll
```

Verify that the poll renders, existing options/history are present, joining
works, and `todayDate` reflects the browser's local date. Session-scoped values
must be checked in that browser tab: every `cf` invocation creates a fresh
runtime session, so `piece@session` in a later CLI command cannot observe a
browser tab or a previous CLI invocation.

## Mutation smoke test: use a disposable canary

Do not add test restaurants, votes, users, or visits to production. Exercise
handlers on a newly created canary and remove it afterward:

```bash
CF=(deno run -A packages/cli/mod.ts)
CANARY=$("${CF[@]}" piece new -s "$SPACE" "$PATTERN" --quiet)
cleanup() { "${CF[@]}" piece rm -s "$SPACE" --piece "$CANARY" || true; }
trap cleanup EXIT

"${CF[@]}" piece call -s "$SPACE" --piece "$CANARY" joinAs \
  '{"name":"Deploy Canary"}'
"${CF[@]}" piece call -s "$SPACE" --piece "$CANARY" addOption \
  '{"title":"Canary Cafe"}'
"${CF[@]}" piece call -s "$SPACE" --piece "$CANARY" logVisit \
  '{"title":"Canary Cafe"}'
"${CF[@]}" piece step -s "$SPACE" --piece "$CANARY"

"${CF[@]}" piece get -s "$SPACE" --piece "$CANARY" optionCount
"${CF[@]}" piece get -s "$SPACE" --piece "$CANARY" historyCount
"${CF[@]}" piece get -s "$SPACE" --piece "$CANARY" mostRecentTitle
```

The expected values are `1`, `1`, and `"Canary Cafe"`. The canary has a raw id
and never owns the production slug.

## Copy or replace a deployment

Use this only for a canary seeded with production data, a causal-input
migration, or a genuinely unrecoverable piece. It copies a point-in-time
snapshot; the two pieces diverge afterward.

```bash
OLD=$POLL
NEW=$(deno run -A packages/cli/mod.ts piece new -s "$SPACE" "$PATTERN" --quiet)
STATE_FIELDS=(question options votes users adminName visits)
MIGRATION_DIR=$(mktemp -d)

for field in "${STATE_FIELDS[@]}"; do
  deno task cf piece get -s "$SPACE" --piece "$OLD" \
    "$field" --input > "$MIGRATION_DIR/$field.json"
  deno task cf piece set -s "$SPACE" --piece "$NEW" \
    "$field" --input < "$MIGRATION_DIR/$field.json"
done

deno task cf piece step -s "$SPACE" --piece "$NEW"

for field in "${STATE_FIELDS[@]}"; do
  deno task cf piece get -s "$SPACE" --piece "$NEW" \
    "$field" --input > "$MIGRATION_DIR/$field.new.json"
  cmp "$MIGRATION_DIR/$field.json" "$MIGRATION_DIR/$field.new.json"
done

# Browser-test /team-lunch/$NEW before changing the public pointer.
deno task cf piece set-slug -s "$SPACE" "$POLL" "$NEW"
```

Keep the old piece until the new public URL has been verified. Do not copy
`myName`; each user rejoins or retains their own per-user state only when the
same piece is updated in place.

## Reading and resetting state

For reliable automation, read the specific input or scalar output you need:

```bash
deno task cf piece get -s "$SPACE" --piece "$POLL" visits --input
deno task cf piece get -s "$SPACE" --piece "$POLL" historyCount
deno task cf piece get -s "$SPACE" --piece "$POLL" todayVoteCount
```

`piece inspect` also reports source/result state. Connection analysis is
best-effort because it walks other pieces in the space; a connection warning
does not mean the target piece's state was unavailable.

Reset commands mutate the shared poll and require coordination. Prefer the
host-gated UI/handlers (`resetVotes`, `clearHistory`). An operator can directly
replace the `votes` or `visits` input only when an intentional emergency reset
has been agreed.

## Identity and host behavior

- Joining is profile-first when `#profileName` resolves, with manual entry as a
  fallback. Programmatic callers may pass `{"name":"..."}` to `joinAs`.
- `users` and `adminName` are shared; `myName` is per-user. The first joiner
  becomes host.
- Names are unique. A joined participant can use **Become host** (`claimHost`)
  if the recorded host is stale.
- The browser and CLI are different users unless they use the same imported
  identity key.

## Recovery and diagnosis

### A root-pattern failure blocks unrelated CLI work

Connection discovery and piece-list operations may traverse the space root. A
stale root can therefore make an otherwise healthy poll look broken. Current
runtimes attempt the system-pattern update before retrying a failed root start,
and back-fill provenance for legacy roots whose verified authored entry is an
official system pattern. Recreated system roots also retain provenance for the
next update.

Upgrade the shell/CLI to a build containing that recovery before taking a
destructive action. Custom roots remain pinned and are never inferred as system
roots.

As a final, state-losing repair for the **space root** (not the poll piece):

```bash
deno task cf piece recreate-root -s "$SPACE"
```

Use this only after the automatic recovery fails. It recreates the space's
navigation/root pattern; it is not a remedy for session-scoped browser state.

### The source updated but a CLI session value did not

This is usually scope, not a wedged deployment. `PerSession` state belongs to a
single browser/runtime session, and each CLI command starts another one. Check
durable `PerSpace` inputs with `piece get --input`, per-user state with the same
identity, and UI/session state in the browser tab that owns it.

### The piece is genuinely missing

Create a replacement without changing the production slug, follow the copy and
verification procedure above, and repoint `lunch-poll` only at the end. This
keeps the shared URL stable and gives rollback a concrete old piece id.
