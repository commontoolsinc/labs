# Live-element feasibility — putting a live `MyCar` on the profile

**Verdict (one line):** The live-element mechanism **already exists and is
exercised in production code** — a profile element's `.cell` is a live
`pattern()` instance, and a `scope:["profile"]` wish resolves to that instance's
result cell so a consumer can read its output fields (e.g. `selfClaims`). The
**only** gap is that `profile-home.tsx`'s add-handlers hardcode
`ProfileCatalogCard`/`UrlPatternReference` and never instantiate `MyCar`. The
minimal change is one new add-branch/catalog-entry that does
`(MyCar({}) as any).for("my-car")` with `userTags: ["car"]`.

Legend: **[DOC]** = documented/asserted in design or comments · **[IMPL]** =
proven by runtime/pattern source · **[TEST]** = covered by a unit test ·
**[INFER]** = reasoned from the above, not directly observed end-to-end.

---

## Q1 — Is a profile element's `.cell` a live pattern instance? **YES [IMPL]**

A profile element is a `ProfileElement { cell, tag, userTags, title, source }`
(`packages/patterns/system/profile-home.tsx:40-46`). Every code path that
populates `.cell` does so by **calling a `PatternFactory` and tagging its result
cell**:

- `addElement` handler — `profile-home.tsx:139-143`:
  `(UrlPatternReference({ title, url }) as any).for(tag)` (url source) or
  `(ProfileCatalogCard({ title }) as any).for(tag)` (catalog source).
- `addCatalogElement` handler — `profile-home.tsx:196-198`:
  `(ProfileCatalogCard({ title: "Profile card" }) as any).for("profile-card")`.
- `addUrlElement` handler — `profile-home.tsx:220`:
  `(UrlPatternReference({ title, url }) as any).for(tag)`.

`ProfileCatalogCard` and `UrlPatternReference` are **literal `pattern(...)`
instances**, defined at `profile-home.tsx:94-103` and `:105-118` respectively
(each `pattern<…, ProfileElementCell>(({…}) => ({ [NAME], [UI] }))`).

**Why calling them yields a live instance [IMPL]:** the value returned by a
`PatternFactory` is built in `packages/runner/src/builder/pattern.ts:398-420`.
Invoking the factory creates a `module: { type: "pattern", implementation:
factory }` node and returns `outputs = opaqueRef<R>()` — a reference to the
*instantiated pattern's outputs*, wired into the reactive graph as a pattern
node, not inert data. `.for(name)` (`pattern.ts:252,269` show the same
`cell.for(key, …)` naming call used internally) just assigns a stable
cause/identity to that result cell. So `(ProfileCatalogCard({title}) as any)
.for(tag)` is a live, running child pattern whose `.cell` is its result cell.

**Corroboration [IMPL]:** the profile-home UI renders each element's `.cell` as
`<cf-cell-link $cell={element.cell}>` (`profile-home.tsx:345`) — a cell-link to a
live pattern result, the same render the wish layer falls back to
(`wish.ts:1112-1114` `cellLinkUI`). The comment at `profile-home.tsx:37-39`
(CT-1628) explicitly says `cell: any` and the `(Pattern(...) as any).for(...)`
casts exist *only because the CFC types don't yet expose a typed cell ref* — i.e.
the runtime behavior (live instance) is intended; only the typing is a stopgap.

**Conclusion:** the mechanism to place a *live instantiated pattern* on a profile
already ships. `MyCar` is itself a `pattern<MyCarInput, MyCarOutput>(…)`
(`packages/patterns/my-car/main.tsx:130`), structurally identical to
`ProfileCatalogCard`, so `(MyCar({}) as any).for("my-car")` is the same move.

---

## Q2 — Can a consumer read a wished live-pattern's OUTPUT fields? **YES**

**Resolution path [IMPL]:** `wish({query:"#car", scope:["profile"]})` →
`searchByHashtag` sees `scope.includes("profile")` (`wish.ts:552,573-581`) and
calls `searchProfileForHashtag` (`wish.ts:481-534`). That:

1. reads the profile's `elements` cell via `getProfileDefaultCell(ctx)
   .key("elements")` (`wish.ts:491-494`),
2. filters by `userTags` first (exact, lowercased) then `tag`
   (`wish.ts:514-520`) — matching the `#car`/`CAR_TAG` contract,
