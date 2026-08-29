# Shuttle — live views

Satellite of [`../shuttle.md`](../shuttle.md): the full-screen half of the
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
  runtime (guard plus `idle()`), never a timer. Sinks are canceled on view
  exit.
- **Cold-browse mode reaches into views**: an unmistakable banner, stored
  values labeled as stored, no sinks, no warming; `r` re-pulls stored state
  (a storage read, not a pattern run).

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
│ : call %3/add-reply --body "shipped"        │
└ q back · enter drill · / filter · : command ┘
```

**Piece overview** — the structured piece viewer: arguments, a result
summary, callables with their doc annotations, and pattern identity in one
frame. It renders as a snapshot with refresh on demand rather than live —
the live piece watch is deferred — so it costs no sink and ships beside
the other two.

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
shell drives for itself. The export entries for these modules land with B3.

One adaptation to verify early in B3: `cf view` pages a static document,
so its frame loop may be key-driven only. Shuttle views repaint on two
event sources — keys and settled runtime changes — and the loop must
multiplex them. If the substrate's loop cannot, that generalization is B3's
first work item, made in `packages/cli` where the substrate lives.

## Live discipline

- A list view observes membership through a **raw-document subscription**:
  the collection doc under the rejecting selector, links parsed from the
  raw value — and sinks deeply only the rows on screen, so cost is bounded
  by page size rather than collection size. Schema shapes that look
  shallow to a reader do not bound what the server syncs, so this is the
  one place shuttle reads below `Cell.sink`; the seam
  (`SpaceReplica.sinkDocument`) exists but is unexercised. Issue
  [#6534](https://github.com/commontoolsinc/labs/issues/6534) carries the
  problem and the solution lanes. B3 opens by proving that seam on the
  remote path; if it disappoints, the fallback is a capped deep sink with
  an honest "watching first N" label.
- Guard-plus-`idle()` settling, per `renderVDomToHtml`'s form.
- The connection's state is visible in the frame (`● live`, cold banner,
  or a reconnecting marker); on reconnect the view resyncs and repaints.

## Open questions

1. When the piece overview gains liveness — deferred with the live piece
   watch. (The shallow-sink question is settled above: not expressible
   through `Cell.sink`; the raw-document seam and its proving gate are
   issue [#6534](https://github.com/commontoolsinc/labs/issues/6534).)
