---
name: topics
description: Interact with the Common Fabric team's Topics board on Estuary through
  the Labs cf CLI. Use when reading, creating, or updating Topics; posting Topic
  progress comments; attaching pull request links; or adding references between
  Topics.
---

# Topics on Estuary

Topics is the team's minimal issue tracker. This skill names the Estuary
deployment, the deployed verb contract, and the team's authorship and editorial
conventions. Use `skills/cf/SKILL.md` for the general CLI surface. The pattern's
canonical semantics live in `packages/patterns/topics/README.md`; its verb
contracts live in `packages/patterns/topics/main.tsx` and
`packages/patterns/topics/topic.tsx`.

## Deployment and identity

Run from the Labs repository root so `cf` uses that checkout:

```bash
export CF_API_URL='https://estuary.saga-castor.ts.net'
export CF_SPACE='topics-dev-476ea34f'
export TOPICS_BOARD='/of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34'
export CF_IDENTITY="${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}"
test -r "$CF_IDENTITY" || {
  printf 'Topics identity key is not readable: %s\n' "$CF_IDENTITY" >&2
  exit 1
}
```

An already-set `CF_IDENTITY` is the explicit override. Otherwise use the team's
stable per-user default at `~/.config/commonfabric/identity.key`; the path is
common while its contents belong to that teammate. Use the same Estuary identity
key as your human user. If the readability check fails, stop and ask the human
to provision that default or export the correct path. Do not search for keys,
mint an agent key, use another human's key, or use the publicly derivable
`implicit trust` identity. Never print or inspect key material; use
`cf id did "$CF_IDENTITY"` when the public DID is needed for verification.

Every authored-content mutation carries `agentName` in the same event. Use one
stable agent name, without decorating titles, labels, bodies, or comments with a
second signature. Fabric retains the human principal authenticated by the key;
Topics stores the agent name as structured content attribution.

`mention` and `unmention` are the intentional exception: they record only a
reference edge, take no `agentName`, and return no value.

## Start from the deployed verbs

The running piece is authoritative. Orient before mutating it:

```bash
cf piece verbs --cell "$TOPICS_BOARD" --json
```

That listing includes the deployed pattern reference, callable prose, and input
and output schemas. `cf piece describe --cell "$TOPICS_BOARD" --json` returns a
superset of it (the same verb rows plus name, purpose, state, and inputs) for
the same bounded discovery load. Neither command starts the piece; the reason to
default to `verbs` is payload, not time: the listing is the smaller document to
hold in context, and it is complete for calling. Use `describe` when you need
the piece-wide purpose, state, or input documentation. Use
`cf piece call --cell "$TOPICS_BOARD" <verb> --help --json` only after choosing
a verb and when its generated flags or standalone help are useful; help is
served through the dispatch path, which also starts the space root, so it is the
most expensive of the three. Each command is an independent cold CLI process, so
do not run all three by default.

The deployment can be well behind the checkout the CLI runs from, and that gap
explains board behavior that would otherwise read as a defect. Ask it which
commit it serves before recording one:

```bash
curl -fsS "$CF_API_URL/api/meta" | jq -r .gitSha
```

Resolve that in the repository — `git log --oneline -1 <sha>`, and
`git rev-list --count <sha>..upstream/main` for the distance — before concluding
anything from a verb that behaves unlike the source in front of you. A gap of
dozens of commits is ordinary, so which source is running is the first question,
not the last.

Run `piece verbs --json` again after selecting a Topic, and use `describe` or
per-verb help on demand. `piece verbs` lists contract verbs by default; `--all`
additionally shows UI wrappers and deprecated verbs. The board's published Topic
rows deliberately contain no verbs: take a row's address and call that Topic
directly.

The current declared contract is:

