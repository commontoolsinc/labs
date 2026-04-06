# CFC UI Helper Contract

**Status:** Drafted from the `exp/cfc-impl-2` prototype for replay on current
`main`
**Scope:** `packages/api`, `packages/ts-transformers`,
`packages/schema-generator`, `packages/runner/src/builder/cfc-ui.ts`

This document specifies the compile-time and builder-time contract for the CFC
UI helpers added on this branch. These helpers are authoring sugar for trusted
UI contracts; they are not generic component macros.

## Source Of Truth

Prototype implementation and tests:

- `packages/api/index.ts`
- `packages/runner/src/builder/cfc-ui.ts`
- `packages/ts-transformers/src/transformers/cfc-jsx.ts`
- `packages/ts-transformers/src/transformers/schema-injection.ts`
- `packages/ts-transformers/test/cfc-authoring.test.ts`
- `packages/patterns/integration/cfc-ui-direct-command.test.ts`
- `docs/proposals/cfc-ui-output-integrity-delegation.md`

## Recognized Helpers

The current helper set is closed and explicit.

| Helper | Default emitted tag | Semantic props | Emitted data attrs | Added integrity atom |
| --- | --- | --- | --- | --- |
| `UiAction` | `ct-button` | `as`, `action` | `data-ui-action` | `https://commonfabric.org/cfc/atom/UiActionContract` |
| `UiPromptSlot` | `ct-textarea` | `as`, `surface`, `role` | `data-ui-surface`, `data-ui-role` | `https://commonfabric.org/cfc/atom/UiPromptSlotContract` |
| `UiDisclosure` | `ct-card` | `as`, `kind` | `data-ui-disclosure-kind` | `https://commonfabric.org/cfc/atom/UiDisclosureContract` |

Adding a new helper requires coordinated changes across API exports, JSX
rewriting, schema hint synthesis, and builder/runtime helper code.

## JSX Rewrite Contract

`CfcJsxTransformer` owns the compile-time rewrite.

Given a recognized helper element:

1. Replace the helper tag with the intrinsic tag from `as` or the helper's
   default tag.
2. Remove helper-only props from the semantic prop bag.
3. Preserve all non-helper props and all children.
4. Re-emit the semantic props as `data-ui-*` attributes on the intrinsic node.

Example:

```tsx
<UiAction action="SubmitDirectCommand" onClick={submit}>Go</UiAction>
```

lowers to:

```tsx
<ct-button data-ui-action="SubmitDirectCommand" onClick={submit}>Go</ct-button>
```

The builder helper in `packages/runner/src/builder/cfc-ui.ts` must implement
the same runtime shape so authored use and transformed use converge.

## Schema Hint Contract

The helper rewrite also has a schema side effect.

When the helper's required semantic props are compile-time string literals,
`CfcJsxTransformer` must attach a node-local schema hint of the form:

```ts
{
  cfcAddIntegrity: [<atom>]
}
```

Current atoms:

- `UiActionContract { action }`
- `UiPromptSlotContract { surface, role }`
- `UiDisclosureContract { kind }`

This is compile-time-only metadata. It does not change the JSX runtime value.

## Literal Versus Non-Literal Inputs

This distinction must remain explicit in the replay:

- If the relevant helper props are present at all, the rewritten JSX still gets
  the corresponding `data-ui-*` attributes.
- If those props are not literal strings, no compile-time `addIntegrity` hint
  may be synthesized for the schema.

In other words:

- runtime DOM/VNode tagging works with dynamic expressions
- schema-level trusted UI contracts only exist for statically known literals

That asymmetry is intentional and must be documented in user-facing guidance.

## `[UI]` Schema Synthesis Contract

`SchemaInjectionTransformer` is responsible for turning returned JSX into a
schema hint for the result type's `[UI]` member.

Required behavior:

1. Find the JSX subtree returned from the pattern builder's `[UI]` property.
2. Find the corresponding `[UI]` property type node on the output type.
3. Synthesize a VNode-like schema for the returned tree.
4. Copy any node-local `cfcAddIntegrity` hints onto the matching synthesized
   schema nodes as `ifc.addIntegrity`.

The synthesized shape in the prototype is a recursive VNode object with:

- `type`
- `name`
- `props`
- `children`

and render-leaf fallbacks for text/expressions.

## Explicit Output Schema Parity

One late regression on this branch was that inferred output schemas and explicit
`pattern(..., explicitOutputSchema)` calls did not receive the same `[UI]`
helper hints.

Normative replay rule:

- if `pattern()` has a statically recoverable output type and a returned JSX
  subtree for `[UI]`, then `[UI]` schema hint seeding must happen regardless of
  whether the final output schema is inferred inline or supplied explicitly via
  a `toSchema<Output>()` binding

This rule is why the replay should treat JSX helper rewriting and schema hint
seeding as one slice.

## Builder Contract

`packages/runner/src/builder/cfc-ui.ts` must mirror the compile-time helper
shape:

- same default tags
- same `data-ui-*` attributes
- same omission of helper-only props from the residual prop bag
- same child normalization

The builder helpers do not enforce trust. They only preserve the semantic shape
that the runner and renderer later consume.

## Out Of Scope

- Trust-lattice evaluation of the emitted integrity atoms
- Renderer provenance frames and event minting details
- Arbitrary user-defined helper recognition

Those belong to runner/UI specs, not this authoring contract.

## Acceptance Coverage

The replay is not complete until these tests pass or equivalent coverage exists:

- `packages/ts-transformers/test/cfc-authoring.test.ts`
- `packages/patterns/integration/cfc-ui-direct-command.test.ts`
