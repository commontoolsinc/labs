# Host Embedding Contract

How a non-shell host (Loom, and any future embedder) mounts labs
components and patterns, and the exact set of seams it may bind to.

> **Audience.** You are an agent or engineer embedding `@commonfabric/ui`
> components and labs patterns in a host that is *not* the labs shell —
> most concretely Loom (`loom-is-the-shell`, Loom PR
> [#3627](https://github.com/commontoolsinc/loom/pull/3627)), but the
> contract is host-agnostic. Read this before you build against a wish
> target, a Lit context, a navigation event, or a CFC label from outside
> the shell.

## Why this document exists

Every profile-integration drift incident so far was **upstream changing a
seam it did not know was a seam**:

- labs#4371 rewrote the profile *create* surface (`cf-input`/`cf-button`
  → a new `cf-submit-input`) days after Loom pinned the vendor — a silent
  blank render on the next bump.
- labs#4415 changed `#profile` resolution semantics
  (`{ordered, defaultValid}`, picker only on genuine ambiguity).
- `cf-cell-link` clicks dispatch `cf-navigate` into the void in Loom
  production today because nothing on Loom's origin listens for the event
  — shipped, silent breakage.

None of these were malicious or careless; the seam simply wasn't named,
so nobody owed it a compatibility thought. An embedder binds to a
*specific* set of seams. This document names that set and each seam gets
a test that **goes red when the contract changes** — so a breaking change
fails CI *upstream, in labs*, instead of silently blanking a render in an
embedder weeks later.

The contract is deliberately narrow. Bind to what is listed here; treat
everything else (component internals, create-surface DOM, resolution
*implementation*) as in motion.

## Seam map

| # | Seam | Package | Test |
|---|------|---------|------|
| 1 | Wish targets + result semantics | `packages/runner` | `test/wish.test.ts` — `describe("host embedding contract: profile wish targets")` |
| 2 | `runtimeContext` / `spaceContext` | `packages/ui` | `src/v2/runtime-context.test.ts` |
| 3 | Navigation events (`cf-navigate`, …) | `packages/shell` (component emitter), `packages/lib-shell` (pattern emitter) | `packages/shell/test/navigate-contract.test.ts` |
| 4 | `getCfcLabel` egress check | `packages/ui` (+ label shape in `packages/runner`) | `src/v2/core/cfc-label.test.ts` — `describe("cfcLabelViewIsPublic (egress check)")` |
| 5 | Guarded-define idiom | `packages/ui` | `src/v2/components/host-embedding-guarded-define.test.ts` |
| 6 | Trusted-mark threat model | `packages/runner` | `test/cfc-ui-contract.test.ts` — `describe("host embedding contract: trusted-mark threat model")` |
| 7 | Pinning is owner-gated, not gesture-gated | `packages/patterns` | `system/profile-home.owner-gated.test.ts` |

---

## 1. Wish targets and result semantics

**Package:** `packages/runner`. **Builtin:**
`packages/runner/src/builtins/wish.ts`. **Test:**
`packages/runner/test/wish.test.ts`.

A host renders the profile by mounting a thin wrapper pattern that calls
`wish({ query: "#profile" })` inside the runtime the host already boots —
never by re-implementing resolution host-side. The wish builtin owns
resolution order, live re-resolution, and the zero-profile create
surface; a host copy would chase upstream forever (this is exactly the
mistake labs#4415 would have broken).

### Well-known targets

Resolved by the runtime builtin from the home default pattern's profile
links:

- `#profile` — the viewer's active profile pattern cell.
- `#profileName` — the profile's `name`.
- `#profileAvatar` — the profile's `avatar`.
- `#profileBio` — the profile's `bio`.
- `#profileSpace` — the space cell containing the profile.

Plus **hashtag search over profile `elements`** with `scope: ["profile"]`
(e.g. `wish({ query: "#car", scope: ["profile"] })`) — the my-car
accumulation idiom, read cross-space, never written cross-space.

Reads are read-only. Writes happen **only** through the profile pattern's
own owner-protected handlers (see seam 7).

### Zero-profile behavior — the `result ?? fallback` idiom

When no profile exists yet:

- **`#profile`** renders the trusted `ProfileCreate` surface inline: the
  wish state's `result` is `undefined`, `error` contains `"profile"`, and
  `[UI]` is a `cf-render` VNode carrying
  `props["data-profile-create-ui"] === "wish"`. (Verified:
  `wish.ts` — `getDefaultProfileCell` throws `WishError("No profile
  exists yet")` when `ordered.length === 0`, and the `#profile` path maps
  that to the create-surface UI. See `wish.test.ts`, *"renders #profile
  wish UI as a create-profile input when the profile is missing"*.)
- **`#profileName` / `#profileAvatar` / `#profileBio` / `#profileSpace`**
  land a `WishError` in the wish state; `result` stays `undefined`.

Consequence for hosts: **every consumer of a scalar profile target must
use `wish.result ?? fallback`.** Hosts ship to users who may never have
opened the profile surface; a bare `wish.result` is `undefined` for them.

### Resolution order — *pending CT-1829*

> The single-result semantics of `#profile` are being settled in the
> sibling issue **CT-1829** (options under review). This subsection
> documents *current* behavior on `main`; it does **not** pre-decide the
> outcome. Re-verify against `getProfileCandidateCells` before depending
> on the exact ordering.

Current behavior (`wish.ts`, `getProfileCandidateCells` ~L334):

1. Candidates come from the home default pattern's `profiles` list, read
   as link references (so a freshly-created cross-space profile still
   counts rather than collapsing the list to `undefined`). Identity is by
   link equality (`Cell.equals`) — there is no synthetic key.
2. Ordered **default-first** (the `defaultProfile` link, when valid),
   then by **MRU** (`mru` list order), then remaining list order.
3. `#profile` with a valid default short-circuits directly to that single
   result — no picker — even among 2+ profiles (labs#4415; regression
   guard in `wish.test.ts`, *"#profile resolves to the default directly
   (no picker) when a default is set among multiple profiles"*).
4. Interactive viewer with 2+ candidates and **no** default → the
   builtin renders the profile-picker sidecar; `result` stays undefined
   until a selection.
5. Headless (`headless: true`) or single candidate → the fast path
   returns `{ result: ordered[0], candidates, [UI] }`.

**Bind to:** the target names, the read-only guarantee, the
`result ?? fallback` idiom, and the fact that `#profile` renders a create
surface at zero profiles. **Do not bind to:** the create-surface DOM
(labs#4371 rewrote it), or a fixed ordering (CT-1829).

**Test:** `wish.test.ts` already carries a thorough profile suite
(`describe("cross-space wish resolution")`). This contract adds a small,
explicitly-labeled `describe("host embedding contract: profile wish
targets")` that pins the load-bearing embedder guarantees in one place:
five targets resolve; zero-profile `#profileName` yields
`result === undefined` (the `?? fallback` idiom); `#profile` at zero
profiles yields the create-surface UI with `result === undefined`. The
resolution-order assertion is marked pending CT-1829 in the test name.

---

## 2. The two host-providable contexts

**Package:** `packages/ui`. **File:**
`packages/ui/src/v2/runtime-context.ts` (8 lines). **Test:**
`packages/ui/src/v2/runtime-context.test.ts`.

```ts
export const runtimeContext = createContext<RuntimeClient | undefined>("runtime");
export const spaceContext = createContext<DID | undefined>("space");
```

These are the **only two contexts a host must provide**. Everything a
mounted component needs from its environment that is host-specific comes
through these:

- `runtimeContext` — the `RuntimeClient` the host already holds; provide
  once at the root theme element.
- `spaceContext` — the mount's space DID; provide **per mount container**
  (two panels from different spaces must each see their own DID).

Verified seam facts:

- The shell's `RootView` provides **exactly these two**
  (`packages/shell/src/views/RootView.ts` — `@provide({ context:
  runtimeContext })` and `@provide({ context: spaceContext })`) and
  nothing else host-specific.
- Consumers use `@consume({ context: runtimeContext, subscribe: true })`
  (e.g. `cf-cell-link`, `cf-profile-badge`, `cf-file-input`,
  `cf-prompt-input`, `cf-code-editor`).
- **All other contexts degrade gracefully without a provider** —
  `cfThemeContext`, keyboard/modal contexts, etc. A component with no
  runtime/space provider still constructs; it simply has no runtime to
  act on. So a host that provides *only* these two gets a working render.
- Both are string-keyed `@lit/context` contexts, and the host bundle must
  share the *same module instance* of `runtime-context.ts` as the
  components (deep-import into one bundle) so context identity matches.

**Test:** `runtime-context.test.ts` asserts both contexts are exported,
are distinct objects, and carry the expected string keys (`"runtime"` /
`"space"`). The key strings are the wire identity of the context; a
rename or a merge into a different context is a breaking change for every
host, and this test catches it. It also documents (in a type-level
position) the value types `RuntimeClient | undefined` / `DID |
undefined`.

---

## 3. Event contracts

Mounted patterns and components communicate navigation intent to the host
through **`CustomEvent`s dispatched on `globalThis`**. A host embeds by
adding `globalThis.addEventListener(...)` for these names. All are
`bubbles: false, composed: false` (defaults) — they are dispatched on
`globalThis` directly, not bubbled from the DOM.

### `cf-navigate` — two emitters, one listener

There are **two** emitter classes, and a host listener must handle both
detail shapes:

1. **Pattern-side** (`navigateTo()` from pattern code): the runtime's
   `navigaterequest` is turned into a `cf-navigate` by `defaultNavigate`
   in `packages/lib-shell/src/runtime.ts` (~L91, dispatched ~L465). The
   detail is a `RuntimeNavigationTarget`:

   ```ts
   // packages/lib-shell/src/runtime.ts:46
   export type RuntimeNavigationTarget = { spaceDid: DID; pieceId: string };
   ```

   This fires only when the embedder passes **no** `navigate` callback
   (pattern-host passes none), so a `globalThis` listener catches it.
   Verified by `packages/shell/test/runtime-navigation.test.ts` (*"does
   not block same-space navigation on piece registration"* asserts
   `detail === { spaceDid, pieceId }`).

2. **Component-side** (`cf-cell-link` / `cf-render` tile / `cf-profile-
   badge` clicks): `navigate()` in `packages/shell/shared/navigate.ts`
   (~L28) dispatches a `cf-navigate` whose detail is an `AppView`
   (`packages/shell/shared/app/view.ts`):

   ```ts
   type AppView =
     | { builtin: "home" }
     | { spaceName: string; pieceId?: string; pieceSlug?: string; mode?: "embed" }
     | { spaceDid: DID;      pieceId?: string; pieceSlug?: string; mode?: "embed" };
   ```

**Host guidance:** bind to the minimal common fields — space (`spaceDid`
or `spaceName`) + piece (`pieceId`) — and loud-log + no-op for anything
you can't route. The two shapes overlap on `{spaceDid, pieceId}`, which
is the safe intersection.

### `cf-replace-navigation`

Same `AppView` detail as `cf-navigate`; dispatched on `globalThis`
(`navigate.ts` ~L40). Replaces the current history entry instead of
pushing.

### `cf-update-page-title`

Detail is a `string` (the new title); dispatched on `globalThis`
(`navigate.ts` ~L55). No emitter exists in a typical embedder's mountable
graph today (the only caller is the shell's own `AppView`) — a host may
listen and update its chrome, or ignore it.

### The new-tab hook: `cf-open-external` — *lands with CT-1830*

> **Not implemented in this change.** Described here as the specified
> contract; it is being implemented in parallel on branch
> `ct-1830-cf-open-external`. Do not depend on it until CT-1830 lands.

Today, a **modifier-click** (Cmd/Ctrl) on `cf-cell-link` / `cf-render`
tile / `cf-profile-badge` bypasses the event entirely: it builds a shell
URL path and calls `globalThis.open(url, "_blank")` directly
(`packages/ui/src/v2/components/cf-cell-link/cf-cell-link.ts` ~L398).
On a host whose origin has no such route, that is a guaranteed 404 tab —
the shipped breakage this contract exists to prevent.

CT-1830 replaces the direct `globalThis.open` with a **cancellable
`cf-open-external` event** carrying the same view target as `cf-navigate`:

- `event.preventDefault()` in a host listener ⇒ the host handles the
  new-tab navigation (route it into the host's own surface).
- Default (no `preventDefault`) ⇒ the component falls back to the current
  behavior (shell URL + `globalThis.open`).

This is the clean embedder hook that lets a host intercept new-tab
navigation the same way it already intercepts in-tab navigation via
`cf-navigate`.

**Test:** `packages/shell/test/navigate-contract.test.ts` asserts the
`navigate()` / `replaceNavigation()` / `updatePageTitle()` functions
dispatch the correct event *names* with the correct detail *shapes* on
`globalThis`. The pattern-side `{spaceDid, pieceId}` shape is already
guarded by `runtime-navigation.test.ts`. `cf-open-external` is **untested
here by design** — it lands and is tested with CT-1830.

---

## 4. `getCfcLabel` as an egress check

**Package:** `packages/ui` (reader helper); label shape in
`packages/runner`. **Files:** `packages/ui/src/v2/core/cfc-label.ts`,
`packages/runner/src/cfc/label-view-core.ts`. **Test:**
`packages/ui/src/v2/core/cfc-label.test.ts`.

A cell handle exposes:

```ts
// packages/runtime-client/cell-handle.ts
getCfcLabel(): Promise<CfcLabelView | undefined>
```

It is a **pure, non-blocking read of the current local store** (no sync
round-trip) that returns the cell's runtime-attested CFC label view:

```ts
// packages/runner/src/cfc/label-view-core.ts
export type IFCLabel = { confidentiality?: unknown[]; integrity?: unknown[] };
export type CfcLabelViewEntry = { path: readonly string[]; label: IFCLabel };
export type CfcLabelView = { version: 1; entries: CfcLabelViewEntry[] };
```

**Why it is load-bearing for an embedder.** A host that persists profile
data *outside the runtime* (e.g. an observed-profile cache in the host's
own store, or an LLM prompt assembled from profile fields) has left the
CFC substrate's enforcement boundary. `getCfcLabel` is how it **fails
closed**: it reads the label and refuses to persist / egress anything
whose label is not public.

**The contract of "public".** A label is public when **no entry carries a
non-empty `confidentiality` clause**. Absence of a label (`undefined`)
and an empty `entries` array both mean public. Any entry with a non-empty
`confidentiality` array is non-public and an egress check must fail
closed on it. (`integrity` atoms — provenance like
`represents-principal`, `authored-by` — do *not* make a value
confidential; they are orthogonal.)

**Why this matters as the label vocabulary grows.** `Confidential<T, X>`
and `ProjectionOf<Root, Path>` exist today only as **compile-time schema
authoring types** (`packages/api/cfc.ts`); there is no runtime
"confidential" label *variant* yet — confidentiality manifests as
`confidentiality` clauses on the label. As CT-1658 / CT-1660 land
structural confidentiality, those clauses become populated. An egress
check written against the `confidentiality`-clause predicate keeps
working; a check that hard-codes today's "always public" assumption
silently starts leaking. **Any change to label semantics or granularity
must account for this egress seam.**

**Test.** This change adds a small pure predicate,
`cfcLabelViewIsPublic(view)`, to `cfc-label.ts` (the shared home for
reading CFC labels on the trusted main thread — exactly where an embedder
egress check belongs), and tests it in `cfc-label.test.ts`. The predicate
*is* the egress contract: it returns `true` for `undefined` / empty
entries / integrity-only labels, and `false` the moment any entry carries
a `confidentiality` clause. The test fails closed by construction — if a
future label shape adds a confidentiality dimension the predicate doesn't
consider, the test that a confidentiality-bearing label is non-public
forces the predicate to be updated.

---

## 5. The guarded-define idiom

**Package:** `packages/ui`. **Files:**
`packages/ui/src/v2/components/*/index.ts`. **Test:**
`packages/ui/src/v2/components/host-embedding-guarded-define.test.ts`.

Every `cf-*` component is **safe to import into a host bundle**: each
component's `index.ts` guards its `customElements.define` (normalized in
labs#4286):

```ts
// e.g. packages/ui/src/v2/components/cf-render/index.ts
if (!customElements.get("cf-render")) {
  customElements.define("cf-render", CFRender);
}
```

There is no shared helper — the guard is inline in each `index.ts`. The
guarantee an embedder relies on: **importing a component module twice (or
importing a component whose tag the host already registered) does not
throw.** Without the guard, a second `import` of the same module — or two
bundles that both include a component — crashes with
`NotSupportedError: 'cf-render' has already been defined`. With it, the
second define is a no-op. This is what lets a host deep-import the full
component set into one bundle and re-mount freely.

**Test:** `host-embedding-guarded-define.test.ts` imports a representative
set of component `index.ts` modules twice (dynamic re-import) and asserts
no throw and that `customElements.get(tag)` stays defined. It goes red if
any component drops its guard (a raw `customElements.define` at module
top level throws on the second import).

---

## 6. Trusted-mark threat model

**Package:** `packages/runner`. **Files:**
`packages/html/src/event-provenance.ts`,
`packages/runner/src/cfc/ui-contract.ts`,
`packages/runner/src/cfc/prepare.ts`. **Test:**
`packages/runner/test/cfc-ui-contract.test.ts`.

The trusted-event mark and `uiContract` machinery
(`verifyTrustedEventRequirements` in `prepare.ts`; `uiContract` on a
write authorization; `markRendererTrustedEvent` / the trusted-DOM
provenance in `ui-contract.ts`) certify that **an event flow originated
from the rendered surface** — a specific pattern's UI, carrying the
declared event-integrity labels. This is an **anti-confused-deputy
defense**: it stops in-runtime *pattern code* from forging an event that
exercises delegated authority it was not handed through the real UI.

**What the mark cannot do — and must not be expected to.** The DOM-side
gate is `event.isTrusted` (`getEventProvenance` in
`event-provenance.ts` — a non-`isTrusted` event yields *no* DOM
provenance). But `isTrusted` is set by the browser for any genuine
dispatched DOM event, **including events synthesized by an
agent-driven browser via CDP** — CDP-injected input events are
`isTrusted === true`. Likewise, a **key-holding CLI** signs commits
directly and never touches the DOM path at all. So the trusted mark
certifies *surface origin*, not *human intent*, and it **cannot** defend
against principal-level actors (the key-holder, the agent driving the
browser).

**Consequence (record this, do not weaken the in-runtime defense).**
Because the mark was never a human-intent gate, **first-class headless
issuance for a key-holding principal is consistent with the threat
model** — a principal who holds the key can already act; asking it to
forge a trusted DOM event (the `trusted-test-event` helper in
`packages/cli/lib/trusted-test-event.ts`) buys no security, only
friction. The right posture is a sanctioned headless issuance path for
key-holders, **not** a weakening of the in-runtime surface-origin
defense, which is doing real work against confused-deputy pattern code.

**Test:** `cfc-ui-contract.test.ts` gains a
`describe("host embedding contract: trusted-mark threat model")` that
pins the load-bearing fact: an **unmarked** event (the stand-in for a
synthetic / non-surface event) does **not** satisfy a `uiContract`, while
a marked renderer event carrying the matching dataset does. This encodes
"the mark certifies surface origin" — if the mark check were weakened to
accept unmarked events, the test goes red. (It cannot test the
`isTrusted`-under-CDP fact directly — that is a browser property, not a
code path; it is stated here as the threat-model rationale.)

---

## 7. Pinning is owner-gated, not gesture-gated — deliberately

**Package:** `packages/patterns`. **Files:**
`packages/patterns/system/profile-home.tsx`,
`packages/patterns/system/profile-create.tsx`. **Test:**
`packages/patterns/system/profile-home.owner-gated.test.ts`.

Pinning an element to a profile (the accumulation idiom) is authorized by
**ownership**, not by a trusted-UI gesture. The single authorized writer
of profile `elements` is `mutateElements` in `profile-home.tsx` (~L199),
and the field is typed:

```ts
// packages/patterns/system/profile-home.tsx
type OwnerProtectedProfileWrite<T, Binding> = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<T, Binding>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

elements: OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>;
```

`OwnerProtectedProfileWrite` carries `WriteAuthorizedBy` (identity /
owner-principal gating) and **no `uiContract`**. Contrast the *create*
surface in `profile-create.tsx`, where `uiContract` **does** appear — on
`TrustedProfileLink` (each link element), gated to the
`ProfileCreateSurface` trusted pattern:

```ts
// packages/patterns/system/profile-create.tsx
export type TrustedProfileLink = Cfc<
  WriteAuthorizedBy<Cell<ProfileHomeOutput>, typeof submitProfileCreation>,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: typeof TRUSTED_PROFILE_CREATE_ACTION;      // "CreateProfile"
      trustedPattern: typeof TRUSTED_PROFILE_CREATE_SURFACE; // "ProfileCreateSurface"
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_CREATE_SURFACE];
    };
  }
>;
```

So the seam is: **creating a profile requires a trusted-UI gesture
(`uiContract`); pinning to an existing profile requires only ownership
(`WriteAuthorizedBy`, no `uiContract`).** This is deliberate.

**Why it matters to a host.** Because pinning is owner-gated, **headless
and cross-pattern pin flows are SANCTIONED**:

- A key-holding principal can pin headlessly (`cf piece call` into the
  `addPiece` stream — `profile-home.tsx` exposes `addPiece:
  Stream<MutateProfileElementsEvent>`, bound to `mutateElements` in
  `"addPiece"` mode, ~L478).
- A cross-pattern "pin this piece to my profile" button dispatches into
  the same `addPiece` stream.

Neither needs a trusted-UI mark. **Future guards on pinning must keep
supporting these** — do not "harden" pinning by adding a `uiContract`
that would break headless and cross-pattern flows; that would conflate
the create seam (correctly gesture-gated) with the pin seam
(correctly owner-gated). Richer pin / arrange flows ride the UI-variants
abstraction (`UI` / `CHIP_UI` / `TILE_UI` + `cf-render variant=…`, see
`packages/ui/src/v2/components/cf-render/cf-render.ts:20-51` and
`normalizeVariant` / `hasVariantValue`), not a new authorization gate.

**Test:** `profile-home.owner-gated.test.ts` is a type/shape contract
test asserting the invariant at its source: the `elements` write type
(`OwnerProtectedProfileWrite`) has no `uiContract` key while
`TrustedProfileLink` (create) does, and `addPiece` is exported as a
`Stream`. It reads the pattern sources and asserts the presence /
absence of the `uiContract` marker on each, so a change that adds a
`uiContract` to the pin writer (silently breaking headless pinning) goes
red.

---

## Summary for embedders

Provide `runtimeContext` + `spaceContext`. Mount a wrapper pattern that
wishes `#profile`. Listen for `cf-navigate` (both shapes) /
`cf-replace-navigation` / `cf-update-page-title` on `globalThis`, and
(with CT-1830) `cf-open-external`. Deep-import the guarded-define
components into one bundle. If you persist profile data outside the
runtime, gate it on `getCfcLabel` failing closed on non-public labels.
Pin through `addPiece` (owner-gated, headless-friendly); create through
the trusted `ProfileCreate` surface (gesture-gated). Every one of those
sentences is a tested seam above — if one breaks, a labs CI job is what
tells you.