| Piece | Verb            | Input                                           | Declared result         |
| ----- | --------------- | ----------------------------------------------- | ----------------------- |
| Board | `addTopic`      | `title`, optional `body`, `agentName`           | created `topic`, `name` |
| Board | `backfillNames` | `agentName`                                     | the names it wrote      |
| Topic | `addComment`    | `body`, `agentName`                             | appended `comment`      |
| Topic | `addLink`       | `url`, optional `kind` and `label`, `agentName` | appended `link`         |
| Topic | `setBody`       | complete `body`, `agentName`                    | body and attribution    |
| Topic | `setTitle`      | `title`, `agentName`                            | title and attribution   |
| Topic | `mention`       | Topic reference                                 | none                    |
| Topic | `unmention`     | Topic reference                                 | none                    |
| Topic | `editComment`   | comment reference, `body`, `agentName`          | body and `editedAt`     |
| Topic | `removeComment` | comment reference, `agentName`                  | the retraction stamp    |
| Topic | `removeLink`    | link reference **or** `url`, `agentName`        | url and stamp           |

A retraction stamps the record rather than deleting it: the comment or link
stays, carrying what it always said, while readers stop showing it and
`commentCount` stops counting it. A retracted link also stops resolving into
`mentions`. Retracting is not a way to make something unsaid — the evidence is
retained deliberately.

`editComment` and `removeComment` name their target by REFERENCE, and a comment
is not a piece: it has no fid to write into an inline JSON event, so these are
reachable from a reader that holds the row, not from a bare `cf piece call`.
`removeLink` is the exception and takes `url` for exactly that reason,
retracting the most recently added link still present with that URL — so
retracting twice retracts two rather than re-stamping one.

## Discover and read

Survey through the compact `index`. Its rows are Topics, and `@` asks for each
row's canonical address without expanding its body, thread, or verbs:

```bash
cf cell get "$TOPICS_BOARD" index --step \
  --select @,title,createdAt,lastActivityAt,commentCount,createdBy.kind,createdBy.name
```

Keep discovery bounded. An unprojected board or durable `topics` read can follow
every Topic into its body, thread, and verbs, transfer the whole graph, and
append a read-set commit proportional to what it observed. Survey the projected
`index`, then expand one Topic at a time.

Take the selected row's `$link` value unchanged as `TOPIC`; canonical references
compose directly into later commands. The space prefix appears only when the
reference's space differs from the command's target space, so never reconstruct
or edit the emitted address.

That rule is about writing an address. Reading one has a counterpart: a Topic
answers to more than one address, so two that differ as strings can name the
same Topic. The `$link` a `mention` edge carries is not the string the board
index hands out for the Topic it points at. Resolve each address and compare
what comes back rather than comparing the addresses, and compare on something a
separate document would not share — `createdAt`, or the comment thread — since a
title alone can be duplicated. An address you do not recognise on an edge is not
evidence the edge is wrong.

Read one Topic's durable input before changing it:

```bash
cf cell get --cell "$TOPIC" title --input
cf cell get --cell "$TOPIC" body --input
cf cell get --cell "$TOPIC" comments --input \
  --select sentAt,author.kind,author.name,body
cf cell get --cell "$TOPIC" links --input \
  --select kind,url,label,addedAt,addedBy.kind,addedBy.name
```

Use exact-field or range `--filter` predicates to narrow arrays, then project
with `--select`. Do not combine an address marker with `--filter`: filtering
changes positions, so a surviving row cannot carry its original address.

Input reads are the durable source of truth. Use `--step` for computed results
such as the board's `index` and a Topic's `commentCount`, `lastActivityAt`,
`mentions`, or `referencedBy`.

## `top/42` — a Topic addressed by the board's name for it

The board gives each Topic a name of its own: a decimal number, dense from `1`,
allocated when the Topic is filed and never reused. It is not a display name — a
Topic's display name stays its title, and the number renders as a badge beside
it. `addTopic` returns the name it allocated as `name` beside the created
`topic`, and each Topic publishes its own as `shortName`, which the board's
`index` rows and mention universe carry a copy of. So a survey reads every name
in one bounded read:

```bash
cf cell get "$TOPICS_BOARD" index --step --select @,title,shortName
```

The number is what a short reference is written with. Once the board's `names`
map is bound as a slug, `<collection>/<member>` names a Topic wherever an
address is taken — `cf cell get /@<space>/top/42 title`,
`cf piece describe --cell /@<space>/top/42`,
`cf piece call --cell /@<space>/top/42 setTitle '{...}'` — and exactly one
segment reaches a member, so `/@<space>/top/42/title` is that Topic's `title`
field. A name with no member after it is refused, naming the piece holding the
collection; and `no member 999 in top` is the refusal for a member the board
does not hold. `packages/cli/README.md` is the whole grammar, and
`docs/specs/collection-naming.md` the design.

