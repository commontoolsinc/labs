# Collection naming: the first customer

The build plan for [Naming in collections](../specs/collection-naming.md),
carried by a parallel exemplar so that the Topics board is touched once, at
the end, by a diff the exemplar has already proven. Member names are what the
spec calls them; for the exemplar and for Topics they are decimal numbers, so a
member is cited as `top/42`.

## Where this stands — read this first

This block is LIVE: the change that moves a stage updates it here.

| stage | state |
| --- | --- |
| S0 — decisions ruled, plan filed | on main (#6882) |
| S1 — the library and the exemplar board own a member namespace | on main (#6882) |
| S1b — index rows are the members | on main (#6886) |
| S2 — `top/42` resolves at the CLI | on main (#6890) |
| S2b — assignment refuses by default | on main (#6898) |
| S3 — the shell opens `/<space>/top/42` | on main (#6896) |
| S4 — `#42` in text | on main (#6887) |
| S6 — graft onto Topics | items 1, 2, 3, 5 on main (#6937); item 4 rehearsed twice and held, awaiting a demand for named Topics rather than a technical answer |
| S5 — deferred, not scheduled | — |

## Decisions, ruled 2026-09-03

Each of these was a question with a recommendation; the recommendation was
ruled. A later reversal is a decision recorded here, not a discovery.

1. **The citation form follows the cell reference grammar.** The fully
   qualified citation is `#//topics-dev/top/42`. The spec's `#@space/...`
   spelling is amended when that grammar lands. Part 1 of the spec, which
   governs addressing, is unaffected. #6814 records that decision and changes
   no parser, so until one accepts `//<space>/...` the spelling that resolves
   is `/@<space>/...`, and that is what a stage builds and demonstrates. A
   criterion's examples mean whichever spelling the reference parser accepts
   when the criterion is checked, so the switch follows that parser rather
   than any pull request.
2. **The reverse-map restructure and the cross-space slug target are
   deferred.** A board-owned namespace never writes the piece's single `slug`
   metadata entry, so that restructure gates URL rewriting rather than
   naming. Nothing here rewrites an identity URL to the member form, and no
   personal binding is built. What the deferral accepts: a space-level name
   whose path selects a member stamps that member's root —
   `cf piece set-slug two /top/2`, which
   `packages/cli/test/setPieceSlug.test.ts` covers as "names the member a
   slug's path selects, and stamps that member with the name" — so a member
   answers to `<space>/two` and `<space>/top/2` at once, and a visit by
   identity is rewritten to the first. The spec's step 1 records the same
   acceptance and is deferred with this decision rather than held as a
   prerequisite over it.
3. **The namespace is a map cell on the board**, `names: { "42": <link> }`,
   and the collection's slug points at that cell. Forward resolution is a path
   read: `parseFabricUrl` already returns the slug and a one-segment path, and
   the resolver follows the slug, then the link. No segment walk is built for
   a map-backed collection.
4. **Names are decimal strings, dense from `1`**, allocated on create as one
   more than the largest name present, permanent, never reused. Members that
   predate the namespace are named in filing order by a backfill verb run
   once. A keyset read of the map conflicts with a concurrent key write
   (`docs/specs/memory-v2/08-conflict-granularity.md`), so two creators
   serialize through one retry of `editWithRetry`.
5. **A member's display name stays its title.** The number renders as a badge
   beside it, never in place of it, and every reader reaches it through the
   member's own `shortName`: an index row, a mention universe row, and a
   mention's pill all read that one property.
6. **"In text" means the editor.** Typing `#42` completes to a reference-form
   mention that shows the number. Pasted text is left alone. The `#` sigil is
   provisional: the spec leaves tags versus citations open.
7. **The board publishes a machine-readable `naming` declaration.**
8. **Models.** Fable implements until Mike says otherwise.
9. **Slug names.** `top` names the namespace; `topics` may name the board
   root.
10. **Estuary is untouched**, read-only calls included, until Mike directs.
    Deployment and the production backfill are Mike's steps, rehearsed on a
    clone first.
11. **The work lands in `packages/patterns/collection-naming/`**: `naming.ts`
    (the library a collection pattern calls), `board.tsx` and `item.tsx` (the
    exemplar the demos run on), and tests. `packages/patterns/topics` is not
    edited until S6.
12. **The Topics-shape rehearsal is a test-only board** in that directory,
    composing the real `Topic` from `../topics/topic.tsx` unmodified through
    the library. Board-side naming is proven there. Item-side display is
    proven on the exemplar item and grafted onto `topic.tsx` in S6.
13. **Index rows are the members.** Ruled 2026-09-03: the exemplar's index
    rows are the members themselves, as Topics' are, and a name reaches a row
    through the member's `shortName` with a default; the rehearsal over the
    unmodified Topic proves naming through the names table and the reverse
    lookup. A name therefore reaches a row only through the member's own
    `boardNames`, which `addItem` wires and no later write can supply: a
    parent holds its member's result, while `boardNames` is the member's
    argument. So a backfill on a board whose members were filed past the
    create must be paired with a one-time link-bind of `namesTable` onto each
    of them, the same operator step Topics states for `mentionable`. S6
    carries that step into the Topics graft.

14. **Per-member wiring is restructured, and the retrofit cost is not the
    reason not to.** Ruled 2026-09-06. A member reaches its board's derived
    tables as an argument the board wires at creation, and a board writes a
    member's result but never a member's argument — so each new such input
    needs one `cf piece link` per existing member. Three inputs now do:
    `mentionable`, `boardCrossrefs`, `boardNames`. Decision 13 accepted that
    cost for the third on the grounds that the first had already paid it,
    which is a coincidence used as a precedent.

    The ruling is that a member taking one input naming its board, and
    deriving the tables from it, is the design to pursue, and that the
    expense of updating existing topics is not an argument against it:
    topic performance is improving continuously, and a slow retrofit is a
    cost worth paying once for a shape that ends the per-input bind.

    One thing the ruling does not settle, because it is a different cost:
    the mention-index break measured a *runtime* multiplication — 8.17 MB
    and 6,203 documents, 82% of a topic resume frame — when a per-member
    input reached the raw topics list. The same record names what contained
    it: the demand shape steers the walk, not the link. So the implementation
    must declare a board-demand that reaches only the derived tables, and
    that narrowness has to be measured rather than assumed. That is an
    implementation guard, not a gate on the decision.

## Gates and review

Every stage runs `deno fmt --check`, `deno lint`, `deno task check`, and
`deno task test` in the packages it touched; `deno task cfcheck` when a pattern
changed; and the gates in `AGENTS.md` § Automated gates that its files reach —
`check-command-docs` and `check-completion-slots` for a `cf` option,
`check-no-waitfor` for a test, `check-docs` for a document. Codex reviews each
round through `stage-loop`. Nothing merges without Mike.

## Stages

### S1 — The library and the exemplar board own a member namespace

Scope: `packages/patterns/collection-naming/` (new): `naming.ts`, `board.tsx`,
`item.tsx`, `topics-shape.test.tsx`, unit tests, `README.md`.

1. `naming.ts` exports what a collection pattern calls: allocate the next
   name inside an action, the names table lift (one row per member,
   addressed by the member), a backfill over an existing list, and the
   `naming` declaration type. Nothing in it names topics.
2. The exemplar board's `addItem` allocates the next name in the same atomic
   write as the append: the created item is reachable at `names[<n>]`, and
   the result row carries `name`.
3. Names are decimal strings, dense from `1`, one more than the largest name
   present, never reused. An item keeps its name whatever happens to it.
4. Two overlapping `addItem` calls end with distinct consecutive names. A
   test drives the overlap through the runtime's retry; if the harness cannot
   express the overlap, the allocator is tested against a stale read and the
   limitation is recorded here. Recorded: the pattern-test harness runs one
   runtime and dispatches events one at a time, so two `addItem` calls never
   overlap in it, and the multi-user harness runs its participants
   concurrently but offers no step that forces two of their events to
   overlap. `naming.test.tsx` tests the allocator against a stale read on one
   map cell instead: a first allocation, a concurrent writer's key landing,
   and a re-run over the map as the winner left it, which takes the next
   distinct name.
5. A backfill verb names every unnamed member in filing order, skips named
   ones, and is idempotent: a second run writes nothing.
6. Index rows are the members, declared through a row demand that carries
   `shortName` with a default, so a board holding older members still reads
   whole.
7. The exemplar item renders its own name from the board's names table,
   wired at creation the way Topics wires `boardCrossrefs`; an item without
   the wiring shows no name and does not fail.
8. The board publishes `naming`: `{ name?, policy: { unique, permanent,
   reuse, allocator }, compact }`. `compact` is reserved: it declares that the
   member names hold no hyphen, and no renderer offers the compact spelling.
   Nothing reads the declaration at all —
   [#6986](https://github.com/commontoolsinc/labs/issues/6986) is making one
   consumer real.
9. Allocation reads the namespace's keys without expanding any member: the
   declared schema holds the values as unread references.
10. The Topics-shape rehearsal passes: a test-only board over the unmodified
    `Topic` pattern, wired through `naming.ts`, allocates on create,
    backfills a pre-existing list, and proves the names-table lookup and the
    reverse lookup for a given topic. `topic.tsx` and `topics/main.tsx` are
    untouched by the stage.
11. `README.md` describes the library and the exemplar; `cfcheck`, pattern
    tests, and coverage green.

Demo: local dev server. Two `cf piece call addItem` on the exemplar board
return names `1` and `2`; `cf cell get /of:$BOARD names` lists both keys; the
Topics-shape test is green in the same run.

### S2 — `top/42` resolves at the CLI

Scope: `packages/piece/src/slugs.ts`, `packages/runner/src/slug-resolution.ts`,
`packages/cli` (`set-slug`, README, completion table).

1. `cf piece set-slug top <board>/names` writes a slug at a non-root path,
   and `cf piece slugs` lists it, naming the containing piece. Both demos run
   on the exemplar board.
2. A reference that names a collection and then a member resolves to that
   member: `cf cell get /@<space>/top/42 title`,
   `cf piece describe --cell /@<space>/top/42`, and
   `cf piece call --cell /@<space>/top/42 <verb>` all reach it. A reference
   that stops at the collection refuses, naming the piece that holds it. The
   walk lives in `resolvePieceReference`, which takes an address and the path
   written after it; `resolvePieceAddress` is its no-path case and refuses a
   collection, because a caller holding an address alone has nothing to walk
   with.
3. A slug resolving to a non-piece with no further path fails with a message
   naming the containing piece.
4. `/@<space>/top/999` fails with "no member 999 in top".
5. Unit tests in `packages/piece/test/slug.test.ts` and `packages/cli/test`.

Demo: `cf cell get /@<space>/top/2 title` on the local exemplar board.

### S2b — Assignment refuses by default

The first half of the spec's step 2.

1. `set-slug` on a bound name refuses and names the current target; `--force`
   steals — every bound name, including one whose value is a link cycle,
   which is the state an operator forces to escape. That last case rests on
   the redirect write carrying a schema: a write handle with none resolves
   the value it is about to replace to find one, and resolving a cycle
   throws. The schema names nothing to follow, so the write pulls the one
   document it writes, and only the redirect write carries it.

   The check is a claim inside the transaction: a test with two writers has
   exactly one win. Recorded, after three attempts to describe the
   interleaving a one-runtime test achieves: it does not pin one, and the
   paragraph should not claim one. Two things are true and both are tested.
   The single-runtime test asserts the outcome — two assignments of one free
   name leave exactly one holder — and its assertions hold however the two
   were ordered. The racing path is a runtime guarantee, pinned by the
   cross-session pair: the claim's read joins the commit's read set, so a
   commit another writer overtakes is rejected and `editWithRetry` re-runs
   the body against what that writer left, which then declines. That is the
   shape `packages/runner/src/ensure-space-root.ts` states for the space
   root.
2. Whether a synced read inside `editWithRetry` becomes a commit precondition
   is settled by that test and recorded in the spec's open-questions list.
3. `--force` has a completion slot and a README sentence, on both commands
   that assign a name: `set-slug` and `piece new --slug`.
4. A caller whose own rule about a free name is wider than the library's
   carries that rule's answer into the transaction as `takeFrom` rather than
   forcing over what it read. Forcing after a standalone read spends the
   claim — two callers that both read a name as free would both take it — so
   the rule and the claim are held at once, and two concurrent callers still
   end with one holder whichever notion of free they hold.

What a forced reassignment leaves behind. Taking a name now clears the `slug`
entry from the document it takes it from, in the transaction that writes the
new redirect, so no piece is left claiming a name it no longer holds. What
remains is structural and still step 1's: the entry is single-valued, so a
document reachable under two names only ever claims the later one, and a name
pointing inside a piece stamps no entry at all, which leaves a
collection-targeted name absent from the reverse map. S3 renders URLs from
that map, so those two shape what it can say about a member.

### S3 — The shell opens `/<space>/top/42`

Scope: `packages/navigation` (the member in a view and its URL),
`packages/runtime-client` (the resolution the worker answers),
`packages/lib-shell` (the hop that carries it, and the piece cache it keys),
`packages/shell`, and shell integration tests.

1. `/<space>/top/42` opens the member piece; the tab shows its title. The
   exemplar item is the member; the Topics-shape test covers the board side
   only.
2. `/<space>/top` opens the board, the piece containing the namespace.
3. `/<space>/top/999` shows a not-found state naming the collection.
4. The item's own header shows the number, and the shell's header offers a
   copyable portable reference `/@<space>/top/42`; board cards show the
   number. (Two headers, which is how this was read when the criterion was
   delivered and accepted: the badge is the item pattern's, while only the
   shell knows the space and the collection's name, so only the shell can
   compose the reference.)
5. A browser integration test covers 1 and 3.

### S4 — `#42` in text

Scope: `packages/ui` cf-code-editor mention completion and pill; the exemplar
(mentionable rows and the item output both carry the member's name as
`shortName`, which is the one property the editor reads at both ends of a
mention).

1. Typing `#42` in the exemplar item's body offers the member named 42;
   picking it inserts a reference-form mention.
2. A mention pill whose destination publishes a short name shows it beside
   the label; existing mentions gain it once the destination does.
3. Autocomplete matches the number as well as the title.
4. A pasted `#42` stays plain text; the editor's documentation says so and
   why.
5. Stretch: the pill's plain-text copy is `/@<space>/top/42`.

### S6 — Graft onto Topics

Mike's call, after S4.

1. `topics/main.tsx` adopts `naming.ts` with the wiring the rehearsal board
   already carries; the diff is the rehearsal board's diff against today's
   board and nothing more.
2. `topic.tsx` gains the item-side display the exemplar item proved: the
   badge and `shortName`.
3. `TopicMentionableRow` gains `shortName` and the board copies each topic's
   own into it, which is what makes the `#42` trigger live on the deployed
   board — until then it matches nothing there, because a Topics universe row
   carries no such property. The exemplar's `mentionableRowsOf` and
   `mentionableIndex` are a fork of the Topics pair differing only by that
   property, so this step is where the fork ends: one of the two goes, and the
   survivor is the one both boards derive their universe through.

   Recorded: the survivor is one derivation, `mentionableIndex` and
   `mentionableRowsOf` in `packages/patterns/collection-naming/mentionable.ts`,
   which both boards import; `MentionableRow` is the row type both publish, and
   `TopicMentionableRow` and `ItemMentionableRow` are gone. Neither board could
   import the other's copy: a pattern module carries its imports into its own
   compiled program, so the exemplar would ship the Topics board or Topics
   would ship the exemplar. It is not in `naming.ts` either, because that
   module never reads through a member and this derivation reads three display
   strings off each one.
4. The production backfill is rehearsed on a clone per
   `../development/space-clone-rehearsal.md`; the deployed vintage includes
   #6827 before the backfill runs. One decision items 1-3 could not make for it
   stands: a topic filed before the namespace reads its name only once
   `namesTable` is link-bound onto it, and nothing in a pattern can reach a
   member's argument to do that. The rehearsal of 2026-09-05 measured that step
   end to end and is recorded at
   `../history/plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md`:
   `backfillNames` writes the name into the board's map, the topic goes on
   reading none, and one `cf piece link` per topic closes it. The operator
   procedure is the "Naming the Topics that predate the namespace" section of
   `skills/topics/SKILL.md`.

   **Held 2026-09-06, and not for a technical reason.** The step is rehearsed
   twice; the second run, after the positional-link fix, is recorded at
   `../history/plans/collection-naming-s6-backfill-rehearsal-rerun-2026-09-06.md`
   and measured what the first could not. On a clone holding three topics, the
   forced board deploy verified `removed 0`, moved the board's argument
   document by one key (`names: {}`), and left those topics' titles and bodies
   intact; the mention-index transition cost eleven commits and one written key
   per topic. Three topics is not 125, and the record says which of its figures
   scale and which are counts of that run. What is missing is not a measurement
   but a demand — nobody has asked for named Topics on the deployed board.

   The sequence that makes running it routine rather than a one-way door,
   whenever consensus appears:

   1. Fix #6969 first. `setsrc --check` exhausts the heap against the
      deployed board, so today the live board cannot be inspected before it
      is written to. That is the only step that converts this into a
      checkable operation, and it is worth doing whether or not the graft
      runs.
   2. Deploy the board leg, which is refused over topics filed before the
      namespace and needs `--dangerously-allow-incompatible-schema` until a
      general mechanism for adding a property to existing data exists.
   3. Update each topic to a pattern whose input schema selects `boardNames`.
      Backfill, then bind `namesTable` onto each topic `addTopic` did not wire.
      The link command accepts declared inputs before they hold values;
      `--allow-non-existing` cannot override a topic's input schema (#6965).
      Run it from a host: laptop runs died 4-6 minutes in during the
      2026-08-28 migration.
   4. Verify by reading both the board's index and the member addresses. In
      the rerun the fixed board's index agreed with its members at all three
      reads; the two reads that disagreed were on the instrument board
      carrying the walk #6987 replaced, and no run there attributed the
      staleness to a mechanism. So the rerun establishes no divergence for the
      code this graft deploys, and no cause for the one it saw. Reading both
      is what would show a divergence if one appeared, and costs a command.

   **The board leg of the deploy needs
   `--dangerously-allow-incompatible-schema`.** `setsrc --check` refuses it over
   a board holding topics filed before the namespace, with
   `input link at topics.0.shortName: an unconstrained schema is no longer
   accepted`. That refusal is not about `shortName`, and not about the
   property's spelling: two probes, each the pre-graft board with one property
   added to `TopicDemand` and nothing else changed, were both refused with the
   identical message at `topics.0.probeField` — `probeField?: string` and
   `probeField?: unknown` alike. The rule is on the STORED side: the schema
   recorded on a member's retained link is unconstrained at every path that
   recorded schema does not name, so a property only the candidate demand names
   is a narrowing of `true`, which is what
   `packages/piece/src/schema-compatibility.ts` refuses. Expect it for a new
   per-member demand property generally. The flag is
   held behind explicit team authorization by `skills/topics/SKILL.md`, so this
   step carries a decision it did not carry before. What the forced deploy
   leaves behind is measured, in the 2026-09-06 rerun below.

   **Why the gates said otherwise.** `deno task pattern-compat` and
   `deno task pattern-vintage` are both clean and neither can see this: the
   first judges a pattern's declared contract against the contracts it has
   declared before, the second replays the pattern's own stored documents, and
   neither examines the schema recorded on a link into a SIBLING piece — which
   is the check that fires. A gate passing is not the claim; the claim is what
   the gate examines, and the only instrument that examines this one is
   `setsrc --check` against the deployment itself.

   The board moves FIRST, which is what clears the topic leg's own
   `mentionable[].shortName` refusal; the topic leg then needs the flag once
   itself, for the mention universe narrowing to a readable handle
   (`../history/topics-mentionable-readonly-break.md`), and is proven on every
   update after that one. The deploy also needs
   `--root` at or above `packages/patterns`, because the board imports the
   naming library from a sibling directory and the default program root is the
   entry's own.
5. `skills/topics/SKILL.md` describes `top/42` addressing.

### S5 — Deferred, not scheduled

The reverse-map restructure and identity-URL rewrite to the member form;
cross-space personal bindings (`#top/42` through a home-space slug); the
compact form `top-42`; prose scanning; the tags-versus-citations sigil
decision.
