# CFC render-boundary composition

How nested CFC render boundaries (`<cf-cfc-render-boundary>`,
`<cf-cfc-authorship>`) combine in the HTML worker reconciler
(`packages/html/src/worker/reconciler.ts`, `childRenderPolicyForNode`).

## Invariant: boundaries compose monotonically

A render boundary is a trust gate around a subtree. Nesting one boundary inside
another may only ever **tighten** the effective policy — never relax it. Two
consequences a reviewer can check directly:

- An **inner** boundary cannot widen, shed, or re-permit anything an
  **enclosing** boundary restricted.
- An enclosing boundary's "this subtree is clean" signal (rendered content for
  confidentiality; `textIntegrityState="ok"` for text integrity) must hold for
  **every node it transitively encloses**, not just its direct children.

Violating either is a security bug: the first launders trust (untrusted content
renders under a boundary that was supposed to vouch for it); the second is a
false "verified" over content that failed the enclosing boundary's bar.

## Confidentiality (`maxConfidentiality`)

Composes by **intersection / narrowing**. `narrowMaxConfidentiality` intersects
the parent bound with the boundary's local bound, so an inner boundary can only
lower the ceiling. `declassifyConfidentiality` accumulates as a union but is
gated by the render declassification policy (fail-closed under `deny`).
Regression guard: "preserves an outer unlabeled-only boundary through an
unbounded child boundary" in `test/worker-reconciler-cfc-render-policy.test.ts`.

## Text integrity (`requiredTextIntegrity` / `allowLiteralText`)

Composes the same way — the meet of the parent and inner policies (CT-1796):

- `requiredIntegrity` = **union** of every enclosing boundary's required atoms
  (more enclosing requirements ⇒ stricter).
- `allowLiteralText` = parent `&&` inner (an absent parent is unconstrained); an
  inner boundary can never re-enable literal text an enclosing boundary forbade.
- A block is attributed to **every** enclosing boundary — the policy carries the
  full set of enclosing boundary node ids (`boundaryNodeIds`), and
  `markTextIntegrityBlocked` stamps all of them — so no enclosing boundary can
  stay `"ok"` over content that failed its bar.

Until CT-1796 the text-integrity path **replaced** the enclosing policy at each
inner boundary and attributed blocks only to the nearest boundary, breaking both
halves of the invariant (an inner `allowLiteralText` could re-admit attacker
literals; an outer boundary stayed `"ok"` over a blocked descendant). The
block-attribution machinery (`refreshTextIntegrityBoundaryState`,
`hasTextIntegrityBlockForBoundary`, `markTextIntegrityBlocked`) landed in #4366;
the replace-not-compose policy dated to #3321 (text integrity enforced by
default). Regression guards: the four "nested text integrity …" steps in
`test/worker-reconciler-cfc-render-policy.test.ts` (two mount-time, two reactive
block/unblock).
