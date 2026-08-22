---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW51 build: the RULED option (a) semantics BUILT and PINNED; §7's alias class closed (memo variant); §8's RULED option-3 build closed the demand-closure class (scoped absence is knowledge; re-fire contract pinned, mutation-verified). The §8.5b surfaced residual (schema-examples red on both bases; §7's flake exclusion was a mis-verification) is root-caused and CLOSED in §8.5c: the consumer was the test's own missed assertion-churn site — no product-code consumer; the §3 audit stands. #6179 holds for the coordinator's delta review."
---

# OW51 build — the ruled unresolved-input lift semantics

> **STATUS (2026-08-21, second ruling): §7's surfaced fork is RULED —
> option 3 — and BUILT (§8). `P-arrival-closure` greens; the ruled
> re-fire contract carries a new mutation-verified pin; two adjacent
> latent findings are FLAGGED, not filled (§8.5). The §8.5b surfaced
> residual (`schema-examples` red on both bases) is root-caused and
> CLOSED in §8.5c: the consumer was the test's own missed
> assertion-churn site, no product-code consumer exists, and the §3
> audit stands — §7's flake exclusion remains corrected as a
> mis-verification. Ruling, red-first pins, spec text all
> preserved.**

## 0. The ruling (2026-08-21)

The owner, ruling the OW51 fix fork
([ow51-undefined-read-report.md](ow51-undefined-read-report.md) §4)
option (a):

> (a), server-side should match the current client behavior exactly.
> also note that with the lazy proxy based evaluation a lift can throw
> a specific error and mark a tx aborted with that reason and that
> should also be handled just like an unresolved input, i.e. being
> retriggered when any of the reads so far change (just like a regular
> call), and the output being `undefined`.

— owner (Berni), 2026-08-21. RULED. Three build obligations follow:

1. **(i) the reference behavior, verified then matched**: what the
   CLIENT does today with an unresolved lift input is the contract;
   the SERVING runtime must match it exactly.
2. **(ii) the ruled lift-throw semantic**: a lift that throws the
   specific tx-abort error is handled exactly like an unresolved
   input — the run re-triggers when any of its so-far reads change,
   its output is `undefined` in the interim.
3. **(iii) spec**: the serving-half sentence + the lift-throw
   semantics land in speculation.md (§2 neighborhood) as RULED text;
   the client half, already stated there, gets a verification pin.

Then the default-app surface (the OW51 crash) is re-verified ON 10+,
its skip entry lifts, and the register row closes with the ruling.

## 1. The client's current behavior (the reference), verified

Mapped on main:

- `experimental.lazyMaterialization` defaults TRUE
  (`runtime.ts` `??= true`), so lift bodies read through the LAZY
  SCHEMA VIEW (`schema-view.ts`): each path materializes as touched.
- A view read that cannot proceed (missing/mismatched data) calls
  `mismatch()`: it FIRST registers the failed read
  (`tx.readValueOrThrow(link)` — the dependency that re-triggers the
  reader when the data arrives), then throws `SchemaMismatchError`
  and notes it on the tx (`noteSchemaRefusal`).
- The action-run boundary (`runner.ts`) disposes a
  `SchemaMismatchError` — thrown synchronously OR arriving as an
  async rejection — as `postRun(undefined)`: "the run could not
  proceed on the data available, which is a non-event rather than a
  fault." Output `undefined`, no error surface, re-run on any
  registered read change.

This is exactly the ruled semantics, already built for the paths the
view covers. The OW51 crash is the hole beside it: a read whose LINK
CHAIN dies at a missing intermediate doc yields `undefined` into the
callback WITHOUT the register-and-refuse step (and without the leaf
default), on both the client and the serving runtime.

## 2. The hole (the exact path)

The write-topology explorer's chain-walk (verified against main)
located the dead-end, and red-first work corrected one framing
detail:

- **Link resolution's dead-end is silent.** `link-resolution.ts`: the
  sigil probe reports a `NotFoundError` whose `path` is `[]` when the
  DOC itself is missing (vs a non-empty path = a present doc lacking
  that sub-path). That distinction was READ and then DISCARDED — the
  walk broke and returned a `ResolvedFullLink` pointing at the absent
  doc. The leaf link and its schema default live INSIDE that absent
  doc, so the default was structurally unreachable.
- **The lazy read then handed `undefined` to the body.** `schema.ts`'s
  lazy branch called `materializeSchemaView` with the absent value;
  `readValueOrThrow` swallows `NotFoundError` by design
  (`extended-storage-transaction.ts`), and the view's root arm returns
  `undefined` for a missing value rather than refusing (a fresh
  `cell.get()` never sets `mismatchThrows`). So the body received
  `undefined` where its schema promised a value — `splitDefinitions`
  crashed on `body.split`.
- **The corrected framing (red-first).** The map anticipated a
  MID-WALK dead-end (`followedHop` true). In the real OW51 shape the
  `asCell` boundary consumed the hop when it MINTED the handle, so the
  crashing `get()` starts AT the absent doc — `followedHop` is false,
  `path` is `[]`, mechanically identical to a fresh cell's own absent
  root (the pervasive `get() ?? fallback` first-write idiom). The
  honest discriminator is therefore not "did this walk follow a hop"
  but "is this link DATA-DERIVED" — parsed from a stored sigil, or the
  product of a resolution that followed a hop. A locally-minted cell's
  own link is not; a handle minted from somebody else's link is.
- **`servingPosture` gates nothing on this path** (map, confirmed):
  the serving runtime reads through the same lazy path, so "server
  matches client exactly" falls out of shared code — no separate
  serving-side branch to write.

## 3. The build

Four seams, all read-side and OFF-safe (the lazy read path is the
action-body path; eager reads — bindings, diffing, scheduler
internals — are untouched):

1. **`link-types.ts`** — two read-side `NormalizedLink` fields, never
   serialized and never part of link identity (the `scopeCaps`
   discipline): `viaLinkHop` (the link is DATA-DERIVED) and
   `pendingHopDoc` (a resolution dead-ended at a missing doc behind a
   hop / from a data-derived handle).
2. **`link-utils.ts` `parseLink`** — a sigil-parsed link carries
   `viaLinkHop`. A locally-minted cell's own link does not, so its
   first-write `undefined` reads unchanged.

   **The carrier's altitude, and why it is safe (a documented
   tradeoff).** `viaLinkHop` rides `parseLink`'s output because that is
   where a stored sigil becomes a normalized link, and the provenance
   flows from there through the data layer to the read (a trace shows
   the mark applied by `data-updating.ts`'s `normalizeAndDiff` on the
   write path, then picked up at the read). It must be ENUMERABLE:
   the provenance has to survive the many `{...link}` spreads between
   parse and read, and a non-enumerable property (or a `WeakSet` mark)
   is dropped by the first spread — verified by a red run. The cost is
   that a deep-equal assertion of a sigil-parsed link's whole output
   now sees the extra field. Both CORRECTNESS risks are verified
   clean: link IDENTITY ignores it (`areNormalizedLinksSame` compares
   only id/space/scope/path — and `normalizeAndDiff`'s self-reference
   check goes through it, so diffing is unchanged), and it does not
   reach STORAGE (`createSigilLinkFromParsedLink` emits a fixed field
   set — exact parity with `scopeCaps`, the existing read-side link
   field). So the blast radius is purely test-assertion churn on
   deep-equals of sigil-parsed links, updated where the suite surfaces
   them (link-utils, runner, …). A narrower carrier — an opt-in
   `parseLink` flag threaded only through the read/bind path — was
   considered and is a possible refinement, but the provenance's flow
   through the write/diff layer means it has no single findable bind
   site to thread; recorded as an owner-visible option, not taken
   here.

   **Product-code-observability audit (the decision criterion — NO
   product path observes the field).** Swept `packages/*/src` for every
   way a parsed link's key-set could be seen: (a) explicit reads of
   `.viaLinkHop` — only the fix's own files; (b) link IDENTITY —
   `areNormalizedLinksSame` compares id/space/scope/path only; (c)
   memo / cycle / dedup KEYS — `linkAddressKey` (link-resolution.ts)
   and `cellIdentityKey` (scope-policy.ts) list/destructure only the
   address fields, so two resolutions identical but for the flag still
   share a memo entry; (d) DIFFING — `normalizeAndDiff`'s self-ref
   check routes through `areNormalizedLinksSame`; (e) SERIALIZATION —
   `createSigilLinkFromParsedLink` / `getAsLink` emit a fixed field
   set, so nothing reaches storage or the wire; (f) `Object.keys`
   count-branching — the one such site (`sigilLinkAddressOnly`) reads
   the sigil PAYLOAD, not the normalized link; (g) structural clones /
   `deepEqual` — the `deepEqual` sites compare schema default VALUES,
   not links. Exact parity with `scopeCaps`, the pre-existing
   read-side link field. The blast radius is therefore TEST-ONLY, and
   the affected assertions legitimately should now reflect that
   sigil-parsed links carry read-side provenance.