A member name is the board's, not the fabric's: it means something only through
the collection that issued it, so a citation carries the collection —
`/@<space>/top/42`, never a bare `42`. A canonical `/of:` address remains the
thing to pass in a reference position; the member name is for a person to read
and type.

**What the Estuary deployment carries.** The verbs and the naming above are what
the pattern in this checkout declares. The deployed board runs whatever commit
`/api/meta` reports, and until a pattern update lands there it has no `names`
map, no `top` slug, and no named Topic — a Topic publishes no `shortName` and
`/top/42` resolves to nothing. Ask the deployment before citing a number, and
treat `top/42` as unavailable there until the plan's remaining step is done
(`docs/plans/collection-naming-topics.md`). Deploying it and naming the Topics
already on the board are the team's steps, not an agent's.

## Create and recover the address

Mint one invocation session for the agent run. Replace every angle-bracketed
invocation placeholder below with an id unique to that logical mutation, and
reuse that id only to retry the same mutation. Create through the board and
project the returned Topic to its address:

```bash
export CF_INVOCATION_SESSION="$(cf invocation-session new)"
CREATE="$(cf piece call --cell "$TOPICS_BOARD" \
  --invocation '<unique-topic-create-id>' \
  addTopic \
  '{"title":"<title>","body":"<initial living document>","agentName":"Sol"}' \
  -- --schema '{"properties":{"topic":{"$link":true},"name":{"type":"string"}}}')"
TOPIC="$(printf '%s\n' "$CREATE" | jq -r '.result.topic["$link"] // empty')"
NAME="$(printf '%s\n' "$CREATE" | jq -r '.result.name // empty')"
```

The projection names BOTH results, and that is load-bearing: a schema listing
only `topic` drops `name` from the envelope, so `NAME` comes back empty and the
allocated number is lost. Dropping the projection entirely returns the name and
the whole created topic with it — a rendered view included, two orders of
magnitude more payload — which is what the projection exists to avoid.

When the result is present, carry `TOPIC` into the next command. `NAME` is the
member name the board allocated — read it here rather than from the Topic's own
`shortName`, which is a derivation that may not have produced a value when the
call returns. Use JSON encoding or schema-derived flags for multiline Markdown;
do not interpolate unescaped content into JSON.

Current Estuary calls have a known observation asymmetry. `addTopic` has
reported an error after committing and has reported success without committing.
A call can also answer nothing at all: `addTopic` and `addLink` have each hung
past a ten-minute client timeout and committed, and an `addTopic` has hung the
same way and not committed. A timeout therefore settles nothing in either
direction, and none of this is particular to `addTopic` — take it as the
behavior of every authored-content verb.

So treat every call envelope, and every absence of one, as an observation rather
than proof of durable state, and read back after every mutation. For `addTopic`,
use a distinctive title and compare the narrow board index before and after the
call; if the result is uncertain, recover its `$link` there rather than blindly
creating another Topic. Retrying on the strength of a timeout is how one Topic
becomes two.

```bash
cf cell get "$TOPICS_BOARD" index --step --select @,title
cf cell get --cell "$TOPIC" title --input
```

Use one invocation session per agent run and an explicit invocation id per
logical mutation. Retry an uncertain mutation only with that same session/id
pair. The full retry and receipt model is in `skills/cf/SKILL.md` and
`docs/common/verbs/over-the-cli.md`.

## Update through Topic verbs

```bash
cf piece call --cell "$TOPIC" --invocation '<unique-set-title-id>' setTitle \
  '{"title":"<complete new title>","agentName":"Sol"}'
cf piece call --cell "$TOPIC" --invocation '<unique-set-body-id>' setBody \
  '{"body":"<complete revised body>","agentName":"Sol"}'
cf piece call --cell "$TOPIC" --invocation '<unique-add-comment-id>' addComment \
  '{"body":"<point-in-time update>","agentName":"Sol"}'
cf piece call --cell "$TOPIC" --invocation '<unique-add-link-id>' addLink \
  '{"url":"<PR URL>","kind":"pr","label":"<label>","agentName":"Sol"}'
```