3. returns `{ cell: match.cell, … }` for each hit (`wish.ts:528-530`) — i.e. the
   element's `.cell`, which is the **live MyCar result cell** (Q1).

The match's `cell` then flows through `resolvePath` (`wish.ts:1678-1687`) and is
projected into the wish state's `result` field
(`projectWishCellValue`, `wish.ts:1126-1132`; emitted at `wish.ts:1738-1747`).
`.result` is therefore the resolved pattern result cell; reading
`.result.selfClaims` reads that live pattern's `selfClaims` **output field**.

**Production precedent that reading a wished live-pattern output works [IMPL]:**
`#profile` resolves to `getProfileDefaultCell` (`wish.ts:717-726`) — the
**profile-home pattern's result cell**. `packages/patterns/shared-profile-demo/
main.tsx:5-11` reads `(profileWish.result as {initialNameApplied?})
.initialNameApplied` — an *output field of the live profile-home pattern*
(`ProfileHomeOutput.initialNameApplied`, `profile-home.tsx:84`,
produced at `:262,273`). This is exactly the shape `my-car-demo` uses for
`selfClaims` (`packages/patterns/my-car-demo/main.tsx:11,20`:
`carWish.result?.selfClaims`).

**Unit-test precedent that `.result` is the matched cell and its fields read
[TEST]:** `packages/runner/test/wish.test.ts:878-970` (`searches only
mentionables with scope: ["."]`) resolves a hashtag wish, then reads
`wishResult.result` and asserts `data.type === "mentionable"` off `.get()` of the
resolved cell (`:962-969`). Same read shape; the profile-scope branch is the
sibling of the mentionable branch in `searchByHashtag`.

**Honest gap [INFER/TEST]:** there is **no unit test** that drives
`scope:["profile"]` against a *live-pattern element* and reads its output field
end-to-end. The conclusion is sound by composition of two separately-proven
facts (Q1 live instance + the `#profile`/mentionable read precedents), but the
specific `selfClaims`-off-a-MyCar-element round-trip is **inferred**, and is what
browser testing was attempting to confirm.

---

## Q3 — Minimal change to add a LIVE MyCar element with `userTags:["car"]`

**The gap (root cause of the failed browser test) [IMPL]:** every add-handler
hardcodes the stub patterns. There is no branch that instantiates `MyCar`:
- `addElement` only ever builds `UrlPatternReference`/`ProfileCatalogCard`
  (`profile-home.tsx:139-143`).
- `addCatalogElement`/`addUrlElement` likewise (`:196-198`, `:220`).
- `profile-home.tsx` imports nothing from `../my-car` (verified: only the
  `commonfabric` import block at `:1-14`).

So whatever the profile-home add UI does, the resulting element's `.cell` is a
`ProfileCatalogCard`/`UrlPatternReference` stub with **no `selfClaims`** — which
is precisely the observed failure.

**Two ways to close it:**

1. **Live-instance branch (requires importing MyCar) [IMPL-shaped].** Add to
   `profile-home.tsx`: `import MyCar from "../my-car/main.tsx"` (+ `CAR_TAG`),
   and a new catalog branch — mirroring `addCatalogElement`
   (`:191-204`) — that does:
   ```ts
   appendElement({
     cell: (MyCar({}) as any).for("my-car"),
     source: "catalog",
     title: "My Car",
     tag: "my-car",
     userTags: [CAR_TAG],            // ["car"]
   }, state.elements);
   ```
   This is the smallest change that yields a **live** MyCar whose `selfClaims`
   the `#car` wish can read. It is a near-verbatim clone of the existing
   `addCatalogElement` body (`:195-203`), swapping the pattern constructor and
   `userTags`. The DESIGN reuse map already prescribes exactly this:
   "`MyCar` is a `ProfileElement {…, userTags:["car"], …}`, added via
   `addElement`" (`DESIGN.md:534`).

2. **URL/catalog *without* importing MyCar — NOT sufficient as-is [IMPL].** The
   generic `addUrlElement` path accepts a `patternUrl`, but it wraps that URL in
   a `UrlPatternReference` *stub* (`profile-home.tsx:220`) that merely *displays*
   the URL string — it does **not** instantiate the pattern at that URL. So
   "add MyCar by URL" through today's handlers produces a non-live card with no
   `selfClaims`. Making URL-add instantiate the referenced pattern is a *larger*
   change to `UrlPatternReference`/`addUrlElement` (resolve+run the remote
   pattern), not the minimal path. **Therefore the minimal viable change is
   option (1): a profile-home import of `MyCar` + one catalog branch.**

