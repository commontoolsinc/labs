# Naming the Topics that predate the namespace

Part of `skills/topics/SKILL.md`, which is the map. This is the operator
procedure, with its order, its two commands, its audit, and its traps.

A Topic reads its own name by looking itself up in the board's names table,
which reaches it as its `boardNames` ARGUMENT — `addTopic` wires it at create,
and `ownName` in `packages/patterns/collection-naming/naming.ts` is the lookup.
A parent writes its member's result and never its member's argument, so
`backfillNames` names a Topic filed before the namespace in the board's map
while that Topic goes on reading no name. No pattern can close that gap. One
`deno task cf piece link` per Topic can, and this is that procedure.

It was established by a clone rehearsal, and the evidence — every command, its
output, and the counts and timings behind the claims here — is
`docs/history/plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md`. Read
that before deciding anything this procedure says needs deciding.

### The order

1. **The board's source first**, and it needs
   `--dangerously-allow-incompatible-schema`. `setsrc --check` refuses it over a
   board holding Topics filed before the namespace:

   ```
   input link at topics.0.shortName: an unconstrained schema is no longer accepted
   ```

   An open producer contract permits any value at an undeclared property. A new
   string demand narrows that contract even when optional: absence is allowed,
   but a present non-string value is not. An optional `unknown` demand adds no
   value restriction and is compatible. The retained link proof uses
   producer-owned durable metadata; a schema carried by the alias is not a
   producer guarantee. The checker is
   `packages/piece/src/schema-compatibility.ts`, and the snapshot evidence is
   `docs/history/development/issue-6969-upgrade-gates-2026-09-09.md`.

   `deno task pattern-compat` and `deno task pattern-vintage` do not see this.
   `tasks/pattern-vintage.ts` says what each proves: a pattern's declared
   contract against the contracts it declared before, and its own stored
   documents under today's source. Neither reaches the schema recorded on a link
   into a sibling piece, so both can be green while the deploy is refused. Run
   `setsrc --check` against the deployment itself before scheduling a window,
   and treat the flag as needing team authorization under the rule in
   `references/pattern-updates.md`.

2. **Then each Topic's source**, and it needs
   `--dangerously-allow-incompatible-schema` once per Topic. Moving the board
   first clears the Topic leg's own `mentionable[].shortName` refusal, and what
   `setsrc --check` reports underneath is the Topic's mention universe narrowing
   from a writable handle to a readable one:

   ```
   Pattern schemas are not backward compatible:
   - argument.mentionable: asCell changed
   ```

   `asCell` is compared for exact equality by
   `packages/piece/src/schema-compatibility.ts`, so a narrowed cell reads as a
   break however narrow the narrowing is; the decision and what it costs are
   `docs/history/topics-mentionable-readonly-break.md`. The cost is one forced
   update per Topic and no more: a readable handle drops the write-back leg of
   the retained-link proof that a writable one carries — the leg that would
   demand the Topic's three-string projection accept the `piece` the board's row
   publishes — so `setsrc --check` proves every update after this one. Like step
   1's, the flag is a team-authorization decision under the rule in
   `references/pattern-updates.md`, and a separate one, for an unrelated reason.

   **Skipping it leaves a usable board.** A Topic still on pre-graft source is
   named by `backfillNames` like any other member, answers to
   `deno task cf cell get /top/<n> title`, and reads back as an ordinary `index`
   row with no `shortName` and no damage to the array around it. So naming,
   `/top/<n>` addressing and index membership all survive the step being
   skipped, and `shortName` — the badge, and the number on the index row — is
   what is absent. That bounds what skipping costs from BELOW, not from above:
   no run against a populated board has forced a Topic update, so what else a
   completed one would change there is not known, and the record says so. Step
   4's refusal on such a Topic is this state being enforced rather than an
   error.

3. **`backfillNames` once**, through the board. It returns the names it wrote,
   in filing order, and is idempotent: a second run writes nothing and returns
   an empty list.