`kind` defaults to `web`; a blank or omitted `label` defaults to the URL.
Current authored-content verbs reject blank required content or attribution
instead of reporting apparent success.

Verify the relevant durable input after each call (`title`, `body`, `comments`,
or `links`). Use `--step` as a second check when the expected change is
computed, such as a count or board-index row.

A cross-Topic connection is a reference, not an address pasted into prose. Pass
the canonical reference in the declared reference position; the CLI turns it
into the live piece link the verb expects. Set `OTHER_TOPIC` to the `$link` from
the index row for the Topic being referenced:

```bash
export OTHER_TOPIC='<canonical /of:... address from another index row>'
cf piece call --cell "$TOPIC" --invocation '<unique-mention-id>' mention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
cf piece call --cell "$TOPIC" --invocation '<unique-unmention-id>' unmention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
```

Use inline JSON for these reference events. The schema-derived `--topic` flag
parses its declared object before reference resolution and therefore rejects a
bare canonical address.

`unmention` removes every `mention`-made edge to that Topic. References created
inside the body are removed by editing the body. An `addLink` URL that resolves
to a piece also contributes to the reference graph.

## Editorial conventions

- Treat the body as the living big-picture document. Replace it whole with the
  current state while preserving meaningful context and decisions. Fabric owns
  revision history; do not duplicate it as an activity log.
- Treat comments as append-only, point-in-time progress records. Record what
  changed, what was learned or decided, and what comes next.
- Add every relevant pull request explicitly with `addLink` and `kind: "pr"`;
  mentioning a PR only in prose is not enough.
- Use references for relationships between Topics. Do not rely on pasted fids or
  prose scanning.

## Production pattern updates

Changing content through verbs is normal. Changing the board or Topic pattern
source is a production migration over team-critical data. Before any `setsrc`,
read `docs/development/space-clone-rehearsal.md` and the latest Topics migration
record in `docs/history/topics-board-migration-2026-08-28.md`. Do not use
`--dangerously-allow-incompatible-schema` without explicit team authorization.

Pass `--root` at or above `packages/patterns` on every `piece new` and `setsrc`
of the board or a Topic. Both import the member-naming library from a sibling
directory, and the default program root is the entry's own directory, so without
the flag every such import is refused as escaping the program root and the
deploy fails before it reaches the server.

Do not substitute `piece ls` for the board index: handler-created Topics need
not appear in the registry. If a deployed field or verb differs from this map,
trust `piece describe`, `piece verbs`, and verb help, then update this skill in
the same change that updates the deployment contract.

## Naming the Topics that predate the namespace

A Topic reads its own name by looking itself up in the board's names table,
which reaches it as its `boardNames` ARGUMENT — `addTopic` wires it at create,
and `ownName` in `packages/patterns/collection-naming/naming.ts` is the lookup.
A parent writes its member's result and never its member's argument, so
`backfillNames` names a Topic filed before the namespace in the board's map
while that Topic goes on reading no name. No pattern can close that gap. One
`cf piece link` per Topic can, and this is that procedure.

Everything below was run against local stores — a `cf space clone` of a board
whose Topics were filed by the pre-graft pattern, and a second store holding the
grafted board beside Topics `addTopic` never wired — and the quoted output is
what came back, with long single-line messages wrapped to fit. Rehearse it the
same way before the live run: `docs/development/space-clone-rehearsal.md`.

### The order, and why it is not free

1. **The board's source first.** Over a board whose Topics predate the
   namespace, `setsrc --check` refuses BOTH legs, so the checker does not pick
   the order for you — the board's refusal is the one the graft can clear:

   ```
   piece source is incompatible with retained input: input link at topics.0
   schema is not compatible: input link at topics.0.shortName: an
   unconstrained schema is no longer accepted
   ```

   That refusal is not about `shortName`. Adding `probeField?: string` — or
   `probeField?: unknown` — to `TopicDemand` and nothing else produces the same
   message at `topics.0.probeField`. **Any** new property on a per-member demand
   is refused over a board holding members that do not publish it, so the board
   leg needs `--dangerously-allow-incompatible-schema` and therefore the team's
   explicit authorization. The forced deploy itself is UNREHEARSED — the
   rehearsal stopped at the refusal rather than waive a proof it had no
   authorization to waive, so what the flag leaves behind on a real board is
   still unmeasured. `deno task pattern-compat` and `deno task pattern-vintage`
   do not see this: they judge a pattern against its own baselines and its own
   stored documents, never against the schema recorded on a link into a sibling
   piece. Run `setsrc --check` against the deployment itself and read what it
   says before scheduling the window.

