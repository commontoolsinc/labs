# Shuttle — futures

Satellite of [`../shuttle.md`](../shuttle.md): the trajectory past v1.
Nothing here is v1 scope and nothing is a commitment to build order. The
positions are taken now so that later features land coherently with the
settled decisions; the candidates are ranked leads, to be ruled when their
turn comes.

## Positions

**Configuration lives in the fabric.** Command aliases and shuttle
preferences belong in a piece under the user's profile, not in a dotfile:
they then follow the user to any terminal, including the eventual hosted
one with no local disk — the same portability constraint the
native-versus-escaped pipeline split already serves. How the first
connection bootstraps before configuration loads is the open detail.

**Bookmarks are favorites.** A local bookmark file would be a
shuttle-private naming layer, which decision 13 forbids — and the fabric
already has named entry points. A `bookmark` verb writes through the wish
machinery to the user's favorites, and `cd #<name>` is already the
spelling that reaches them. Bookmarking is a fabric feature shuttle uses,
not a shuttle feature.

**The session scope is the variable store.** `@session` scoped cells are
per-user, per-session, durable, inspectable, and reactive — and redirects
already write values into the fabric, so
`get big --filter … > scratch/result@session` is assignment. A `$name`
spelling can be pure sugar over a session-scoped scratch area. Shuttle
adds spelling, never a private interpreter heap: script state is then
debuggable by the same acts as any other state. Where the scratch area's
home piece lives is the open detail.

**Scripting comes in three layers, and stops there.**

1. Linear command files: `shuttle -c '…'` and `#!/usr/bin/env shuttle`
   scripts (the `cf exec` shebang is the precedent). No control flow.
2. Real programs: the seams shuttle calls are importable libraries, so
   control flow means a TypeScript file using the same API — perhaps
   `run script.ts` handing it the ambient record. Shuttle never grows a
   script language of its own.
3. The stance underneath: recurring automation that lives with the data
   belongs inside the fabric as a pattern or verb — reactive, durable,
   shareable. Scripting is for driving the fabric from outside.

The scripting bundle is also the agent door the non-goals hold open:
stable machine-readable output, exit-code discipline, and deterministic
non-TTY behavior (no views, no strip) arrive with it, not before.

## Candidates, ranked

1. **The weaver bridge.** `cd <weaver-URL>` lands in that piece one layer
   down; a `weaver` verb emits the URL for the current place (or a
   handle: `weaver %3`) to jump a layer up. The route grammar is already
   in the prior-art table as mutually translatable; this makes the
   two-layer story concrete in both directions.
2. **Write guards.** Cold-browse mode is compute-cold, not write-safe. A
   `where writes off` dimension, and per-space protection — shuttle
   refuses writes to a marked space until explicitly armed — encode the
   local, rehearsal, production discipline into the tool.
3. **History and records.** Persistent, searchable command history; a
   `record` verb writing the transcript to a `file:` target or into the
   fabric. The event-line design already makes transcripts evidence;
   this makes them saveable.
4. **Time and diff.** `history <ref>` and `diff` across time or between
   references — the state inspector's reconstruction machinery is the
   offline prior art — plus a modest `undo` that writes back what the
   session last saw, honest about concurrent writes.
5. **Small muscle memory.** `pushd`/`popd` on the place stack;
   `watch --bell` and `--notify` (local side effects, marked as such); an
   opt-in `--resume` restoring the user's own last ambient record — which
   is not the persisted cross-process ambience the non-goals rule out,
   and the line between the two is drawn here on purpose: resume hands
   one shuttle its own past, never another tool the session's present.