**Pinpoint:** the new branch belongs alongside `addCatalogElement`
(`profile-home.tsx:191-204`) with a matching button in the UI block near
`:313-322`, or as a new `catalogId` case inside `addElement` (`:131-151`)
dispatching on `event.catalogId === "my-car"`.

---

## Q4 — Does owner-integrity on `MyCar.selfClaims` still hold? READ side: YES

**Owner-protection is intrinsic to MyCar, independent of how it's mounted
[IMPL].** `selfClaims` is typed `OwnerProtectedProfileWrite<VehicleClaim[],
typeof addClaim>` (`my-car/main.tsx:66,131-133`) — the same
`RepresentsCurrentUser<Cfc<WriteAuthorizedBy<…>, {ownerPrincipal}>>` wrapper as
profile-home's owner fields (`my-car/main.tsx:54-61` ≅ `profile-home.tsx:21-31`).
That branding travels with the `MyCar` pattern instance regardless of whether it
is mounted standalone or as a profile element — mounting does not relax the CFC
write gate. The write gate (`prepare.ts` owner checks, per `DESIGN.md:170,555`)
is the **WRITE** path and is what CT-1658 blocks — **out of scope here**.

**The READ side is unaffected [IMPL/INFER].** The `#car` wish only *reads*: it
resolves the element cell and projects `result` (`wish.ts:1738`,
`projectWishCellValue` `:1126-1132`). Reading `selfClaims` off a live MyCar
result cell is an ordinary output-field read (Q2). Owner-protection restricts
*who can write*, not *who can read* the projected output, so a cross-space
read of `selfClaims` is expected to succeed once the element is live.

**Reasons the wish would still NOT see `selfClaims` (the real blockers):**
1. **Wrong element shape (the confirmed failure) [IMPL].** If the element is a
   `ProfileCatalogCard`/`UrlPatternReference` stub (today's only options), its
   output is `{ [NAME], [UI] }` (`profile-home.tsx:95-102,109-117`) — there is
   **no `selfClaims` field at all**. Fixed by Q3 option (1).
2. **Tag mismatch [IMPL].** The element must carry `userTags:["car"]` (lowercase,
   no `#`) to match `searchProfileForHashtag`'s `userTags`-first filter
   (`wish.ts:514-520`) against `CAR_TAG = "car"` (`my-car/claims.ts:18`). The Q3
   branch sets this explicitly.
3. **Scope must be explicit [DOC/IMPL].** `scope:["profile"]` is required;
   default scope is favorites-only (`wish.ts:550`, `DESIGN.md:380`). The consumer
   already passes it (`my-car-demo/main.tsx:15-18`).
4. **Loading latency, not a blocker [IMPL].** If `elements` hasn't loaded,
   `searchProfileForHashtag` returns `{matches:[], loaded:false}`
   (`wish.ts:500-502`) and the wish re-triggers reactively (`wish.ts:597-600`) —
   transient, self-healing.

---

## Bottom line

- **Live-element mechanism exists today:** [IMPL] — `profile-home`'s
  `.for(tag)`-on-a-`pattern()` is a live instance (Q1); `scope:["profile"]` wish
  resolves to it and exposes output fields (Q2, with `#profile`/mentionable
  precedents).
- **Single gap:** [IMPL] — add-handlers never instantiate `MyCar`; they emit
  field-less stub cards. That is exactly why browser testing saw no `selfClaims`.
- **Minimal fix:** [IMPL-shaped] — import `MyCar` into `profile-home.tsx` and add
  one catalog branch `(MyCar({}) as any).for("my-car")` with `userTags:[CAR_TAG]`
  (clone of `addCatalogElement`, `:191-204`). URL-add alone is insufficient
  because it wraps the URL in a display stub, not a live instance.
- **READ-side owner-integrity:** [IMPL] — intact; unaffected by mounting. Writes
  are CT-1658, out of scope.
- **Residual uncertainty:** [INFER] — no unit test drives a live-pattern profile
  element's output field through a `scope:["profile"]` wish; the round-trip is
  proven by composition, not directly observed end-to-end.
