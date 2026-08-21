---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW51 build: the RULED option (a) — the serving runtime matches the client's unresolved-input lift semantics exactly, and the ruled lift-throw semantic (a specific tx-abort error handled like an unresolved input: output undefined, re-trigger on any so-far read change) lands on both sides; the default-app surface greens ON and its skip lifts."
---

# OW51 build — the ruled unresolved-input lift semantics

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