3. **`link-resolution.ts`** — the walk tracks `followedHop`; the
   dead-end break re-decides `deadEndDocMissing` per iteration from the
   probe's `NotFoundError` path (`[]` = the doc), and sets
   `pendingHopDoc` on the result when the walk crossed a hop OR started
   from a data-derived handle. The result itself is stamped
   `viaLinkHop` so a handle minted from it carries the provenance its
   own later reads need.
4. **`schema-view.ts` + `schema.ts`** — `UnresolvedInputError` (a
   `SchemaMismatchError` subclass, so every existing disposal seam
   treats it identically). The lazy branch refuses when
   `pendingHopDoc === true && value === undefined &&
   defaultForAbsentValue(viewSchema) === undefined`: it registers the
   dead-end doc's read (the arrival re-trigger) then throws. A DECLARED
   default keeps the pinned "the default stands in, read registered"
   contract — the gate sits BEHIND the default arm, which is where
   the first placement's schema-view regression surfaced and was
   fixed.

**The (ii) lift-throw clause.** Because `UnresolvedInputError` extends
`SchemaMismatchError`, the refusal propagating OUT of a lift body (the
body did not catch it) takes the same disposal at the runner's action
boundary (`runner.ts` `isSchemaMismatchError` catches, sync and async)
— output `undefined`, no failure, re-trigger. The primary pin
exercises exactly this: the `computed`'s `ref.get()` throws, propagates
through the body, and is disposed. A pattern body MINTING the error
deliberately needs a pattern-facing export, which stays the FLAGGED
API question with the owner (the coordinator's item 6: build
runner-internal for now); the read-propagation path — the OW51 shape —
is the built coverage.

