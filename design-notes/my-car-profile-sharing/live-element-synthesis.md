# Blocker 2 — how a live MyCar lands on a profile: synthesis & recommendation

Consolidates `live-element-feasibility.md` (Oracle), `live-element-precedents.md`
(Explore), and the design-options analysis. Companion to the Phase-3 failure
(see commit b89bc4c27 and CT-1658).

## The finding (verified)

The live-element mechanism **already ships**: a profile element's `.cell` is a
live `pattern()` instance (`profile-home.tsx` stores `(ProfileCatalogCard(...))
.for(tag)`), and `wish({query:"#car", scope:["profile"]})` resolves to that
instance and exposes its **output fields** — exactly how `shared-profile-demo`
reads `initialNameApplied` off the `#profile` wish. The **only** gap: every
`profile-home` add-handler hardcodes the `ProfileCatalogCard`/`UrlPatternReference`
**stub** patterns (output `{[NAME],[UI]}` — no `selfClaims`), and nothing ever
instantiates `MyCar`. That is precisely why the consumer saw no car.

Two caveats that frame the decision:
- **CT-1658 gates the whole write path.** `profile.elements` *and*
  `selfClaims` are both owner-protected arrays, so adding the element AND adding a
  claim both fail in the dual browser+server runtime until CT-1658 lands. It is
  dual-runtime-specific (server stamps `bundleId`, browser omits).
- **No clean test-only verification.** The `#car` wish resolves the *real*
  `getProfileDefaultCell`, so a fake in-test profile host won't be found.
  Verifying the round-trip therefore requires a real `profile-home` change — i.e.
  it is **Berni-domain**, like CT-1658.

## Options

### A — `profile-home` imports `MyCar` + one catalog branch
Clone `addCatalogElement`: `import MyCar, {CAR_TAG} from "../my-car/main.tsx"`;
add a branch `appendElement({ cell: (MyCar({}) as any).for("my-car"), tag:
"my-car", userTags:[CAR_TAG], title:"My Car" }, elements)` + a button.
- **Blast radius:** edits system `profile-home` (Berni review).
- **Smell:** a **pace-layer inversion** — a System pattern (layer 5/6) importing
  a specific End-User program (layer 7, `MyCar`). Doesn't scale (every profile
  widget → another import).
- **Pros:** smallest possible change. **Cons:** architecturally wrong as a
  permanent solution; fine only as a *demo shortcut*.

### B — generic "add an arbitrary live pattern as a profile element"
Make `profile-home`'s URL/catalog add **instantiate** the referenced pattern as a
live element (not wrap its URL in a display stub). The element's `.cell` becomes a
live instance of whatever pattern the user chose.
- **Blast radius:** larger — `profile-home` + the pattern-resolution/loading path
  (resolve+run a pattern by URL/catalog id). Berni review.
- **Pros:** the *correct* general capability the whole "your stuff lives on your
  profile" vision assumes; no coupling, no pace-layer inversion; reusable for any
  profile widget. **Cons:** more work; "instantiate a referenced pattern live" may
  need real loader support.

### C — data-only: claims as a profile data cell, not a live sub-pattern
Drop `MyCar`-as-a-pattern-on-the-profile; expose claims as an owner-protected
profile **data** field/element tagged `#car` that the wish reads directly.
- **Blast radius:** moves the add-claim logic into `profile-home` (or a generic
  data element) — revisits DESIGN §3.
- **Pros:** simplest read; no live sub-pattern. **Cons:** abandons the design's
  thesis that "my car" is *its own composable pattern* the user instantiates;
  pushes car logic into the profile system. Not recommended.

## Recommendation

1. **Production answer: Option B** (generic live-pattern profile element). It's
   the missing *platform capability* the design implicitly depends on ("your car
   lives on your profile" only works if a profile can host live patterns), avoids
   the pace-layer inversion of A, and is reusable. It is Berni-domain (profile
   system + loader), so it should go to Berni **together with CT-1658** — the two
   are the gate for the whole worked example.
2. **If we want to demo before B lands: Option A as an explicit, labeled
   shortcut** (a `MyCar` catalog branch in `profile-home`), understood as
   throwaway. Still needs CT-1658 for the browser write path, so its value is
   limited until that lands too.
3. **Do not pursue C** unless we deliberately want to simplify away the
   "MyCar is its own pattern" thesis.

## What this means for the build

The remaining Phase-3+ runtime verification is **blocked on two Berni-domain
items**: CT-1658 (owner-protected array writes) and the profile-element mechanism
(B, or the A shortcut). There is no honest test-only path around them. So:
- The producer (`MyCar`, Phases 1-2) and the consumer (`my-car-demo`, Phase 3
  read half) are **built and type-clean**; what's unverified is the cross-space
  round-trip, which needs the above.
- Feeds back into **DESIGN.md §3**: the "how MyCar lands on the profile"
  mechanism was under-specified; it requires Option B (a platform capability) or
  the A shortcut — record this.

## Proposed next step

Take **CT-1658 + Option B** to Berni as the two gating items (both profile/runtime
system). Meanwhile, the only genuinely-independent remaining work is the **Phase-4
`SameAuthorAs` derivation as pure logic** (lift + unit-test the resolve+compare
helper) — but that's the substrate checkpoint, to confirm before starting.
