# Shuttle — a place-aware fabric shell

Status: v1 design settled — the decisions below are ruled, and nothing
blocks construction. Nothing here is built yet; the order of construction is
[`shuttle/build-sequence.md`](shuttle/build-sequence.md). This document
stays the working design state: new decisions land here as they are made.

Shuttle is an interactive terminal tool for exploring and editing fabric
state: a line-oriented REPL whose prompt carries a mutable **current place**,
plus full-screen live views that open on demand and drop back to the prompt.
The codename is the loom's shuttle — the part that travels back and forth
through the warp carrying the weft — beside the user-facing shell's "weaver".

```text
shuttle estuary/board> ls
  topics/ (16)   members/ (11)   settings
shuttle estuary/board> watch topics/3
┌ topics/3 ──────────────────── ● live ┐
│ title    "verb contracts"            │
│ replies  14 → 15                     │
│ updated  just now                    │
└── q: back to prompt ─────────────────┘
shuttle estuary/board> call topics/3 add-reply --body "hi"
```

## Why

Every `cf` invocation names the whole world. The target surface — api-url,
identity, space, piece — has a single definition (`targetOptions` in
`packages/cli/commands/piece.ts`) and recurs across nearly every command;
`CF_API_URL` and `CF_IDENTITY` absorb two of its members and the rest are
retyped per command. Composition between commands is copying an address one
command printed into the next (the composition axis of
[`../common/verbs/session-walkthrough.md`](../common/verbs/session-walkthrough.md)).

The fabric's canonical reference grammar already treats context as
first-class. A reference is right-anchored —
`/[@did:key:…/]of:fid1:<id>[@scope][/path…][#argument]`, documented at the
top of `packages/cli/lib/llm-friendly-ref.ts` — and omitted levels are
supplied by context. Today that context is flags and two environment
variables. Shuttle makes it a mutable, navigable value: **a place is the
context that fills in the omitted levels of a reference.**

[`cli-surface-shape.md`](cli-surface-shape.md) step 8 records the same
observation for the space alone: "a parameter that is required everywhere and
identical across a working session is one a caller should state once."
Shuttle generalizes that from the space to the whole prefix, inside one
interactive process.

Reading state today is one-shot prints, the FUSE mount, or the offline
inspector. The substrate is reactive; none of those show a value changing.
The live-view half exists to make reactivity visible.

## Settled decisions

1. **Shape: hybrid.** A REPL is the spine — a prompt showing the place, line
   commands that print and return. Full-screen live-updating views (`watch` a
   cell, browse a collection) open on demand and return to the prompt. The
   prompt serves composition and muscle memory; the views serve the
   browse-and-observe loop a reactive substrate deserves.
2. **Home: a new workspace package** (working name `packages/shuttle`),
   importing `cli` and `runner` plumbing as libraries. Not a `cf` subcommand.
3. **Audience: the operator at the keyboard.** Power use first; teammates
   second, served by completion, help, and forgiving defaults. Agents and
   demo audiences are not v1 targets, and no decision may preclude them.
4. **First workflows: inspecting live state, and browsing + editing data**
   (navigate, read, set, call, wish). The pattern-development inner loop and
   bulk operations are possible futures the design must leave open, not v1
   targets.
5. **Place model: reference prefixes plus named entry points.** A place is a
   prefix of the canonical reference — a space, a piece, a path under a piece
   — and named entry points (wish targets such as `#favorites`, slugs, space
   names) are navigable: `cd #favorites` works, and `cf wish` already
   resolves those targets headlessly. Virtual places — standing inside a
   search result, a survey's holders, a filtered collection — are a designed
   extension: the place abstraction must not assume a place is only a
   prefix.