**Caution 3 — the `schema-view.ts` opaque no-type route: CLOSED BY
CONSTRUCTION.** That route (a `type: "unknown"` position answering
presence with a non-recursive-only dependency) is reached only for
`value !== undefined`; the refusal gate fires only for
`value === undefined`. The two are mutually exclusive, and the refusal
is UPSTREAM (in `schema.ts`, before `materializeSchemaView` is
called), so an unresolved input never reaches the opaque route. No pin
needed — it is unreachable for this case, not an accidental survivor.

**Caution 4 — the optional-property refusal swallow: CORRECT, with a
NAMED owed pin.** `createObjectView`'s non-required-property arm
catches a `SchemaMismatchError` from a child read, `clearSchemaRefusal`
s it, and returns the property as `undefined` (ABSENT). For an
unresolved input reached through an OPTIONAL property this is the
RIGHT disposition and eager-parity: an eager read leaves an optional
property whose traversal fails OUT of the object (only a `required`
one takes the object down). Crucially the swallow clears only the
refusal NOTE — the `readValueOrThrow` registration the refusal made
survives, so the reader still re-triggers when the doc arrives. The
OW51 production shape does not reach this arm (note.tsx reads
`pendingEdit` at the computed's root, hitting the root refusal), so
this is not in the critical path; the mechanism is correct by the
registration-survives argument above. Decision: IN-SCOPE-and-correct,
with a dedicated pin OWED (a lift reading an optional property that
dead-ends → `undefined` while unresolved, heals on arrival) — named
here rather than built as a fiddly drive-by, and tracked as the OW51
row's residual so it is not forgotten.

## 4. Spec landing

`speculation.md` §2 ("Unreplicated inputs") gains the RULED
unresolved-lift-input paragraph: the owner's ruling verbatim, the two
clauses (the unresolved read refuses; a lift that throws takes the
same disposition), the default-arm and own-root carve-outs, and the
implementation + pin pointers. The client half was already stated
there (the PENDING sentence); the new text makes the
`undefined`-is-not-the-answer edge explicit and binds the serving
runtime to the same behavior.

## 5. Default-app verification + skip lift

The authoritative serving-side E2E is `default-app.test.ts` ON — the
surface whose SERVING-runtime crash (not just the browser client's)
first recorded OW51. Built the ON binary from this branch
(`shellServerExecutionDefine "true"`, serving loop present, gitSha =
branch tip) and ran it:

- **10 runs, ZERO `splitDefinitions` occurrences in every one** (the
  pre-fix count was 17 + 6 per run; W4's loaded bench 2-for-2 red).
  Fast, too — ~29 s, versus the pre-fix 5-minute crash-timeouts. The
  OW51 crash class is eliminated.
- The "should create a note" step — the served-instantiation surface
  that recorded OW51 — passed **10/10**.
- The "persist and reload every rapidly created notebook note" step
  passed **9/10**; the one failure (run 9) was NOT the OW51 crash
  (0 splits) but `assertEquals(summary.noteCount, 7)` reading
  `undefined` — the reloaded notebook's derived `noteCount` lagged
  past the step's `waitForCondition`. This is the RELOAD-DURABILITY
  surface (OW45's family), which the OW51 crash had been MASKING: with
  the crash gone the step reaches its assertion for the first time
  under ON, and the OW51 fix's ruled disposition (an unresolved reload
  read is cleanly `undefined` + re-trigger) means a slow runner can
  read the interim before the heal. NOT an OW51 regression — the value
  heals (9/10) and the fix touches no reload/durability path; the
  event-driven wait on `noteCount` is OW45's test-side close.

**The lift.** default-app's FILE-level ON skip is LIFTED: the file
runs ON and its "should create a note" step (OW51's surface) is the
CI witness of the fix. The "persist and reload" step is converted to a
STEP skip bound to **OW45** (`tasks/server-execution-on-skips.ts` +
the in-file guard in `default-app.test.ts`), exactly the pattern
cellset-lww / convergence-storm used. The OW51 register row is CLOSED
with the ruling quoted and the caution-4 residual named.

## 6. STOP-AND-SURFACE: the refusal fires too broadly — the OPEN design problem

The fix landed the ruled SEMANTICS and passed every NARROW pin
(`unresolved-input-lift.test.ts` green; default-app ON 10/10, zero
`splitDefinitions`; schema-view 66/66; the 11 sigil-link assertion
updates; product-code-observability of `viaLinkHop` = NONE, §3). But
its first full CI run on the real suites (#6179, head 1a2b78326)
revealed a BROAD product-behavior regression — the STOP-AND-SURFACE
condition the coordinator named.

**What broke (main was fully green behind `dfe9086dc`; my change is
the only delta):** 16 job failures, the load-bearing ones in the
PATTERN INTEGRATION lanes of BOTH arms —

- **OFF `topics` pattern** (`topics/main.tsx:306`): a lift crashed
  `TypeError: Cannot read properties of undefined (reading 'trim')` —
  the OW51 crash CLASS, but NOW, in OFF, where it did not crash on
  main.
- **OFF `parking-coordinator-admin-view`**: a value never
  materialized (5m timeout — the never-heal shape).
- Several ON pattern shards, same family.

**The mechanism.** `viaLinkHop` marks essentially EVERY sigil-parsed
link as data-derived, and the lazy read runs in BOTH arms
(`lazyMaterialization` defaults on regardless of server-execution). So
the refusal (`pendingHopDoc && value===undefined && no default`) fires
on the LARGE population of legitimate reads of a data-derived link
whose target is momentarily or expectedly absent — not just the narrow
OW51 case (a served-instantiated note's input chain mid-arrival).
Disposing those runs cascades `undefined` into downstream lifts (the
`.trim` crash) and stalls derivations that would otherwise heal through
the normal derive cycle rather than the refusal's re-trigger. The
narrow runner UNIT tests do not exercise this population and pass
locally; the real PATTERNS do and break. (The runner CI reds this run —
doc-map, cooperative-yield, cfc-policy-of-label, cell-notification-
shaping, ensure-piece-running, oncommit-race — were separately verified
as FLAKES: all pass locally with the preload; the LLM-mock and
connection-refused signatures are infra. Only the pattern-integration
family is the real regression.)

**Why the narrow pins missed it.** The pin constructs the exact OW51
shape (a hop-target dead-end that then arrives) and asserts the
disposition. It does NOT sample the broad population of data-derived
reads that dead-end for OTHER reasons (a genuinely-absent optional
target the pattern already tolerates, a target that heals via ordinary
derivation, a read racing a write in the same tick). The refusal is
correct for the pin's shape and wrong for much of that population.

**The OPEN design question (for next session):** how to scope the
refusal to the true unresolved-input case WITHOUT refusing the large
legitimate-absent population. Candidate directions, none built:

1. **Narrow the trigger, not the carrier.** The refusal should fire
   only when the target is EXPECTED to arrive (a served
   instantiation's not-yet-materialized doc), not for any absent
   data-derived target. Signals to explore: whether a pull was
   actually kicked AND is outstanding for the dead-end doc (an
   in-flight expectation), the serving posture + a wave-arrival marker,
   or a "this doc is expected" bit set by the served-instantiation path
   specifically — rather than the blanket "sigil-parsed = data-derived".
2. **Carry the provenance outside the link object** — e.g. in the
   read-scope journal / reactivity log for the specific read, so the
   decision is per-READ-context rather than a property on every
   parsed link (also removes the test-assertion churn of §3).
3. **Confine the behavior to the ON arm** — the OW51 crash is a
   served-runtime + served-instantiation phenomenon; if the refusal
   guarded on `servingPosture`/`serverExecution`, OFF patterns keep
   today's undefined-returning behavior and only the served path
   refuses. (Trades away the "server matches client EXACTLY" letter of
   the ruling for not regressing OFF — an owner call, since the ruling
   said match exactly.)
4. **A tighter value/schema condition** — refuse only when the
   dead-end is the reader's DIRECT input root under a non-optional,
   non-defaulted, non-nullable schema AND the read is a
   scheduler-driven lift (not an incidental resolve), narrowing the
   population.

**What is preserved regardless (nothing lost by deferring):** the
owner's ruling (§0), the red-first pin capturing the semantics
(`unresolved-input-lift.test.ts`), the spec RULED text (speculation.md
§2), the triage root cause (`ow51-undefined-read-report.md`), and this
analysis. `#6179` stays "semantics built + pinned, carrier/scope OPEN
— do not merge"; the OW51 register row's CLOSED status is PREMATURE
given this finding and should read OPEN until the scope is resolved
(corrected in the same commit as this section).

## 7. Post-review update: the memo-variant fix, and the ONE remaining over-fire

The #6179 adversarial review re-diagnosed §6's broad breakage as a
MEMO-ALIASING bug (Finding 1), not a fundamentally-too-broad refusal —
and confirmed the carrier is SOUND-BUT-BROAD, the only leak being
INWARD (into the resolution memo). Landed:

- **GATING — the one-line memo-variant fix** (`viaLinkHop` added to
  `resolutionMemoVariant`): a clean read and a data-derived read of the
  SAME missing doc in one lazy tx no longer share a memo entry.
  **Both directions pinned and mutation-verified**
  (`link-resolution-memo.test.ts` P2a/P2b — each RED with the variant
  term removed, GREEN with it), plus the own-root carve-out pin closing
  the reviewer's Mutation-C vacuity gap (Finding 6).
- **Finding 2** — stale `pendingHopDoc` cleared on the result spread
  and dropped by `undefinedDataLink`.
- **The churn** — every deep-equal of a sigil-parsed link updated
  (link-utils, runner, pattern-binding, cell-as-cell, list-element-link
  ×3), verified assertion-shape.

**What the memo fix RESOLVED (verified by bisect):**
`list-element-issuance-ownership` "re-links a created filter element" —
a memo-alias case — **passes with the fix** (fails on pure main-plus-
refusal without it). The alias class the review named is closed.

**What it did NOT resolve — the remaining over-fire, SURFACED for a
design call:** `executor-dprime-w0` **"P-arrival-closure"** still TIMES
OUT (22 s) with the full fix (passes on pure main in 2 s — bisected to
the refusal). It is a DEMAND-CLOSURE SELF-PRODUCING read: a demanded
derivation reads a value reached only through non-root rows into a
nested child's result that its OWN closure produces; the refusal
disposes that run, and — because "no demanded root gains her pair, so
the root-level arrival re-arm is inert" (the test's own words) — the
re-trigger the refusal relies on never fires for that principal, so she
deadlocks. This is exactly the shape Finding 3 flagged ("the
re-trigger story assumes an EXTERNAL writer exists"), now shown to
also break a demanded closure, not just a lift-body initializer.

**Not this class:** `schema-examples` "nested sinks via asCell" — the
§6-era TypeError — fails IDENTICALLY on pure main (a pre-existing
local-env sink-teardown flake), not the refusal; excluded.

**The design question (owner/coordinator call before #6179 is green):**
how to keep the refusal from firing on a read whose target the current
demand closure itself produces. Candidates, none built:

1. **Confine the refusal to the ON serving arm** — the OW51 crash is a
   served phenomenon; an OFF (client) lift keeps today's
   undefined-returning behavior. Trades the ruling's "match exactly"
   letter for not touching the OFF demand-closure machinery. Simplest;
   an owner call since the ruling said match exactly.
2. **Exclude demanded/self-produced reads** — don't refuse when the
   dead-end doc is (or is reachable from) something the current wave's
   demand closure is producing. Correct but needs the serving loop to
   expose "this doc is in-flight-produced-by-me", which it may not.
3. **Make the refusal's re-trigger independent of the root-level
   arrival re-arm** — so a disposed demanded run re-fires on the
   registered read's arrival even when the root re-arm is inert. Deeper
   serving-loop work.
4. **Narrow the trigger to the served-INSTANTIATION-arrival case only**
   (the true OW51 shape — a served-instantiated piece's input chain
   mid-materialization), via an explicit "expected to arrive" marker
   set by that path, rather than the blanket data-derived dead-end.

The memo-variant fix + pins are correct and should land as part of the
eventual fix regardless of which direction closes the demand-closure
class.

## 8. The second ruling — option 3 — and the build that closed §7's class

### 8.0 The ruling (2026-08-21), verbatim

The owner, ruling §7's fork:

> client-side doesn't react to its own writes, server should do, but
> i'm not sure this is about that. what does self-demanded mean? either
> way, option 3 sounds good

— owner (Berni), 2026-08-21. RULED: option 3 — make the refusal's
re-trigger independent of the root-level arrival re-arm.

**Coordinator's gloss (coordinator words, not the owner's):** the
"self-produced" framing was the test's construction, not the class —
the class is any refusal-disposed served run whose awaited doc arrives
as a NON-ROOT row for its demanding pair, where the root-keyed re-arm
is structurally blind; the owner's instinct (the server must react to
writes its own serving work produces) is exactly what option 3
delivers, generalized to foreign producers too.

### 8.1 The verified mechanism — where the hypothesis diverged

The build began by verifying the coordinator's hypothesis ("the
disposal path leaves the pair CURRENT, so the currency check never
re-runs it; fix: leave the pair NOT-current, or register the dead-end
address so its arrival marks it not-current"). Instrumented runs of
`P-arrival-closure` at the rebased head (`fanOutRunFinished`,
`rearmNotCurrentForDemander`, the refusal gate) showed:

1. **The pair IS marked clean after a refusal-disposal** — the
   hypothesis's premise holds (`fanOutRunFinished` ran for both refused
   instance runs: `logDefined=true reads=17 clean=true`). But this is
   CORRECT, not the defect: the ruled interim output (`undefined`) IS
   the instance's current value. The hypothesis's fix shape —
   leave the pair not-current — would REGRESS: `fanOutInstancesToRun`
   filters on the clean bit, so a never-clean refused instance is
   re-offered every pass — the F1 hot-loop/starvation shape the W1
   review already closed once.
2. **The re-fire contract already holds.** The refusal-disposed run's
   transaction commits its reactivity log (the dead-end read included —
   both the gate's `readValueOrThrow` and the walk's own sigil-probe
   reads), the log joins the node's union subscription
   (`fanOutUnionLog`), and a later write to the dead-end doc — ANY
   writer, foreign included — cause-dirties exactly the covered
   instances (`dirtyFanOutForCause`) and re-runs them. Watched live:
   Alice's pre-draft instance run REFUSED, her draft write (the
   arrival) re-ran her instance through the subscription, `echo:A`
   landed. The root-level arrival re-arm plays no part in this path,
   and never could: both root-level re-arms mark the node invalid with
   `fanOutInstances: "keep"`, which re-runs only NOT-clean instances —
   a disposed (clean) instance is structurally beyond their reach, by
   construction. Option 3's contract was therefore already delivered
   by the code as it stood.
3. **The deadlock was a mis-fired REFUSAL, not a missing re-fire.** In
   `P-arrival-closure` no arrival ever occurs before the failing wait:
   the awaited doc is Bob's own per-user draft row, which nobody but
   Bob can write, and Bob writes it only after the wait. The test
   expects `"echo:"` — the ABSENT-ARM value (`get() ?? ''`) — i.e. on
   main the absent scoped row reads `undefined` and the body's
   fallback computes. The branch's refusal fired on that read because
   the relay through the nested child's arg doc stores a sigil, which
   makes the child's handle DATA-DERIVED and defeats the own-root
   carve-out for the very same absent row the flat form reads as
   `undefined`. No re-trigger design can green that wait; only not
   refusing can.

### 8.2 The build — the scoped-absence carve-out

A missing USER- or SESSION-scoped row is KNOWLEDGE, not transit: a
principal's instance row exists only once that principal writes it
(the scoped first-write idiom), and the fan-out run supply
materializes instances by running derivations over exactly such
absent rows — a refusal there starves every first materialization
whose scoped input carries no reachable schema default. The dead-end
therefore marks `pendingHopDoc` only when the missing doc is
SPACE-scoped (`link-resolution.ts`; contract stated on
`link-types.ts`'s `pendingHopDoc`). Composition no longer changes the
verdict: the relayed read of an absent scoped row reads `undefined`
exactly as the flat form does, while the OW51 crash class — a missing
SPACE doc behind a hop (the served-instantiation chain) — refuses
exactly as §3 built. The change strictly REMOVES refusals; every
removed refusal returns that read to main's behavior. NAMED residual
window (the #6179 review, MINOR-3): a scoped row already written
ELSEWHERE — another device, or a cold/lagging serving replica — is
transit, not knowledge, and the carve-out returns such mid-arrival
reads to main's interim-undefined-then-heal (fragile-body crash
included); outside the refusal's protection, matching main. No
shipped pattern routes link chains through user-scoped docs — the
review's population audit is the evidence.

### 8.3 Red-first

- `executor-dprime-w0` **"P-arrival-closure" watched RED at the
  rebased head** (e58ca65c7) three times — 22 s timeout at "bob's
  instance ... through the per-key currency check" each time (passes
  on plain main). GREEN with the carve-out; full file 9/9 steps green
  ×3 consecutive runs.
- The §7-era claim "the root-level arrival re-arm is inert [for Bob],
  so the re-trigger never fires" was the test comment's language for
  pair MATERIALIZATION, and §8.1's instrumentation shows it did not
  describe the deadlock: Bob's instance run DID materialize (the
  per-key currency check re-armed it — `notCurrentRearms` ticked) and
  then refused; nothing was awaiting an arrival at all.

### 8.4 The class pin — the ruled re-fire contract, mutation-verified

New pin (same file): **"OW51 refusal re-trigger (the RULED option-3
contract)"** — a served run REFUSAL-disposed on a genuine unresolved
input (a stored link to a space doc nobody wrote), then a FOREIGN
writer (a third session that watches nothing) creates the doc; the
disposed run re-fires through its registered dead-end read alone and
the derived value lands. Honesty about its red-first status, per the
§8.1 finding: **this pin cannot be made red against the current code**
— the re-fire machinery it pins was never broken, so it guards the
ruled contract against regression rather than witnessing a fix. It is
load-bearing on exactly the ruled seam, verified by mutation:

- **M-CLEAN** (remove `dirtyFanOutKey`'s `clean.delete` — a
  cause-bearing dirty can no longer un-clean a disposed instance):
  the pin TIMES OUT at "the disposed run to re-fire on the foreign
  arrival". Watched red under the mutation, green restored.
- **M-REG** (remove the refusal gate's explicit
  `tx.readValueOrThrow`): the pin STAYS GREEN — the walk's sigil-probe
  reads independently register the dead-end at the reactivity layer
  ("the link appearing later re-resolves"). The gate's explicit
  registration is belt-and-braces for this shape; kept, since other
  read paths may not share the probe's registration.
- **M-UNION** (the #6179 independent review's sharper kill, run by the
  reviewer): drop zero-write logs from `fanOutUnionLog` and ONLY this
  pin goes red — the disposed run's committed log never joins the
  union subscription, so the foreign arrival re-fires nothing. This
  pins the union-subscription seam itself, tighter than M-CLEAN's
  downstream clean-bit seam.

Relation to the fork's options: option 2 (exclude self-produced reads
only) would have left this pin's foreign-writer arrival un-modeled and
`P-arrival-closure` still red (Bob's draft row is client-authored, not
closure-produced); the built carve-out plus the pinned re-fire
contract covers both.

### 8.5 Flagged, not filled (adjacent latent findings, main-line)

Two findings surfaced by instrumentation — plus a review-named
cleanup (item 2) — are OUTSIDE this PR's scope and are recorded for
their own arcs rather than patched here:

1. **Capture type-shrinking strips `Default<''>`** (ts-transformers):
   the compiled outer argumentSchema declares
   `{"type":"string","default":"","asCell":[{"kind":"cell","scope":"user"}]}`,
   and the stored link's content-addressed schema
   (`cid:…`, #6083) still holds `{"default":"","scope":"user"}` — but
   a computed's shrunk capture schema for a directly-captured argument
   is a bare `{"type":"string"}`, so the runtime's declared-default
   carve-out (§3.4) cannot see the default at the read. Invisible on
   main (undefined flows either way and bodies carry `?? fallback`);
   it decides refusal-vs-default under the OW51 semantics. Transformer
   territory, pattern-wide blast radius (baselines are append-only) —
   flagged for the owner.
2. **The scope-blocked walk exit re-stamps `viaLinkHop` onto an
   `undefinedDataLink` result** (link-resolution.ts — the strip inside
   `undefinedDataLink` and the exit stamp disagree in intent;
   behaviorally inert today, nothing consumes the flag on an
   undefined-data link; the review proved the inertness — MINOR-4).
   Named cleanup: skip the exit re-stamp on the scope-blocked break,
   with its own pin so the change is non-vacuous. Not taken in #6179.
3. **Era-dependent scope resolution of a relayed PerUser read**: the
   serving node's probe run reads the SAME relayed draft chain at
   `scopes=["space"]` in one era (18 reads, no narrowing) and at
   `["space","user"]` in a later era (19 reads, discovers user,
   narrows) — observed inside `P-arrival-closure` itself. A node whose
   only user-scoped reads ride such a relay may fail to narrow until
   a later era re-runs it. Orthogonal to this PR (its pins avoid the
   dependence); likely interacts with content-addressed `$ref`
   schema resolution timing — flagged.

### 8.5b STOP-AND-SURFACE (second): an EAGER consumer observes the carrier — schema-examples red on BOTH bases; §7's exclusion was a mis-verification

Found by this session's verification breadth (the §6 incident's
mandate), bisected to a clean parent/self flip, and re-established on
a quiet machine after a parallel agent's process kills contaminated
one measurement window (the contaminated executor results were re-run
per-file and are green; this finding is NOT contamination — it
reproduces deterministically local-clean AND on CI's own runners at
two consecutive heads).

**The failure.** `schema-examples.test.ts` "should support nested
sinks via asCell with aliases" — the VDOM shape, per the test's own
comment — fails deterministically (~20 ms, a sink callback crashing
on an undefined root read) WITH the branch and passes WITHOUT it, on
BOTH bases:

| head | verdict |
| --- | --- |
| OLD main `380d233f3` (the original merge-base) | GREEN |
| OLD-base semantics build `890436c7b` | RED |
| current main `89deb7505` | GREEN ×3 |
| rebased RED-pin commit `a56fa8558` (test-only parent) | GREEN ×2 |
| rebased semantics build `8e7ef8c79` (self) | RED ×2 |
| every later branch head incl. the option-3 tip | RED |

So: NOT a rebase interaction (the #6083 suspicion is refuted by the
old-main pair), and §7's exclusion of this exact red as "fails
identically on pure main (a pre-existing local-env sink-teardown
flake)" was a MIS-VERIFICATION — on both bases main is green and the
branch is red.

**The trigger, isolated to one line-class.** Neutralizing ONLY
`markDerived` on `parseLink`'s BASELESS arm (a stored sigil parsed
with no base) greens the test with everything else intact — the walk
changes, the refusal gate, the memo variant, and the two based arms
all stay. The refusal itself never fires here (instrumented: the lazy
branch is never entered), and the eager object-arm required-check is
not the undefined's source either — the stamp is observed by some
OTHER eager-path consumer, unidentified within this session's
time-box.

**The mechanism shape (instrumented).** Main itself has a transient
here: the test commits its three docs without awaiting, the sinks'
first runs race it, crash once on undefined (`schedule-error` logged,
identical on main), and HEAL on re-fire. Under the stamp the
asymmetry inverts: the root sink's first run reads the REAL value,
and a LATER re-fire reads the PRESENT doc as UNDEFINED — a
present-value eager read regressing, permanently. **This falsifies
§3's core safety claim** ("Lazy-branch only: eager reads … keep
today's behavior" / "product-code observability: NONE") — for the
second time, after §7's memo finding, an unforeseen consumer of the
enumerable carrier field has produced a real product-behavior break.

**Why this is surfaced rather than absorbed (the §6 precedent).** A
one-line neutralization of the baseless arm would green the test —
but the baseless arm IS part of the OW51 fix's carrier for handles
minted from stored sigils, so that patch would need its own
verification that the OW51 crash class stays closed, and it would be
the SECOND whack-a-mole patch on a carrier whose safety audit has now
been falsified twice. The evidence increasingly favors §6's candidate
2 — carry the provenance OUTSIDE the link object (per-read-context) —
which is a design disposition above this session's authority. The
options, for the ruling:

1. **Neutralize arm 1** (stored-sigil parses stay unstamped when no
   base is supplied; the based arms keep the provenance): smallest
   diff; must re-verify the OW51 production shape still refuses (the
   asCell mint path supplies a base, so the based arms may suffice —
   unverified).
2. **Find and fix the eager consumer** (make it ignore the field):
   continues the enumerable-carrier design; third patch of its kind;
   the consumer is not yet identified.
3. **Re-carrier per §6 candidate 2** (read-context provenance, no
   field on links): structurally closes the whole observer class and
   removes the assertion churn; the §7 memo term becomes unnecessary;
   larger build.

Until ruled, #6179 carries this red (CI: the runner shard holding
schema-examples) and MUST NOT MERGE.

