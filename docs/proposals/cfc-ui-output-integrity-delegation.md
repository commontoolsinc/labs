# CFC UI Output Integrity Delegation

## Summary

This proposal treats trusted UI as ordinary CFC integrity, not as a separate
trust channel.

- Pattern output carries concrete implementation provenance, primarily
  `CodeHash(...)`.
- UI-specific roles are expressed as integrity atoms on the relevant output
  paths.
- A verifier maps those concrete atoms to trusted UI concepts on the trust
  lattice.
- Event integrity is minted later by the trusted renderer from rendered-node
  evidence plus the trusted UI concept.

The key composition rule is:

- parent patterns may delegate **placement / slot context**
- child patterns supply **local semantic contracts**
- trust does not cross a composition boundary automatically

## Implemented Runner Substrate

The current runner branch now supports the minimal substrate for this model:

1. UI output subtrees automatically inherit the implementation identity as
   integrity.
   - For ordinary pattern code this is a
     `https://commonfabric.org/cfc/atom/CodeHash` atom.
   - For builtins this is a `https://commonfabric.org/cfc/atom/Builtin` atom.

2. Schema IFC now supports additive integrity via:

```ts
ifc: {
  addIntegrity: [...]
}
```

`addIntegrity` joins onto inherited / local integrity instead of replacing it.

3. Wildcard `*` path segments already work for repeated child slots, so parent
   UI schemas can attach slot-context integrity at paths such as:

```text
/$UI/children/*
/$UI/children/*/actions/share
```

This is enough to express:

- parent slot / placement delegation
- child-local UI contract atoms
- later trust-lattice closure from `CodeHash(...)` to a trusted UI concept

## Proposed Semantic Model

### 1. Concrete Output Integrity

Pattern-produced UI output should carry concrete integrity such as:

- `CodeHash(H_parent)`
- `CodeHash(H_child)`
- `Builtin(name)` for builtin-generated UI

These are concrete atoms, not concepts.

### 1a. Explicit Code Origin For Developer-Facing Trust Configuration

`CodeHash(...)` should remain the concrete integrity atom on the lattice.

However, developers need a practical way to refer back to authored `.tsx` code
when reviewing or configuring trust. The runner now carries an explicit
developer-facing code-origin sidecar alongside `CodeHash`:

```ts
type ImplementationSourceOrigin = {
  bundleLocation?: string;
  sourceLocation?: string;
};
```

The intended meaning is:

- `bundleLocation`: location inside the compiled / hashed bundle
- `sourceLocation`: original authored location recovered through source maps when
  available

This makes the practical developer identity:

> `CodeHash(H)` + "this specific subset / source location within H"

Important constraint:

- trust and authorization should still enforce on `CodeHash(...)`
- source location is a developer-facing locator, not the final trust atom

This avoids overloading `Function.name` or source-map-derived strings as the
security primitive while still making trust statements traceable to real
authored code.

### 2. UI Contracts on Paths

UI semantics should be attached to specific output paths as integrity atoms.

Examples:

- `UiPlacement(surface="Inbox", slot="row")`
- `UiActionContract(action="ShareWithUser")`
- `UiPromptSlotContract(surface="AssistantComposer", role="direct-command")`
- `UiDisclosureContract(kind="SelectionInfluence", resourceRef=..., recipient=...)`
- `UiConsentContract(operation="FindMeetingTime", scopeDigest=...)`

These may appear on wildcard paths for repeated children.

### 3. Verifier-Derived Concepts

A verifier should map concrete output integrity to concepts on the trust
lattice.

Examples:

- `CodeHash(H_rowPattern) -> trusted-message-row-ui`
- `CodeHash(H_directCommandSurface) -> trusted-direct-command-ui`

This keeps the verifier policy narrow and replayable.

### 4. Parent-to-Child Delegation

Parent trust does not automatically flow into a child subtree.

Instead:

- parent contributes slot / placement context at the composition site
- child contributes its own `CodeHash(H_child)` provenance
- child contributes local semantic contract atoms

The effective trusted UI claim is derived from the combination.

For repeated children, `*` means:

> one immediate repeated child instance at this composition site

not “all arbitrary descendants”.

## Why `addIntegrity` Is Needed

Plain `ifc.integrity` is path-local and replacement-oriented in prepared label
materialization. That is too coarse for UI delegation because we often need all
of the following to coexist on the final node path:

- inherited parent slot placement
- auto-injected `CodeHash(...)`
- child-local UI action / disclosure / prompt-slot contract

`ifc.addIntegrity` lets these compose monotonically.

## Example

Parent schema:

```ts
{
  type: "object",
  properties: {
    $UI: {
      type: "object",
      properties: {
        children: {
          type: "array",
          items: {
            type: "object",
            ifc: {
              addIntegrity: [
                {
                  type: "https://commonfabric.org/cfc/atom/UiPlacement",
                  surface: "InboxList",
                  slot: "message-row",
                },
              ],
            },
            properties: {
              action: {
                type: "string",
                ifc: {
                  addIntegrity: [
                    {
                      type: "https://commonfabric.org/cfc/atom/UiActionContract",
                      action: "ShareWithUser",
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
}
```

Resolved effective integrity at `/$UI/children/7/action` can then include:

- `CodeHash(H_parentOrChildProducer)`
- `UiPlacement(surface="InboxList", slot="message-row")`
- `UiActionContract(action="ShareWithUser")`

## Renderer Role

The renderer should not trust arbitrary DOM nodes.

Instead it should:

1. resolve the semantic UI path / subtree from rendered output
2. inspect the effective integrity at that path
3. verify that the path satisfies the required trusted UI concept
4. mint event-side atoms such as:
   - `UserSurfaceInput`
   - `PromptSlotBound`
   - `IntentSurfaceTrusted`
   - `DisclosureRendered`
   - `GestureProvenance`

This keeps the renderer as the minting point for actual user interaction while
still grounding that interaction in pattern output provenance.

## Renderer Provenance Frames

The missing runtime ingredient is not a second copy of the child contract on the
parent tree. It is provenance: for each rendered interactive node, the runtime
must remember which labeled document paths contributed that node.

The concrete type should be:

```ts
type UiProvenanceFrame = {
  link: {
    space: string;
    id: string;
    type: string;
  };
  path: readonly string[];
};
```

The event-side minting rule is then:

1. collect the `UiProvenanceFrame[]` for the event target
2. resolve the effective `shape` integrity for each `(link, path)` pair
3. join those integrity labels in order, deduping exact repeated frames
4. mint the `CfcEventEnvelope` from the joined integrity plus gesture evidence

This is enough to recover:

- parent slot / placement integrity from the parent output document
- child-local action / disclosure / prompt-slot integrity from the child output
  document
- implementation provenance such as `CodeHash(...)` from whichever document
  introduced the frame

### Why This Works For `map`

`map` does not need a special trust rule.

The parent render tree already determines a concrete child position, and the
parent schema can attach wildcard placement integrity at paths such as
`/$UI/children/*`.

For a mapped child interaction, the provenance stack should simply contain both:

- the parent frame, for example `parentDoc@/$UI/children/2/children/0`
- the child-local frame, for example `childDoc@/$UI/children/2`

The parent frame contributes `UiPlacement(...)`.
The child frame contributes `UiActionContract(...)`.

### Plain VNodes And `[UI]` Wrappers

Patterns used as components are already allowed to appear as objects with a
`[UI]` property or cells/refs to such objects. That composition boundary is
already visible to the renderer.

However, a child pattern may also directly return a plain VNode. That is still
fine, because the reconciler works from cells that point into labeled
documents. In that case, the provenance frame should be taken from the cell that
produced the VNode, not from a surviving wrapper object.

So the invariant is:

> provenance is attached to the document path that produced the rendered
> subtree, not to whether the subtree happens to still be wrapped in `[UI]`

## Worker Reconciler Hook Points

The first implementation should thread `UiProvenanceFrame[]` through the worker
reconciler and attach it to registered event handlers.

Recommended hook points:

1. In `packages/html/src/worker/reconciler.ts`, extend the recursive render path
   to accept the current provenance stack:
   - `renderNode(...)`
   - `renderChild(...)`
   - `renderCellChild(...)`
   - `renderChildContent(...)`

2. When a render branch enters a different cell-backed document or follows a
   `[UI]` chain from a different output document, push a new frame derived from
   `cell.getAsNormalizedFullLink()`:

```ts
{
  link: { space, id, type },
  path,
}
```

3. Extend handler registration so each DOM handler ID remembers the provenance
   stack active at the node where it was bound.
   - a parallel `Map<number, readonly UiProvenanceFrame[]>` keyed by `handlerId`
     is enough
   - optionally mirror the same stack onto `NodeState` / `ChildNodeState` for
     debugging and inspection

4. When an event handler is registered for a `Stream`, do not just call
   `stream.send(event)`. Instead:
   - look up the stored provenance stack for that `handlerId`
   - resolve joined integrity from those frames
   - mint a `CfcEventEnvelope`
   - send the envelope into the stream

5. Keep the same provenance-minting logic reusable from `ct test` so the CLI
   harness and the HTML renderer share one interpretation.

