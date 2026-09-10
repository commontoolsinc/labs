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

## Nested pattern outputs

A pattern embedded in another pattern's view reaches the reconciler as one
cell: the parent's `$UI` holds a link to the sub-pattern's result document, and
`renderCellChild` fits that cell's label against the ceiling before rendering
anything below it. A label covering the result document decides the whole
sub-view — the sub-pattern's headings, its controls, and the render boundaries
inside it, which the walk stops short of.

The labels a sub-pattern's result document carries are the ones its own fields
earned. A field aliasing an argument cell carries that cell's label through the
link machinery. A field fed by a lift or a handler carries the join that
module makes onto its own result (`applyArgumentIfcToResult`, called from
`packages/runner/src/builder/module.ts`), except where a built-in sets
`propagateInputIfc: false` because it resolves label views at run time
instead — `llmDialog` is the one that does. And under
`cfcFlowLabels: "persist"` the per-transaction join is written as a `derived`
component on each value write target; at `observe` it only reaches a
diagnostic, and at `off` nothing derives it.

The declared result schema adds none of its own: `factoryFromPattern` stores
the schema the author declared, so a pattern that accepts a confidential
argument does not thereby label its own view. That division is §8.12.8's. It
gives the `declared` component schema `ifc` declarations and explicit
store-label operations under a monotone discipline, and gives a transaction's
measured dependency to the `derived` component under replace-on-overwrite,
because a ratchet applied to a measurement is the label creep that section
opens by ruling out. A join taken over the shape of an argument schema
measures no transaction, so the declared component is not where it belongs;
the flow join above is. §8.9.1 reaches the same place from the other side, for
the collection helpers it is written about: where a runtime can decompose an
operation, the conservative join is a structural fact of the journal and no
claim is involved. A pattern body reads no value, so the join over its build
transaction is empty by construction.

Two consequences follow. The
render boundaries a sub-pattern declares are reached, so a nested
`declassifyConfidentiality` reaches the parent policy as a union
(`childRenderPolicyForNode`), fail-closed to nothing under a
`"deny"` declassification policy. And the write-policy grant recorded for each
result binding (`recordOutputSchemaPolicyInputs`) is the schema at that
binding's own path rather than one raised by a root entry, which narrows the
grant — the direction that refuses rather than admits.

`packages/runner/test/cfc-argument-ifc-propagation.test.ts` holds each builder
against its own schema, and `packages/runner/test/pattern.test.ts` measures
where the label reaches the result instead. The `cfc-render-policy-demo`
integration test drives the composed case under the ceiling.