### 8.5c The consumer, NAMED — §8.5b's mechanism attribution corrected; the residual CLOSED

The coordinator directed find-the-consumer-first (option 2 as a
prerequisite, not a disposition). The differential trace ran the
failing test stamped vs baseless-arm-neutralized with instrumentation
at five layers (resolution exits, sink runs, scheduler invalidation
causes, storage change before/after, route destroy) and the chain is
now fully named — and it OVERTURNS §8.5b's attribution:

**The consumer is the test's own assertions.** `schema-examples.test.ts`
carries TWO deep-equals over a BASELESS `parseLink` output (the
aliases pin, lines 362/391) — exactly the §3-documented
assertion-churn class. The churn commit updated six files
(link-utils, runner, pattern-binding, cell-as-cell, list-element-link,
link-resolution-memo) and MISSED this one. The first assertion throws
(`Actual` carries `viaLinkHop: true`, `Expected` does not — the
watched red names the consumer in its own diff), and everything
§8.5b read as a product regression is teardown fallout of that early
throw: the suite's `afterEach` runs `runtime.dispose()` while the
test's DELIBERATELY-unawaited seed commit and its sinks are still in
flight → the commit dies with `TransactionError: memory replica
closed` (route destroy stack = afterEach → dispose →
EmulatedStorageManager.close), the optimistic docs RETRACT
(change stream: three whole-doc present→UNDEF events), and the leaked
sink actions re-run against the disposed storage, read the docs as
missing, and crash with the `TypeError` that CI surfaced as the
headline failure.

