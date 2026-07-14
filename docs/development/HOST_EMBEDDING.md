# Host Embedding Contract

The seams a non-shell host (Loom, or any future embedder) may bind to
when mounting labs components and patterns, plus two policy records
upstream commits to honor. Each seam has a labs-side test that goes red
when the contract changes.

> **Audience.** You are embedding `@commonfabric/ui` components and labs
> patterns in a host that is *not* the labs shell — most concretely Loom
> ([loom#3627](https://github.com/commontoolsinc/loom/pull/3627)). Bind
> only to what is listed here; treat everything else (component
> internals, create-surface DOM, resolution *implementation*) as in
> motion.

## Why this document exists

Every drift incident in the Loom profile integration was upstream
changing a seam it did not know was a seam: labs#4371 rewrote the
profile create surface days after the vendor pin; labs#4415 changed
`#profile` resolution; `cf-cell-link` clicks dispatch `cf-navigate` into
the void in Loom production because nothing listens. Naming the seams —
and testing each one — means a change that breaks an embedder fails CI
upstream in labs instead of silently blanking a render in the embedder
weeks later.

## Seam map

| # | Seam | Kind | Package | Loom binds today | Test |
| - | --- | --- | --- | --- | --- |
| 1 | Wish targets + result semantics | API | `runner` | yes | `test/wish.test.ts` — `host embedding contract: profile wish targets` |
| 2 | `runtimeContext` / `spaceContext` | API | `ui` | yes | `src/v2/runtime-context.test.ts` |
| 3 | Navigation events | API | `shell`, `lib-shell` | `cf-navigate` yes; `cf-open-external` yes (with CT-1830); others available, not bound | `test/navigate-contract.test.ts` |
| 4 | `getCfcLabel` egress check | API | `ui` (label shape in `runner`) | yes | `src/v2/core/cfc-label.test.ts` — `cfcLabelViewIsPublic (egress check)` |
| 5 | Guarded-define idiom | API | `ui` | yes | `src/v2/components/host-embedding-guarded-define.test.ts` |
| 6 | Trusted-mark threat model | policy record | `runner` | n/a | `test/cfc-ui-contract.test.ts` — `host embedding contract: trusted-mark threat model` |
| 7 | Pinning is owner-gated | policy record | `patterns` | n/a | `system/profile-home.owner-gated.test.ts` |

---

## 1. Wish targets and result semantics

**Contract.** The runtime resolves the well-known profile targets
`#profile`, `#profileName`, `#profileAvatar`, `#profileBio`,
`#profileSpace`, and hashtag search over profile elements with
`scope: ["profile"]`. Reads are read-only; writes go only through the
profile pattern's own owner-protected handlers (seam 7). At zero
profiles, `#profile` renders the trusted create surface inline and its result
channel carries an error availability value; scalar targets do the same.
Consumers that present the missing-profile UI guard the original result
channel with `hasError()`. Ordinary consumers use `resultOf(wish.result)` and
wait. Resolution order among multiple profiles is default-first, then
most-recently-used, then list order (CT-1829).

**Test.** `packages/runner/test/wish.test.ts`,
`describe("host embedding contract: profile wish targets")`.

A host renders the profile by mounting a thin wrapper pattern that
wishes `#profile` inside the runtime it already boots — never by
re-implementing resolution host-side. Full wish semantics:
[docs/common/conventions/wish.md](../common/conventions/wish.md).

---

## 2. The two host-providable contexts

**Contract.** `runtimeContext` (value `RuntimeClient | undefined`, key
`"runtime"`) and `spaceContext` (value `DID | undefined`, key
`"space"`), exported from `packages/ui/src/v2/runtime-context.ts`, are
the only two contexts a host must provide: `runtimeContext` once at the
root, `spaceContext` per mount container. All other contexts degrade
gracefully without a provider. The host bundle must share the same
module instance of `runtime-context.ts` as the components so context
identity matches.

```ts
import { runtimeContext, spaceContext } from "@commonfabric/ui";

// The published seam (packages/ui/src/v2/runtime-context.ts, 8 lines):
//   runtimeContext = createContext<RuntimeClient | undefined>("runtime")
//   spaceContext   = createContext<DID | undefined>("space")
export const hostProvidedContexts = [runtimeContext, spaceContext] as const;
```

(The import above is live — this doc block itself type-checks against
the real export, so a rename fails the docs check.)

**Test.** `packages/ui/src/v2/runtime-context.test.ts`.

---

## 3. Event contracts

**Contract.** Mounted patterns and components signal navigation intent
via `CustomEvent`s dispatched on `globalThis` (not bubbled from the
DOM). A host embeds by listening for:

- **`cf-navigate`** — two emitters, one listener. Pattern-side
  (`navigateTo()`), the detail is a `RuntimeNavigationTarget`;
  component-side (`cf-cell-link` / `cf-render` tile / `cf-profile-badge`
  clicks), the detail is an `AppView`. Bind to the common fields —
  space + `pieceId` — and loud-log + no-op anything else.

  ```ts
  import type { DID } from "@commonfabric/identity";

  // packages/lib-shell/src/runtime.ts
  export type RuntimeNavigationTarget = { spaceDid: DID; pieceId: string };
  ```

  ```ts
  import type { DID } from "@commonfabric/identity";

  // Condensed from packages/shell/shared/app/view.ts
  export type AppView =
    | { builtin: "home" }
    | { spaceName: string; pieceId?: string; pieceSlug?: string; mode?: "embed" }
    | { spaceDid: DID; pieceId?: string; pieceSlug?: string; mode?: "embed" };
  ```

- **`cf-replace-navigation`** — same `AppView` detail; replaces the
  current history entry instead of pushing. Available; Loom does not
  bind it today.
- **`cf-update-page-title`** — detail is the title `string`. Available;
  Loom does not bind it today.
- **`cf-open-external`** — *lands with CT-1830 (branch
  `ct-1830-cf-open-external`); described as specified, not implemented
  in this change.* A cancellable event carrying the same view target as
  `cf-navigate`, replacing the direct `globalThis.open` on
  modifier-clicks (today a guaranteed 404 tab on a non-shell origin).
  `preventDefault()` ⇒ the host handles the new tab; default ⇒ shell
  URL + `globalThis.open`.

**Test.** `packages/shell/test/navigate-contract.test.ts` (event names
and detail shapes); the pattern-side shape is also guarded by
`packages/shell/test/runtime-navigation.test.ts`. `cf-open-external` is
untested here by design — it lands and is tested with CT-1830.

---

## 4. `getCfcLabel` as an egress check

**Contract.** A cell handle exposes
`getCfcLabel(): Promise<CfcLabelView | undefined>` — a pure,
non-blocking read of the cell's runtime-attested CFC label. A host that
persists cell data *outside the runtime* (a host-side cache, an LLM
prompt) has left the CFC enforcement boundary and must **fail closed**:
egress only what is public. A label is public iff no entry carries a
non-empty `confidentiality` clause; an absent label and empty entries
are public; `integrity` atoms are orthogonal and do not make a value
confidential.

```ts
// packages/runner/src/cfc/label-view-core.ts
export type IFCLabel = { confidentiality?: unknown[]; integrity?: unknown[] };
export type CfcLabelViewEntry = { path: readonly string[]; label: IFCLabel };
export type CfcLabelView = { version: 1; entries: CfcLabelViewEntry[] };
```

The predicate is exported as `cfcLabelViewIsPublic` in
`packages/ui/src/v2/core/cfc-label.ts`. This seam is load-bearing as
`Confidential` / `ProjectionOf` land structurally (CT-1658 / CT-1660):
those `confidentiality` clauses become populated, and a check written
against this predicate keeps failing closed. Any change to label
semantics or granularity must account for this egress seam.

**Test.** `packages/ui/src/v2/core/cfc-label.test.ts`,
`describe("cfcLabelViewIsPublic (egress check)")`.

---

## 5. The guarded-define idiom

**Contract.** Every `cf-*` component is safe to import into a host
bundle: importing a component module twice, or importing a component
whose tag is already registered, does not throw (normalized in
labs#4286). Each component's `index.ts` guards its define:

```ts
// Shown at module scope.
// e.g. packages/ui/src/v2/components/cf-render/index.ts
import { CFRender } from "./cf-render.ts";

if (!customElements.get("cf-render")) {
  customElements.define("cf-render", CFRender);
}
```

This is what lets a host deep-import the full component set into one
bundle and re-mount freely.

**Test.**
`packages/ui/src/v2/components/host-embedding-guarded-define.test.ts`.

---

## 6. Policy record: trusted-mark threat model

Not a bindable API — a statement upstream commits to honor.

The trusted-event mark (the `uiContract` machinery in
`packages/runner/src/cfc/`) certifies that an event flow **originated
from the rendered surface** — an anti-confused-deputy defense against
in-runtime pattern code exercising delegated authority it was not
handed through the real UI. It certifies *surface origin*, not *human
intent*: it cannot defend against principal-level actors — a
key-holding CLI never touches the DOM path, and an agent-driven
browser's CDP-injected events are `isTrusted === true`.

**Consequence.** First-class headless issuance for key-holding
principals is consistent with the threat model — forcing a key-holder
through trusted-DOM-event forgery buys no security, only friction. The
right posture is a sanctioned headless issuance path, **not** a
weakening of the in-runtime surface-origin defense, which does real
work against confused-deputy pattern code.

**Test.** `packages/runner/test/cfc-ui-contract.test.ts`,
`describe("host embedding contract: trusted-mark threat model")` — an
unmarked event with a lookalike provenance is rejected; the same
provenance carrying the renderer mark is accepted.

---

## 7. Policy record: pinning is owner-gated, not gesture-gated

Not a bindable API — a statement upstream commits to honor.

Pinning an element to a profile is authorized by **ownership**, not by
a trusted-UI gesture: the single authorized writer of profile
`elements` (`mutateElements` in
`packages/patterns/system/profile-home.tsx`) is typed
`OwnerProtectedProfileWrite` — `WriteAuthorizedBy` plus owner
principal, with **no `uiContract`**. Creating a profile, by contrast,
*is* gesture-gated: `profile-create.tsx` carries the only `uiContract`
(the `ProfileCreateSurface` trusted pattern).

**Consequence.** Headless pinning (`cf piece call` into the `addPiece`
stream) and cross-pattern pin flows are **sanctioned** use cases.
Future guards must keep supporting them — do not "harden" pinning with
a `uiContract`; that conflates the create seam (correctly
gesture-gated) with the pin seam (correctly owner-gated). Richer
pin/arrange flows ride the UI-variants abstraction (`UI` / `CHIP_UI` /
`TILE_UI` + `cf-render variant=…`), not a new authorization gate.

**Test.** `packages/patterns/system/profile-home.owner-gated.test.ts` —
asserts against the real pattern sources that the pin writer carries no
`uiContract` while the create surface does, and that `addPiece` is a
`Stream`.

---

## Summary for embedders

Provide `runtimeContext` + `spaceContext`. Mount a wrapper pattern that
wishes `#profile`. Listen for `cf-navigate` (both shapes) on
`globalThis`, and (with CT-1830) `cf-open-external`. Deep-import the
guarded-define components into one bundle. If you persist profile data
outside the runtime, gate it on `getCfcLabel` failing closed on
non-public labels. Pin through `addPiece` (owner-gated,
headless-friendly); create through the trusted `ProfileCreate` surface
(gesture-gated). Every one of those sentences is a tested seam above —
if one breaks, a labs CI job is what tells you.