### Storage Strategy

This does not need to be authored into user VDOM.

The preferred first implementation is runtime-side state:

- worker reconciler: `Map<number, readonly UiProvenanceFrame[]>` keyed by
  `handlerId`
- optionally main-thread renderer: `WeakMap<Node, readonly UiProvenanceFrame[]>`
  for debug tooling or DOM-origin event dispatch

If a future transport needs a single self-contained rendered artifact, the final
tree may cache a derived projection of these claims. That should be generated by
the runtime, not authored twice by the pattern.

## No Double Authoring

The parent tree and child tree should not be required to carry the same
semantic claim as source-of-truth.

The intended split is:

- parent output tree: placement / delegation
- child output tree: local semantic contract
- render/runtime layer: provenance stack that recovers both at event time

If a final rendered tree later caches the combined result, that cache is a
derived projection, not an additional authored contract.

## Current End-To-End State

The implementation now has an end-to-end browser-backed direct-command example
that demonstrates the intended layering:

- the trusted UI-producing handler is identified by a real authored
  `CodeHash(...)`, with explicit code-origin metadata as the developer-facing
  bridge back to the `.tsx` source
- verifier policy grants that concrete `CodeHash(...)` a higher-level trusted
  direct-command concept
- the browser/runtime path carries `cfcTrustContext` from shell bootstrap into
  the worker runtime and piece execution
- UI-event minting now contributes the generic interaction atoms
  `GestureProvenance` and `UserSurfaceInput`, and the handler requires those
  together with the verifier-derived concept plus contextual
  `PromptSlotBound` and `DisclosureRendered` atoms
- the resulting `submittedActions[]` log is additionally protected by
  `writeAuthorizedBy`, so unauthorized handlers cannot append even if they try
  to call the same mutation path directly

This is enough to demonstrate:

- trusted code may claim and use a specific UI role only when the verifier says
  that code hash is approved
- untrusted code with the same-looking UI contract atoms is still rejected
- authorized mutation and trusted UI submission are separate checks that both
  have to pass

## Current Browser Gap

One gap remains in the browser / piece-wrapper path.

The clicked direct-command button's local `UiActionContract(...)` is authored on
the correct UI schema path, and lower-level runner/html provenance tests can
recover that node-local contract. However, the full browser-backed piece path
does not yet surface that raw button-local atom end to end.

So the current browser demo enforces on:

- verifier-derived trusted handler concept from `CodeHash(...)`
- contextual prompt-slot and disclosure atoms

rather than directly requiring the raw clicked-node `UiActionContract(...)`.

This should be treated as a remaining implementation gap in provenance recovery
through the piece-wrapper browser path, not as a reason to duplicate the action
contract onto both parent and child trees.

The current bundled direct-command requirement is therefore:

- `GestureProvenance`
- `UserSurfaceInput`
- `PromptSlotBound`
- `DisclosureRendered`
- verifier-derived trusted direct-command concept from `CodeHash(...)`

That is already enough to demonstrate the intended layering without pretending
the raw node-local action contract is recovered in the browser path today.

## Open Spec Questions

1. How should semantic UI addresses be represented for nested / mapped child
   patterns?
   - Current practical answer: composed output path with `*` for repeated child
     slots.

2. Should the spec standardize provenance frames directly, or only standardize
   their effect on event minting?
   - The implementation direction here prefers renderer/runtime side tables over
     user-authored VDOM metadata.
   - The spec may only need to require that the renderer can recover the set of
     contributing `(doc, path)` frames for a rendered node.

3. Should verifier rules remain unary (`CodeHash(H) -> concept`) or should the
   spec later add conjunction rules?
   - Unary rules are enough for the minimal model implemented here.
   - Richer parent-slot-child conjunction may eventually want a first-class
     derivation mechanism.

4. Should the spec standardize developer-facing code origin as an explicit
   sidecar to `CodeHash(...)`?
   - Current implementation direction: yes, but only as metadata such as
     `(bundleLocation, sourceLocation)`.
   - Trust closure should still operate on the concrete `CodeHash(...)` atom,
     with code origin used to map authored source back to that hash.
5. Should the spec explicitly distinguish:
   - raw node-local UI contract atoms such as `UiActionContract(...)`
   - verifier-derived trusted UI concepts such as
     `trusted-direct-command-ui`
   - contextual event atoms such as `PromptSlotBound` and
     `DisclosureRendered`
   ?
   - The current browser-backed implementation uses all three layers.
   - The spec should likely describe how they compose into a stronger
     submission-level integrity requirement without collapsing them into a
     single atom family.
