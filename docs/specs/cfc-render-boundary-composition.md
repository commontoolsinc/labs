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

A pattern embedded in another pattern's view reaches the reconciler through a
Cell. `renderCellChild` fits that Cell's label against the effective ceiling
before rendering its subtree. A covering restriction on the view or its acquired
reference can therefore block headings, controls, and nested render boundaries
before the walk reaches them. A boundary inside a blocked view cannot release
that enclosing restriction.

Under `cfcFlowLabels: "persist"`, a field aliasing an argument Cell retains the
confidentiality of acquiring and selecting its reference, together with the
writing attempt's flow confidentiality. Forwarding that reference does not copy
the target's content labels onto the result. An independently public reference
can name confidential contents, while a reference selected using private data
remains private. Rendering the contents consumes the reference restrictions and
the current target labels for that observation. The legacy flow-off and
flow-observe profiles retain target-label copying; see
[CFC references](cfc-references.md) and
[CFC across spaces](cfc-cross-space-integrity.md).

Render policy inspection follows the reference to its current label metadata
without constructing a value snapshot. It retains the handle's acquisition
history but does not acquire unrelated history from other cells inspected in
the same render transaction. Unavailable label evidence blocks rendering.

`factoryFromPattern` stores the author's declared result schema without adding
a blanket join of the pattern's argument schemas. Explicit result `ifc`
declarations still classify their own paths. In particular,
`Confidential<VNode, ...>` on `[UI]` classifies the authored view itself, so a
ceiling may hide the entire card rather than just a confidential value inside
it. A public card that displays confidential contents keeps the classification
on those contents and lets the render boundary govern their observation.

Lifts and sub-patterns apply their declared argument-schema policy to their
result schemas through `applyArgumentIfcToResult`, called from
`packages/runner/src/builder/module.ts`. The per-node `applyInputIfcToOutput`
walk, reached through `connectInputAndOutputs` in
`packages/runner/src/builder/node-utils.ts`, labels each module's output cells
from that node's input edges, including LLM builtins whose results are written
at runtime. Neither mechanism joins the whole enclosing pattern's argument
schema onto every reachable result. These static declarations establish a floor
at every flow-label setting; measured dependencies can add restrictions but
cannot narrow that floor without the authority required by §8.9.1.

A handler node has `outputs: {}`; its context cells and event stream are inputs.
Its write targets therefore receive no label from the build-time output walk.
The handler's actual observations, including the selected stream reference and
sending flow carried into dispatch, contribute to its transaction's derived
labels under `cfcFlowLabels: "persist"`. Under §8.12.8 these measured dependencies
belong to the replaceable derived component, while authored declarations retain
their own monotone discipline.

A built-in replacing its output link's schema preserves that link's `ifc` through
`schemaCarryingLinkIfc` in `packages/runner/src/cell.ts`. The three list operations
use it for their container schemas, and named scalar aggregates use it for their
result schemas. The list join is conservative: `joinSchema` flattens source
member and container atoms onto the result's container root. §8.5.4.3 requires
the coordinator to retain its structural dependencies; §8.17.1 requires a scalar
aggregate without per-value attribution to retain its contributors' join.
`packages/runner/test/list-result-schema.test.ts` and
`packages/runner/test/cfc-argument-ifc-propagation.test.ts` cover those carriers.

Persistent flow labels separately record the transaction's measured dependencies
as `derived` components; flow-observe mode diagnoses that join without
persisting it.
Forwarding a held private reference or consuming private data can contribute to
that join even when the surrounding markup is literal. Public layout does not
justify dropping those dependencies.

This distinction follows §8.12.8: authored declarations belong to the monotone
`declared` component, while measured dependencies belong to the replaceable
`derived` component. The presence of confidentiality in a pattern's argument
schema alone is not a measurement of its whole view. Conversely, the absence of
an explicit view declaration does not prove that its construction had an empty
flow join.

When the enclosing view and reference fit the ceiling, the walk reaches nested
render boundaries. Their `declassifyConfidentiality` declarations compose through
`childRenderPolicyForNode`, and the host's `"deny"` declassification policy
ignores those declarations. The write-policy grant recorded for each result
binding (`recordOutputSchemaPolicyInputs`) is the schema at that binding's own
path rather than one raised by an unrelated root entry.

`packages/runner/test/cfc-argument-ifc-propagation.test.ts` checks the builder
schema behavior, and `packages/runner/test/pattern.test.ts` checks result-label
placement. `packages/runner/test/cfc-builtin-output-ifc.test.ts` checks the LLM
builtins' static input join with flow persistence both enabled and disabled.
The `cfc-render-policy-demo` integration test requires public cards
and controls to remain visible while the protected content is blocked; under
the render ceiling, the trusted surface's authored declassification cannot
release that content.
