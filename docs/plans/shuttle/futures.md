# Shuttle — futures

Satellite of [`README.md`](README.md): the trajectory past v1.
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

## Deferred from v1, design settled

Each of these was ruled during the v1 design and then deferred past v1 to
keep the first build small. The designs are settled — recorded here so
they are re-scheduled later, never re-litigated — and the main document's
decisions point here where they defer.

- **The pinned strip.** A reserved region above the prompt renders armed
  watches' current values live while scrollback flows past. Event lines
  carry the arm-then-act loop in v1; the strip returns when watch density
  demands it. Open: its height, and what it shows when more watches are
  armed than fit.
- **Cold-browse mode.** Walking around with no computation: reads serve
  stored state, labeled as such, with the mode unmistakable in the prompt
  and every view, toggled as a `where` mode dimension. It insures against
  a warming cost not yet observed; reaching-in-warms already leaves merely
  listed pieces cold, which is v1's whole run-state story.
- **The native tool set.** Published names that work bare in a pipeline
  and are guaranteed wherever shuttle runs — a native tool may start as a
  forward to a local binary; that is implementation, not contract. The
  v0 list: `jq`, `grep`, `wc`, `head`, `tail`, `sort`, `uniq`, `cut`,
  with `cat` deliberately absent (`get` prints, `< file:…` feeds, and
  concatenation waits for a demand). Until the set ships, bare `|` is
  reserved and its error names `|!`, so nobody learns an invisible local
  habit v1 would have to unteach.
- **`where` editing the heavyweight dimensions.** Switching api endpoint
  or identity mid-session, rebuilding the connection and saying so. v1
  fixes them at launch, the space too (decision 22) — restarting is the
  switch — which also honors the one-connection-per-process limit the
  seam work records.
- **The `fuse/` facet.** The FUSE layout mirrored at the space root, for
  mutual legibility between the two tools. Shuttle reuses `packages/fuse`
  naming and hydration work regardless; the facet is the presentation
  half, and it waits.
- **Fabric-to-fabric redirection.** `get topics/3 > drafts/copy` as a
  value copy, with `link` remaining the only reference-writer. The plane
  grammar — bare relative operands are fabric, schemes are explicit — is
  settled and v1 grammar; the copy itself waits for a demand.
- **`https:` read ends.** The scheme family is open by design; `file:` is
  its v1 member, and `set x - < https://…` joins when a use rules it in.
- **`search`.** A `search <query>` verb at any place, over what stands
  below it. Pipes over `ls` cover the interim.

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
3. **Multi-space sessions.** Per-space controllers behind one prompt, so
   `cd` can cross spaces and home-anchored wish targets can be followed.
   Not yet designed: it needs the per-process module globals the seam
   work records scoped per connection, and a controller lifecycle per
   space. Until it lands, one shuttle process serves one space,
   restarting is the space switch, and cross-space references are
   refused with the reason.
4. **History and records.** Persistent, searchable command history; a
   `record` verb writing the transcript to a `file:` target or into the
   fabric. The event-line design already makes transcripts evidence;
   this makes them saveable.
5. **Time and diff.** `history <ref>` and `diff` across time or between
   references — the state inspector's reconstruction machinery is the
   offline prior art — plus a modest `undo` that writes back what the
   session last saw, honest about concurrent writes.
6. **Small muscle memory.** `pushd`/`popd` on the place stack;
   `watch --bell` and `--notify` (local side effects, marked as such); an
   opt-in `--resume` restoring the user's own last ambient record — which
   is not the persisted cross-process ambience the non-goals rule out,
   and the line between the two is drawn here on purpose: resume hands
   one shuttle its own past, never another tool the session's present.
