# Scope: trusted-agent tool-input integrity (llmDialog / generateObject)

**Status:** Scoping (not implemented). Tracks the "trusted agent" work split
out of the agent prompt-injection demo investigation. The demo *loads* (it was
made SES-loadable by #4222, which moved the CFC authoring vocabulary into the
`commonfabric/cfc` host module, and is guarded by `cf check` per #4153), but its
central security invariant is not enforced — verified still-broken on current
`main` by the `it.ignore`'d
`packages/runner/test/cfc-agent-tool-input-integrity.test.ts`.

## Problem

The spec's defense against prompt injection is **structural**: a routing/control
field on a sink tool (e.g. `sendMail.recipient`) declares
`ifc.requiredIntegrity: [Builtin(agent-kernel), UserSurfaceInput,
PromptSlotBound]`, and the runtime refuses the tool call unless the value passed
to that field carries that integrity. Bytes the model copied out of a hostile
briefing carry none of it (spec §13.6; `~/src/specs/cfc/demos/01-agent-prompt-injection.md`;
`components-llm.md`: *"LLM output is bytes the user did not type … it cannot
honestly carry `AdmittedHere` integrity"*).

Today that invariant is **not enforced**. Reproduced (runner, mock mode,
`enforce-explicit`): a `sendMail` tool call with `recipient: "bob@evil.org"`
**is sent**. Three gaps compose:

1. **Tool inputs are never checked against their own `requiredIntegrity`.** The
   dialog tool path (`llm-dialog.ts` `handleInvoke` / `executeToolCalls`) uses a
   tool's `inputSchema` only to validate/strip input *structure*. It never
   consults `ifc.requiredIntegrity` on the model-supplied input.
2. **The enforced gate runs on the wrong surface.** `verifyInputRequirements`
   (in `prepareBoundaryCommit`) checks `requiredIntegrity` on **writes** against
   the write target's schema. The demo's handler writes `recipient` into
   `emails`/`result`, whose schemas carry no `requiredIntegrity`, so the gate
   never sees it.
3. **Vacuous pass on unlabeled literals.** Even if a write *did* target a
   `requiredIntegrity` schema, the gate quantifies over the transaction's
   *consumed reads*; a plain model-output literal has no provenance, so there is
   nothing to fail (audit #14 — sound enforcement needs per-write data-flow
   provenance, the deferred end-state in `docs/plans/runner_cfc_implementation.md`).

The confidentiality axis is in good shape (observation ceiling via
`effectiveObservationCeiling = meet(pattern, deployment)` #4055; sink-request
egress ceiling #4070). This scope is the **integrity axis**.

## Proposed enforcement (for review)

Three pieces, each independently landable; (A) is the minimum that makes the
demo's invariant hold for the realistic attack.

### A. Enforce tool-input `requiredIntegrity` at invoke time

Before a tool handler runs, validate each model-supplied input field against its
`inputSchema`'s `ifc.requiredIntegrity`. The value the model put in the field is
untrusted (it is model output — see B), so a field requiring
`[UserSurfaceInput, PromptSlotBound, …]` can only be satisfied by an input the
model passed **by reference** to an integrity-bearing cell (an opaque handle /
`{ "@link": … }`), never by a copied string literal. A field whose value is a
bare string fails closed when it declares `requiredIntegrity`.

- Seam: `handleInvoke` in `llm-dialog.ts` (and the `llm.ts` tool path), where
  `toolCall.input` is cellified before the handler is called.
- Reuse the existing integrity-membership logic from `prepareBoundaryCommit`
  (`verifyInputRequirements`) rather than a parallel implementation, so the
  invoke-time check and the commit-time gate can't drift.
- Failure → an error tool-result message (the loop continues; the model is told
  the call was refused), matching how `toolAllowsObservedConfidentiality`
  already denies over-confidential tool calls.

### B. Stamp model output and tool results as untrusted (`LlmDerived`)

The builtins do not label model output today, so "untrusted" is merely *absence*
of integrity — fragile, and the root of the vacuous pass. Stamp model-produced
bytes (assistant content, tool-result messages written back) with an
`LlmDerived` integrity atom at the point they enter the store
(`createToolResultMessages` / the message append in `llm-dialog.ts`). Then a
`requiredIntegrity` gate fails closed *positively* on model-derived values, and
the value's provenance is explicit for downstream flow. (`components-llm.md`
already defines the `LlmDerived` / `DerivedFromAdmitted` atom shape.)

### C. Close the vacuous pass for control fields

For a field carrying `requiredIntegrity`, an *absent* provenance must not be a
pass. Minimal version scoped to this surface: the invoke-time check in (A)
treats a model-supplied scalar as carrying `LlmDerived` (from B) — which by
construction lacks the required atoms — so it fails closed without needing the
full per-write data-flow provenance work. The general fix (per-write provenance)
stays the deferred end-state.

## Open decisions (architect)

1. **Refusal surface.** Error tool-result (loop continues, model can retry with
   a by-reference value) vs. hard commit rejection. Recommend error tool-result
   for agent ergonomics, with the sink write still gated at commit as defense in
   depth.
2. **By-reference contract.** How does a legit recipient reach `sendMail` with
   integrity intact? The direct-command value must be passed as an opaque
   handle/link the kernel resolves, not re-emitted as text by the model. Does
   the demo already model this, or does it need a "bind direct-command field"
   affordance?
3. **Scope of enforcement.** Only fields declaring `requiredIntegrity`
   (opt-in, demo works) vs. all control fields by default. Recommend opt-in
   first.
4. **Interaction with the deferred per-write provenance (#14).** (C) is a local
   shortcut; confirm it's acceptable as an interim or whether to wait for the
   general mechanism.

## Test plan

- Un-ignore `packages/runner/test/cfc-agent-tool-input-integrity.test.ts`
  (injected recipient refused) — the red→green guard for (A).
- Add: a by-reference recipient carrying the required integrity is **allowed**
  (proves (A) doesn't over-block the legitimate path).
- Add: a confidential tool result is stamped `LlmDerived` and cannot satisfy a
  later `requiredIntegrity` field (guards (B)).
- End-to-end: drive the demo's two agents via the mock; the unsafe agent's
  injected `sendMail` is refused, the safe agent's direct-command `sendMail`
  succeeds.

## Risk / blast radius

- Invoke-time enforcement only fires for tools whose `inputSchema` declares
  `requiredIntegrity` — no behavior change for tools that don't (opt-in).
- `LlmDerived` stamping touches every tool result; gate it behind enforcement
  mode and verify it doesn't perturb existing llm-dialog tests (several assert
  tool results flow back unchanged).