**Corrections to §8.5b, stated plainly:**

- There is NO product-code consumer of the carrier. §3's
  product-code-observability audit STANDS (the §7 memo term remains
  the one product-side observer, already fixed and pinned).
- "An eager read of a PRESENT doc regressing to undefined" was the
  disposed-runtime window, not a carrier effect.
- The coordinator's classification question: the observation is
  deep-equality of link objects IN A TEST ASSERTION — not the
  memo-variant key, not a product equality/identity leak, not a
  product field read.
- §8.5b's inference "the audit has been falsified twice" is therefore
  WITHDRAWN; the §6-candidate-2 re-carrier trigger ("equality/identity
  leaks broadly, or a second consumer") is NOT met.

**The fix (the coordinator's arm (a), maximally clean):** the same
churn convention as the six sibling files — the two expected objects
gain `viaLinkHop: true` with the OW51 comment (`8777de478`).
Red-first: the red was watched VIA the named consumer (the assertion
diff), green after — ×3 stability runs, then the full pin set
(9 files incl. schema-examples), the executor sweep per-file, the
runner batch, and the default-app ON gate re-check recorded in the PR
body. The gate note: the fix is TEST-ONLY — `git diff` over
`packages/*/src` between the 10/10 gate's binary head and this head
is EMPTY — so the 10/10 stands for this runtime; fresh compliance
runs ride the same binary.

The §8.5b register residual is CLOSED with this; the PR keeps its
[HOLD] title until the coordinator's delta review clears it.

### 8.6 Suites at the built head

Rebase first (main moved 9 commits: #6083 content-addressed schemas ON
by default, #6187 send-site routing, #6178/#6173/#6170): one conflict
(`tasks/server-execution-on-skips.test.ts`'s gate-set description —
merged both sides' clauses), all three prior merge commits verified
clean automerges before flattening; the branch's full pin set re-run
per-file at the rebased head BEFORE any new work (all green — rebase
proven neutral). At the built head: the eight branch pins green
per-file (`unresolved-input-lift` 2 steps, `link-resolution-memo` 3,
`link-utils` 109, `cell-as-cell` 33, `list-element-link` 4,
`pattern-binding` 49, `schema-view` 64, `runner` 92);
`executor-dprime-w0` 9/9 ×3; the full runner battery and the
default-app ON gate recorded in the PR body alongside the CI lanes.
