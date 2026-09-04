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
| S1b — index rows are the members | built, in review |
| S2 — `top/42` resolves at the CLI | built, in review |
| S2b — assignment refuses by default | not started |
| S3 — the shell opens `/<space>/top/42` | not started |
| S4 — `#42` in text | building |
| S6 — graft onto Topics | not started; Mike's call after S4 |
| S5 — deferred, not scheduled | — |

## Decisions, ruled 2026-09-03

Each of these was a question with a recommendation; the recommendation was
ruled. A later reversal is a decision recorded here, not a discovery.

1. **The citation form follows the cell reference grammar.** The fully
   qualified citation is `#//topics-dev/top/42`. The spec's `#@space/...`
   spelling is amended when that grammar lands. Part 1 of the spec, which
   governs addressing, is unaffected.
2. **The reverse-map restructure and the cross-space slug target are
   deferred.** A board-owned namespace never writes the piece's single `slug`
   metadata entry, so that restructure gates URL rewriting rather than
   naming. Nothing here rewrites an identity URL to the member form, and no
   personal binding is built.
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
   reuse, allocator }, compact }`.
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
2. `resolvePieceAddress` accepts a slug whose target, after the path, is a
   link to a piece: `cf cell get //<space>/top/42 title`,
   `cf piece describe --cell //<space>/top/42`, and
   `cf piece call --cell //<space>/top/42 <verb>` all reach the member.
3. A slug resolving to a non-piece with no further path fails with a message
   naming the containing piece.
4. `//<space>/top/999` fails with "no member 999 in top".
5. Unit tests in `packages/piece/test/slug.test.ts` and `packages/cli/test`.

Demo: `cf cell get //<space>/top/2 title` on the local exemplar board.

### S2b — Assignment refuses by default

The first half of the spec's step 2.

1. `set-slug` on a bound name refuses and names the current target; `--force`
   steals. The check is a claim inside the transaction: a test with two
   writers has exactly one win.
2. Whether a synced read inside `editWithRetry` becomes a commit precondition
   is settled by that test and recorded in the spec's open-questions list.
3. `--force` has a completion slot and a README sentence.

### S3 — The shell opens `/<space>/top/42`

Scope: `packages/shell`, `packages/runtime-client`, shell integration tests.

1. `/<space>/top/42` opens the member piece; the tab shows its title. The
   exemplar item is the member; the Topics-shape test covers the board side
   only.
2. `/<space>/top` opens the board, the piece containing the namespace.
3. `/<space>/top/999` shows a not-found state naming the collection.
4. The item header shows the number and a copyable portable reference
   `//<space>/top/42`; board cards show the number.
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
5. Stretch: the pill's plain-text copy is `//<space>/top/42`.

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
4. The production backfill is rehearsed on a clone per
   `../development/space-clone-rehearsal.md`; the deployed vintage includes
   #6827 before the backfill runs.
5. `skills/topics/SKILL.md` describes `top/42` addressing.

### S5 — Deferred, not scheduled

The reverse-map restructure and identity-URL rewrite to the member form;
cross-space personal bindings (`#top/42` through a home-space slug); the
compact form `top-42`; prose scanning; the tags-versus-citations sigil
decision.
