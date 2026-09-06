# Shuttle — live views

Satellite of [`README.md`](README.md): the full-screen half of the
hybrid — what opens, how it behaves, and what it reuses. Governs milestone
B3 of [`build-sequence.md`](build-sequence.md); the settle and lifecycle
disciplines it leans on are in
[`runtime-integration.md`](runtime-integration.md).

## Principles

- **A view is a lens, not a move.** Opening a view never changes the place;
  `q` returns to the prompt exactly where it was. Moving is always an
  explicit act (a `cd` from inside the view's command line).
- **Views are pure logic plus injected terminal deps**, the architecture
  `packages/cli/lib/view` already proves out: raw-mode terminal handling
  sits in one module, and state and key handling are pure and testable
  without a terminal.
- **Everything live obeys the settle discipline**: one repaint per quiet
  runtime (guard plus `idle()`), never a timer. A view's own sinks are
  canceled on exit; a watch's sink belongs to the watch, which outlives
  the view (see "Watches are session objects").
- **Views are live because reaching in warms** (the run-state rule). The
  deferred cold-browse mode ([`futures.md`](futures.md)) will reach into
  views when it lands — banner, labeled stored values, no sinks.

## The v1 views

**Value view** — `watch <ref>`. One cell or subtree, rendered as structured
JSON: scrollable, references followable, and live — a changed value briefly
shows its transition (`14 → 15`) before settling, so a change is seen
rather than inferred.

**List view** — `browse [<ref>]`. A paged listing of whatever stands below
the reference — a facet, a collection, search results. Rows carry the same
`%n` handles the prompt uses; selection moves with arrows or `j`/`k`;
inserts and removals are reflected live and marked briefly. Entering a row
drills in place; leaving restores the parent's scroll and selection.

```text
┌ estuary/board/topics ─────────────── ● live ┐
│ %1  verb contracts        replies 14        │
│ %2  migration rehearsal   replies  3        │
│▸%3  co-presence rollout   replies  8    +   │
│ …                              14 of 16     │
│ : call %3 add-reply --body "shipped"        │
└ q back · enter drill · / filter · : command ┘
```

**Piece overview** — the structured piece viewer: arguments, a result
summary, callables with their doc annotations, and pattern identity in one
frame. It renders as a snapshot with refresh on demand rather than live —
the live piece watch is deferred — so it costs no sink and ships beside
the other two.

## Watches are session objects

`watch <ref>` arms a watch — a session-level subscription with its own
handle — and opens the value view as one lens onto it. `q` closes the lens
and leaves the watch armed. While the prompt is up, an armed watch shows
its changes as **event lines**: each settled change appends one line —
`watch topics/3: replies 14 → 15` — and the prompt is redrawn beneath it,
so cause and effect interleave in one transcript that doubles as a
record. (A pinned strip rendering armed watches live above the prompt is
designed and deferred: [`futures.md`](futures.md).)

`watches` lists what is armed (`where` shows it too); `unwatch <handle>`
disarms. Terminal output that has scrolled off is never mutated: liveness
lives in the event lines, and history stays append-only.

## Keys

Small, vim-flavored, and stable: `q` back to prompt; `j`/`k`/arrows
selection; `g`/`G` ends; `enter` drill, `backspace` up; `/` filter within
the view, `n`/`N` next; `e` edit the selection in `$EDITOR` (the substrate
already suspends and restores the terminal for this); `:` opens the
command line.

`:` is the general mechanism instead of a key per verb: any shuttle
command runs with the view's `%n` handles bound to its rows, and the view
repaints on the result. On `q`, the last view's handles stay valid at the
prompt (decision 17), so "look, leave, act" needs no retyping.

## Reuse of the `cf view` substrate

`pager.ts` (raw mode, frame rendering, restore-on-every-exit), `keys.ts`,
and `ansi.ts` are the terminal layer to build on; `session.ts` is the
pattern to follow rather than import — shuttle views hold different state.
`pager.ts` is where the raw-mode coupling lives, and it is the piece
shuttle wants; `mod.ts` and `loadinput.ts` own the rest of `cf view`'s
stdio — probing whether stdout and stdin are terminals, writing plain
output, reading a piped document — which is one-shot-command concern a
shell drives for itself. Each is reached by a relative path: the shell is
this package's own code, so calling one of them costs no export entry
([`build-sequence.md`](build-sequence.md)).

One adaptation to verify early in B3: `cf view` pages a static document,
so its frame loop may be key-driven only. Shuttle views repaint on two
event sources — keys and settled runtime changes — and the loop must
multiplex them. If the substrate's loop cannot, that generalization is B3's
first work item, made in `packages/cli` where the substrate lives.

## Live discipline

- A list view observes membership through a **raw-document subscription**:
  the collection doc under the rejecting selector, links parsed from the
  raw value — and sinks deeply only the rows on screen. Element cost is
  bounded by the visible page; membership is one document whose size
  grows with the collection's link array — the linear-in-links frame
  that replaces the element-closure shape behind the 89MB sync. Schema shapes that look
  shallow to a reader do not bound what the server syncs, so this is the
  one place shuttle reads below `Cell.sink`; the seam
  (`SpaceReplica.sinkDocument`) exists but is unexercised. Issue
  [#6534](https://github.com/commontoolsinc/labs/issues/6534) carries the
  problem and the solution lanes. B3 opens by proving that seam on the
  remote path; if it disappoints, the fallback is a capped deep sink with
  an honest "watching first N" label.
- **The raw subscription serves the base scope only.**
  `SpaceReplica.sinkDocument` (`packages/runner/src/storage/v2.ts`) accepts
  no scope and keys its subscriber set with `docKey(uri, "space")` — the
  base instance — so under `@user` or `@session` it would watch base
  membership while the frame claimed to show an overlay. A list view
  therefore takes the raw subscription only when the ambient scope is the
  base, and the capped deep sink with its "watching first N" label under an
  overlay, where `Cell.sink` reads through the scope the cell carries. The
  keying vocabulary for the scope-aware version is already there — `docKey`
  takes an instance, and the load path passes
  `instance ?? normalizeCellScope(scope)` — so what has to grow a scope
  parameter is that one signature, not the storage model. #6534's seam must
  be scope-aware end to end before the raw path can serve an overlay.
- Guard-plus-`idle()` settling, per `renderVDomToHtml`'s form.
- The connection's state is visible in the frame (`● live`, cold banner,
  or a reconnecting marker), read from the relay B1 builds —
  the storage layer publishes no connection state today
  ([`runtime-integration.md`](runtime-integration.md)). On reconnect the
  memory client re-arms the watch itself, so the view resyncs and repaints
  without re-subscribing.

## Open questions

1. When the piece overview gains liveness — deferred with the live piece
   watch. (The shallow-sink question is settled above: not expressible
   through `Cell.sink`; the raw-document seam and its proving gate are
   issue [#6534](https://github.com/commontoolsinc/labs/issues/6534).)
2. The pinned strip's layout — deferred with the strip itself
   ([`futures.md`](futures.md)).