6. **Ambience: shell-private, passed explicitly.** The place lives in the
   shell process. One-shot `cf` outside the shell is untouched. A `cf`
   command run from inside the shell receives the place explicitly — context
   injected into that invocation — never by mutating environment variables.
   The ambient record is one serializable value with one owner module, so
   a later ambient adoption (step 8's `CF_SPACE`, or a fuller `CF_PLACE`)
   can reuse the representation without redesign.
7. **Vocabulary: navigation verbs plus `cf` verbs.** Navigation is
   shell-native (`cd`, `ls`, `pwd`, `watch`, …). Data verbs are exactly the
   `cf` ones (`get`, `set`, `call`, `wish`, `verbs`, `describe`, …) with the
   place filling in target options, so knowledge transfers in both
   directions between the shell and one-shot `cf`.
8. **Codename: shuttle.**
9. **Execution model: in-process, with a `!cf` escape.** The shell's own
   verbs call the same library seams `cf`'s commands do, over one persistent
   runtime connection that the live views share for their subscriptions. A
   `!cf …` escape spawns the real binary with place-derived flags injected,
   covering the rest of the surface. The known risk is drift where `cli`
   code is not yet factored as callable seams; the answer is to factor the
   seam in `cli`, not to reimplement the verb in shuttle.
   [`shuttle/runtime-integration.md`](shuttle/runtime-integration.md) grounds
   this decision: the connection and watch mechanics that exist, the
   lifecycle discipline a long-lived process adds, and the prerequisite seam
   work in `packages/cli`.
10. **Run state: entering warms.** `cd` into a piece (or `watch`) starts the
    pattern in-process and reads inside it are live; pieces merely listed
    stay cold. A cold-browse mode — unmistakably visible in prompt and views
    — walks the space with no computation, serving labeled stored state.
11. **A space root lists facets, never pieces directly** — `slugs/`,
    `pieces/`, and `fuse/` (the FUSE layout mirrored, leveraging
    `packages/fuse` rather than reinventing it). Facet names are reserved at
    the space root only.
12. **A view is not necessarily a place.** Pagination and search produce
    views to look at and pick from; they need no path-shaped address unless
    one earns it (the virtual-places extension of decision 5).
13. **Prompt and naming: checked names only, fabric's mechanisms only.**
    Space names and slugs are shown when an index confirms them, shortened
    unique ids otherwise; shuttle introduces no naming layer of its own.
14. **Writes: inline value, editor, explicit links.** `set` takes a JSON
    value on the line (stdin via `-`); `edit` opens `$EDITOR` on the current
    value; `link` is the only spelling that creates a reference rather than
    copying a value.
15. **Externals are schemed; nothing outside the fabric is a default.**
    Redirection targets fabric paths; a local file is always spelled
    `file:…`, and `file:` is one member of an open scheme family (`https:`
    sources work; external writes wait for a use). Beside the place shuttle
    tracks one **external working location**, schemed like its operands:
    `xcd` sets or relative-moves it, `xpwd` prints it.
16. **Pipelines: a published native tool set, and escaped locals.** Names
    in the native set (`jq`, `grep`, `wc` among the first) work bare and
    are guaranteed wherever shuttle runs — a native tool may start as a
    forward to a local binary, but that is implementation, not contract.
    Arbitrary local programs need an explicit escape, so leaving the
    portable surface is always visible on the line.
17. **Numbered handles.** Listings number their rows and `%n` is a
    reference until the next listing — the mechanism by which a view
    (decision 12) feeds the next command without being a place.
18. **`!` means local, everywhere.** Line-initial `! <cmd>` runs a local
    program, `|!` is the same escape inside a pipeline, `!cf` the special
    case that injects place-derived flags.
19. **The binary is `shuttle`.** The codename is the name; aliases and
    completion absorb the length.
20. **Scope is the cwd's second dimension.** Per-identity overlays
    (`@user`, `@session`) are a way of seeing every place, so the cwd is
    the pair (position, scope): both stick across navigation, both render
    in the prompt, and `pwd` prints both. `cd` is the door to both —
    `cd board@session` moves both, `cd @session` scope alone, `cd @space`
    back to the base (all verified in the canonical grammar) — there is no
    separate scope verb, and an explicit suffix on an operand overrides
    the ambient scope for that operand. A suffix names only the reading
    identity's own overlays; standing in another identity's overlay is a
    canonical-grammar extension, out of v1.
21. **The native tool set v0** is `jq`, `grep`, `wc`, `head`, `tail`,
    `sort`, `uniq`, `cut` — grown by ruling. `cat` is deliberately absent:
    `get` prints, `< file:…` feeds, and concatenation waits for a demand.
22. **`where` is the ambient context's one surface.** Every dimension —
    connection, cwd pair, external location, browse mode, invocation
    session — prints in `where`, and `where <dimension> <value>` sets any
    of them; the heavyweight ones rebuild the connection and say so.
    `cd`/`xcd` are conveniences over the hottest dimensions; launch flags
    seed the initial record.
23. **A scheme is legal only on an absolute complete path.** Relative
    external operands are rooted with the `x:` base (`> x:../out.json`) —
    a base name, not a scheme — and a bare relative operand is always
    fabric, so no operand ever changes plane by position.
24. **Pagination: height-fit pages, and `more` continues.** `ls` prints
    one terminal-height page plus a status line and never escalates to a
    view uninvited; `more` continues the listing and its handle numbering,
    so a run's handles stay valid until a new listing resets them.
25. **List views watch membership raw, elements deep, window only.**
    Reader schemas cannot express a membership-only subscription (verified
    — shapes that look shallow to a reader do not bound what the server
    syncs), so membership comes from a raw-document subscription on the
    collection doc and only visible rows sink deeply — cost bounded by
    page size, never collection size. The seam and solution lanes are
    issue [#6534](https://github.com/commontoolsinc/labs/issues/6534); B3
    opens by proving the seam, and falls back to a capped deep sink with
    an honest label if it disappoints.
26. **The piece overview ships structured, not live.** One frame —
    arguments, result summary, callables, pattern identity — rendered as a
    refreshable snapshot in B3; the live piece watch is deferred.

The line grammar itself — resolution rules, facets, listings, run-state and
write surfaces, and the redirection/pipe proposals — is drafted in
[`shuttle/grammar.md`](shuttle/grammar.md). The full-screen views are
designed in [`shuttle/views.md`](shuttle/views.md). The order of
construction — the `cli` seam PRs and the shuttle milestones they gate — is
[`shuttle/build-sequence.md`](shuttle/build-sequence.md).

## The ambient model

The ambient context is one record:

- **Connection**: api endpoint, identity.
- **The cwd pair**: position (space, optionally a piece, optionally a path
  inside it) and scope.
- **External working location**, **browse mode**, **invocation session**.

`cd` accepts relative path segments, `..`, absolute canonical references,
slugs, space names, wish targets, and scope suffixes. Every reference a
command takes resolves against the cwd; an absolute reference always works
and never depends on it. The prompt renders position and scope compactly
(an elided alias is checked against the target's declared name, never
guessed).

One place at a time in v1, but no global singleton: the implementation keeps
place-per-instance so multiple places (tabs, split views, an agent holding
several) stay reachable later.

## What exists to build on

| Component | Where | What it gives shuttle |
| --- | --- | --- |
| Canonical + alias reference grammar | `packages/cli/lib/llm-friendly-ref.ts` (doc comment), runner's `parseLLMFriendlyLink` | The address syntax; shuttle consumes it and must not fork it |
| Target option surface | `targetOptions` in `packages/cli/commands/piece.ts` | The enumeration of exactly what a place must supply |
| Live-state completion | `packages/cli/lib/completion/providers.ts` (`cellPathCandidates`, `childKeys`, verb candidates with doc comments) | The `ls` primitive and tab completion, already written against live state |
| Pager/TUI substrate | `packages/cli/lib/view/` — `pager.ts` is the only module touching the TTY; `keys.ts`, `ansi.ts`, `render.ts`; `session.ts` holds state as pure logic | The full-screen half: raw mode, frames, key decoding, testable without a terminal; already follows references and edits buffers |
| FUSE mount | `packages/fuse` | The same addressing as a POSIX filesystem; prior art for layout (arrays as numeric directories, handlers as executables, links as symlinks). Shuttle is its interactive, live sibling, not a replacement |
| Offline inspector | `packages/state-inspector`, `cf inspect` | The forensic counterpart (snapshots, scopes, history); its HTML explorer is prior art for tree-plus-detail browsing |
| Entry-point resolution | `cf wish` | Headless resolution of `#favorites`-style targets — the mounts of decision 5 |
| Web shell route grammar | `packages/shell` routes `/<space>/<piece>` | Another spelling of place; keep them mutually translatable |

## Relationship to the CLI surface arc

Shuttle rides the addressing decisions of
[`cli-surface-shape.md`](cli-surface-shape.md) rather than making its own:

- Step 8 (`CF_SPACE` ambient) is the one-shot cousin of decision 6; the
  serializable place is the shared seam.
- Step 9 (space by name, piece by slug, positionally) is what `cd` and the
  prompt want — names, not hashes. Shuttle should consume that work, not
  duplicate it.
- The duplicated nouns that plan records (two `inspect`s, two `view`s) are
  words shuttle must not add a third meaning to.

Word hazards, so shuttle does not add to them: "shell" names the web
frontend; "session" already carries three meanings (invocation session,
process connection, `@session` cell scope) — shuttle says **place** and
**connection**; "collection" means an array path inside a holder piece
(`cf piece survey`), and shuttle uses it only that way.

## Open questions

None blocking v1. The B3 seam-proving gate and its two preparatory
experiments are recorded in decision 25 and issue
[#6534](https://github.com/commontoolsinc/labs/issues/6534); the piece
overview's liveness is deferred with the live piece watch
([`shuttle/views.md`](shuttle/views.md)).

## Non-goals for v1

- Not an agent surface (stable machine-readable output, one-shot scripting)
  — leave the door open.
- Not a bulk-operations or migration driver — leave the door open.
- Not a replacement for `packages/fuse`, `cf view`, or `cf inspect`.
- No persisted cross-process ambient place, and no environment-variable
  mutation, ever.
- Not a hosted or remote terminal — but shuttle must not assume a local
  execution environment exists, so it can become reachable from one later.
  The native-versus-escaped pipeline split (decision 16) is that
  constraint's first tooth.
