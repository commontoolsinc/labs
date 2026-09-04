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

**A place's space is safe by its alphabet rather than by a guard.**
`renderPosition` (`place.ts`) writes the space into what `pwd` and `where`
show without holding it to the class a terminal acts on, and `isDID`
admits that class — it asks for a `did:` prefix, a second colon, and a
length. The guard is absent, and deliberately so. What stands in its place
is where a space comes from: a place is built on the DID an opened
connection reports, and a `did:key` is base58btc, an alphabet with no
character in the class. A DID method with a wider alphabet is what ends
that, and it is worth noticing when one arrives, because the guard becomes
necessary at exactly that moment and neither way of adding it is free.
Glyphing the space costs `pwd` being complete and pasteable; refusing it
widens what the doors admit. Each is a ruling to take against a case
somebody can reach, and the alphabet is why there is none to take it
against today.

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
- **A canonical output form.** A second form for everything shuttle prints:
  RFC 6901 pointers, no shuttle quoting, exactly what `cf` parses. `pwd`,
  `ls` and `get` all print, so the fork is a dimension of the output rather
  than one verb's flag, and the switch is a `where` dimension — the form is
  an ambient property of the whole run, and `where` is the ambient record's
  one surface (decision 22). It arrives when a caller exists to want it, and
  the scripting bundle above is where one does: stable machine-readable
  output is part of that bundle rather than of the interactive surface.

  One property it inherits: nothing printed may carry a character a terminal
  acts on. The class is the doors' ([`grammar.md`](grammar.md)), and every
  surface already answers for it — a name is refused, a message is shown as
  the glyph naming it, and a serialized value is escaped. The JSON form
  escapes in JSON's own spelling, which it can because `JSON.stringify`
  already writes `\uXXXX` for C0 and leaves only `DEL` and C1 to finish; a
  form that is not JSON cannot borrow that and has to say what it writes
  instead.

  A second property, and this one it supplies rather than inherits: a value
  the interactive form loses without a word. An `undefined` or an interned
  symbol under a key loses the key, and either of them at an array index is
  written `null` — the first reads as a key the fabric does not hold, the
  second as a value it does, and a cell holds every one of them
  (`prompt.ts`). The interactive form cannot close that, because a tag
  standing where the value was would stop being JSON somebody can paste back,
  which is what its escaping exists to keep (`place.ts`). This form makes no
  such promise, so it is where a spelling for them belongs, and the storage
  codec already has one to borrow: `Undefined@1` beside the `BigInt@1` that
  `get` writes as `$bigint` today (`packages/data-model/src/codec-json/`).
- **Vim keybindings, as a `where` dimension.** Modal editing at the prompt,
  an option and never a default. What it costs is a second binding table
  over motions the line editor already drives, plus the mode the table
  switches on — which is what B1c's choice of substrate buys, and why that
  choice is recorded with B1c rather than here
  ([`build-sequence.md`](build-sequence.md)).
- **Which space a piece is in.** Naming the space that holds an arbitrary
  piece, rather than the one the place stands in. It is a query over the
  fabric and not a dimension of the ambient record, so it arrives with
  multi-space sessions (candidate 3) and takes its answer from them. v1
  refuses to follow a reference into another space — denoting is not
  reaching ([`grammar.md`](grammar.md)) — so the only space v1 could ever
  name is the connected one, which `where` already prints.

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