4. **`deno task cf piece link` once per Topic that `addTopic` did not wire** —
   that is, per Topic that took step 2. A Topic that skipped it has no
   `boardNames` input to bind, and the bind says so.

### The two commands

```bash
deno task cf piece call --cell "$TOPICS_BOARD" --invocation '<id>' backfillNames \
  '{"agentName":"Sol"}'
deno task cf piece link "$TOPICS_BOARD/namesTable" "$TOPIC/boardNames"
```

The bind needs no `--allow-non-existing` flag after step 2. The Topic declares
`boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>`, so `input.get()`
exposes a `boardNames` handle whose value defaults to `[]`. That makes the
target present for the link command's value-presence check even before a link is
stored.

Between them is the gap this procedure exists for: the board's `names` map and
`namesTable` hold the name, and the Topic does not.

```
$ deno task cf cell get --cell "$TOPIC" shortName --step
Cannot read piece result at "shortName": stored data is present, but its schema
could not resolve all required values. The piece was stepped, but the required
value still did not materialize.
```

After the bind that read answers with the number, the board's `index` row for
that Topic carries it as `shortName`, and `deno task cf cell get /top/<n> title`
returns its title. A Topic left unbound keeps reporting the message above, which
is what a half-finished run looks like: the board serves every Topic either way,
named beside unnamed, and the repair is to bind the rest. Nothing has to be
undone.

The bind is idempotent — repeating it with the same two endpoints changes
nothing and commits nothing. Note that `wrote to space` prints either way, so it
is not evidence that anything was written.

**Read twice before concluding a bind failed.** The first read after a backfill
can report no name for a correctly wired Topic, and the next identical command
answers with the number, with no write in between.

**Cost is one command per Topic**, serially. On a board the size of the Estuary
one that is the bulk-CLI shape
`docs/history/topics-board-migration-2026-08-28.md` found unreliable from a
laptop; run it from somewhere that record vindicates.

### Audit which Topics still need it

The derived `shortName` is the wrong thing to audit — read the durable argument:

```bash
deno task cf cell get --cell "$TOPIC" boardNames --input --select name
```

A bound Topic returns the whole names table (`[{"name":"1"},…]`); an unbound one
returns `[]`. Read the VALUE, not the keys: the input is declared
`boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>` in
`packages/patterns/topics/topic.tsx`, so the key is there either way and its
presence says nothing.

Audit only Topics whose source has already been migrated. Input reads use the
current pattern's projection: if it does not declare `boardNames`, this targeted
read refuses the path, including when the raw argument document holds a legacy
link there. Updating the pattern to select the input exposes that retained link
without rewriting it. Check the Topic's published `shortName` after the bind to
verify that the pattern consumes its row.

### Traps

**A bind cannot expose an undeclared input** (#6965). A Topic that has not taken
step 2 has no `boardNames` input in its pattern schema. Linking to it refuses
before writing, with or without `--allow-non-existing`:

```
Cannot access path "boardNames" - property "boardNames" not found in the current pattern's input schema. Update the target pattern with cf piece setsrc to declare this input before linking, reading, or writing it. --allow-non-existing does not override the input schema.
```

Update the Topic's pattern before binding. A refused bind stores no link and
reports no successful link receipt; targeted `deno task cf cell set --input`
writes also refuse the undeclared path. The flag overrides missing pieces or
endpoint values, so it can bind a declared input that has neither a value nor a
default. It cannot override the input schema. Topics' `boardNames` default makes
that override unnecessary for this migration.

**`setsrc --check` is not read-only against the store** (#6964). It writes, even
when it refuses and replaces nothing, so a rehearsal clone is spent after one
and a second pass needs `deno task cf space reset`. Nothing authored moves.

**Binding a piece the board does not hold** does nothing wrong and nothing
useful: it succeeds, and the Topic reads no name. The lookup is by identity —
`nameOf` in `packages/patterns/collection-naming/naming.ts` finds the row whose
`member` `equals` the one asked about — so a non-member has no row to find.