2. **Then each Topic's source — and this step is BLOCKED as written.** Moving
   the board first clears the Topic leg's `mentionable[].shortName` refusal, and
   what is left underneath is #6968: a Topic wired to a board's `mentionable`
   cannot be re-sourced at all, not even with the bytes it is already running.

   ```
   piece source is incompatible with retained input: input link at mentionable
   schema is not compatible: input link at mentionable[].piece: newly required
   argument field has no default
   ```

   `mentionable` is declared `Writable` on the Topic, so the proof runs the
   write-back direction too and demands that the Topic's projection accept
   everything the board's row publishes. Measured identically on a clean control
   piece that was never touched, so it is a property of the wiring, not of any
   one migration — and it is not downstream of step 1's schema question.
   Clearing that one does not clear this.

   **What you lose by skipping it, measured.** Less than the step's position
   suggests. A Topic still running pre-graft source, sitting on a grafted board:

   - is named by `backfillNames` like any other member;
   - answers to `cf cell get /top/4 title` with its own title, so the number
     works as a citation;
   - reads back as an ordinary `index` row, with its title and no `shortName`,
     and does not empty the array around it.

   What it does not have is `shortName` — no badge on the Topic, no number on
   its index row, and `cf cell get --cell "$TOPIC" shortName` reports the
   property does not exist rather than failing to materialize. **So step 2 buys
   the number's visibility on the member, and nothing else.** A board that stops
   after step 3 is a coherent end state, not a half-migration, and step 4's
   refusal on such a Topic (first trap below) is that state being enforced
   rather than an error.

   **If you must have it anyway**, the only exit the CLI offers is
   `--dangerously-allow-incompatible-schema`, whose help covers exactly this
   proof: "Replace the source even when pattern or retained-link schema
   compatibility cannot be proven." Three things before taking it, and the first
   is the one this document cannot answer for you:

   - **It was not rehearsed.** No run in this procedure's evidence forced a
     Topic update. That the flag would succeed is read off its help text, not
     measured, and what a forced Topic update leaves behind is unknown.
   - **It is permanent, not one-off.** The refusal is on the Topic's own bytes,
     so `--check` will refuse every future Topic source update too, including
     one that changes nothing. There is no version of this step that carries a
     compatibility signal — the pre-flight is already gone, today, whether or
     not anyone forces anything, and the 2026-08-28 record establishes that a
     Topic source update is one-way once taken.
   - **It needs the same team authorization step 1 needs**, for an unrelated
     reason. Two separate decisions, not one.

3. **`backfillNames` once**, through the board.
4. **`cf piece link` once per Topic that `addTopic` did not wire** — that is,
   per Topic that took step 2. A Topic that skipped it has no `boardNames` input
   to bind, and the bind says so.

### The two commands, and what they return

```bash
cf piece call --cell "$TOPICS_BOARD" --invocation '<id>' backfillNames \
  '{"agentName":"Sol"}'
cf piece link "$TOPICS_BOARD/namesTable" "$TOPIC/boardNames"
```

```
{
  "invocation": "backfill-1",
  "status": "settled",
  "receipt": "/of:fid1:jN3t1AzX5Uq_R2Tj-j2zlchglDmyIak4PTytJ9YBGNw",
  "result": {
    "assigned": [
      "2",
      "3"
    ]
  }
}
Linked fid1:PsEKqxGfhAaFgHbDMukzSr7_8qF3wISOsKPL0BSsoXs/namesTable to fid1:0SpKr2JWj939XCwSEX4H6uyXA8fzx5HILsNBCPLiiFQ/boardNames
```

After the backfill and before the bind, the board's map holds the name and the
Topic does not — this is the whole gap, in one read each:

```
$ cf cell get --cell "$TOPICS_BOARD" names --step
{
  "1": {},
  "2": {},
  "3": {}
}
$ cf cell get --cell "$TOPIC" shortName --step
Cannot read piece result at "shortName": stored data is present, but its schema
could not resolve all required values. The piece was stepped, but the required
value still did not materialize.
```

After the bind the same read answers `"2"`, the board's `index` row for that
Topic carries `"shortName": "2"`, and `cf cell get /top/2 title` returns its
title. A Topic left unbound in the same board keeps reporting the message above,
which is how a half-finished run reads: the board serves every Topic either way,
named ones beside unnamed ones, and the repair is to bind the rest. Nothing has
to be undone.

### Audit which Topics still need it

The derived `shortName` is the wrong thing to audit — read the durable argument:

```bash
cf cell get --cell "$TOPIC" boardNames --input --select name
```

A bound Topic returns the whole names table (`[{"name":"1"},…]`); an unbound one
returns `[]`. The KEY is present either way, because a Topic deployed with the
current source materializes `boardNames` at its `Default<[]>`, so `keys` says
nothing.

Audit only Topics whose source has already been migrated. This read answers for
the argument document, not for what the pattern can see, so a Topic that was
force-bound before its source moved — see the first trap below — reads as bound
here while its name never appears anywhere. On a board migrated in the order
above that case cannot arise; if the order slipped, the honest check is that the
Topic publishes `shortName` at all.

### What the rehearsal measured

- **Idempotent, twice over.** A second `backfillNames` returns
  `{"assigned": []}` and writes no key. A second `cf piece link` with the same
  two endpoints prints `Linked …` and commits nothing — measured with
  `cf inspect churn --bucket 5` over the window, which reported
  `no timed commits in window`. `wrote to space` is not evidence of a commit.
- **Cost is one commit and one revision per Topic**, on the same measurement,
  plus a CLI process per Topic. For a board of ~125 that is ~125 sequential
  invocations, which is the shape the 2026-08-28 run found unreliable from a
  laptop — see `docs/history/topics-board-migration-2026-08-28.md`.
- **Binding before the backfill works**, but the first read afterwards can still
  report no name. A Topic bound before it was named read the failure message
  above immediately after `backfillNames` returned `["4","5"]`, and read `"5"`
  on the next identical command with no write in between. Read twice before
  concluding a bind failed.
- **`/top/<n>` resolves without the bind.** Address resolution follows the
  board's map, so a backfilled Topic answers to `cf cell get /top/3 title` while
  its own `shortName` is still absent. `/top/999` answers
  `no member 999 in top`.
- **`addTopic` keeps wiring its own children afterwards.** A Topic filed after
  the operator step came back with `"name": "6"` and its own table; the step is
  one-time, not a recurring chore.
- **`setsrc --check` is not read-only against the store** (#6964). Isolated on a
  reset clone: serving it and stopping again leaves `content unchanged`, and
  then ONE `--check` — one that was refused, replacing no source — verifies
  `removed 0 · changed 0 · added 18`, `commits 170 → 172`. Nothing authored
  moved, but the clone is spent and a second pass needs `cf space reset`.

### Two traps

**Never pass `--allow-non-existing` to the bind** (#6965). On a Topic whose
pattern has no `boardNames` input — one that has not taken step 2, whether
because the order slipped or because step 2 was deliberately skipped — the bind
refuses, and that refusal is the guard that keeps step 4 behind step 2:

```
Target path "boardNames" does not exist on piece fid1:6hFfedg…
Use --allow-non-existing to link anyway.
```

Taking that suggestion prints `Linked …` and buys nothing: the Topic's input map
does not gain the key — neither `cf cell get --cell "$TOPIC" --input` nor
`cf piece inspect`'s Source (Inputs) shows it — and its name never appears. What
it does do is write the link into the argument document, where the pattern
cannot reach it but `cf cell get --cell "$TOPIC" boardNames --input` can, which
is what makes the audit above read it as bound. The next `setsrc` of that Topic
then fails with an extra
`updated arguments do not match the candidate schema: boardNames: value does not
match type array`
that a clean control piece does not produce. The forced bind poisons the Topic
against its own migration.

**Binding a piece the board does not hold does nothing wrong and nothing
useful.** It succeeds, and the Topic reads no name, because the table addresses
its rows by member identity and holds no row for a non-member.
