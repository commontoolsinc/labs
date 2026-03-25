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

## Open Spec Questions

1. How should semantic UI addresses be represented for nested / mapped child
   patterns?
   - Current practical answer: composed output path with `*` for repeated child
     slots.

2. Should the spec standardize reserved VDOM metadata for UI contract binding?
   - The runner substrate here only handles integrity on output paths.
   - Renderer-facing node metadata is still an open design layer.

3. Should verifier rules remain unary (`CodeHash(H) -> concept`) or should the
   spec later add conjunction rules?
   - Unary rules are enough for the minimal model implemented here.
   - Richer parent-slot-child conjunction may eventually want a first-class
     derivation mechanism.
