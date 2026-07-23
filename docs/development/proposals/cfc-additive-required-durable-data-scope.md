# Scope CFC's additive-required-default rule to durable document data

*CFC refuses to materialize a newer pattern over an older stored document when the new schema adds a required field with no default. That guard is meant to protect real document data from vanishing — but it currently fires on fields that hold no document data at all (handler streams, framework projection keys), which makes evolving a system pattern silently brick every older-vintage stored doc. Scope the invariant to durable data.*

**Status:** proposed · needs sign-off from the CFC invariant owners (**@seefeldb**, **@mathpirate**) before the rule change lands · **Updated:** 2026-07-23

Grew out of the live Estuary "home space is bricked" incident. Sits behind the deployed heal chain: #4900 / #4926 (cold-start setup repair) and #4933 (data-field defaults). This is the next — and we believe more general — layer.

---

## Why

Estuary home spaces are bricked for existing users but **fine for a fresh identity**. That asymmetry is the whole tell: a brand-new home materializes cleanly, but an *existing* home root — a stored document written by some older vintage of `home.tsx` — fails when the current `home.tsx` is materialized over it during the cold-start setup repair.

The failure is CFC enforcement rejecting the setup commit:

```
CFC enforcement rejected commit: relevant transaction was not prepared:
required field <name> needs a default to preserve old documents
(cfc-relevant-transaction-not-prepared)
```

thrown from `mergeRequired` in `packages/runner/src/cfc/schema-merge.ts`. The rule: when merging a candidate (new) schema over a stored (old) one, **any field that is required in the candidate, absent-and-not-required in the stored doc, and carries no `default`** is rejected — because an old document that predates the field would have no value for it and the merge cannot synthesize one.

That rule is correct *for durable document data*. The bug is that it applies to **every** required field, including fields that hold no preservable data:

- **Handler streams** (`asCell: ["stream"]`) — a stream is a runtime-materialized capability marker, not stored data. Pattern setup re-creates every stream on each run, so an old doc that lacks one has nothing to preserve and there is no meaningful default a `Stream<…>` could ever declare. A handler-rich pattern like `home.tsx` therefore **cannot** be healed field-by-field: give every data field a `Default<>` and the guard just advances to the first handler stream, which by construction can't have one.
- **Framework projection keys** (`$NAME` / `$UI`) — same category: injected by the runtime, not document data.

Because the check fails on the *first* offending field and every user's home is a different vintage, this presents as a **moving target**: favorites for one stored doc, `defaultProfile` for another, a handler stream for a third. It is not one bug with one field — it is an **over-broad invariant that makes any system-pattern evolution brick every older stored document**, one field at a time, until the rule is scoped correctly.

## The two defects

This incident exposed two distinct mechanisms that both produce "additive required field with no default." A complete fix names both.

1. **The invariant over-applies to non-data fields.** Streams and framework keys are required in the emitted schema but hold no preservable document data. The additive-required-default guard should not consider them. *(This proposal's core change.)*

2. **Authors cannot tell which fields are "required" from the type.** `defaultProfile: TrustedDefaultProfile` where `TrustedDefaultProfile = PickerProfileLink<…> | undefined` was emitted **required** — because the schema-generator derives `required` from the absence of a `?` optional marker (`schema-generator.ts`: `if (!member.questionToken) required.push(propName)`), *not* from `| undefined` in the value type. So a field the author intended as optional silently became required-with-no-default and bricked the vintages that lacked it. Fix at the author site (`defaultProfile?`), and consider having the schema-generator treat a `| undefined` value type as optional so this class can't recur silently.

## Proposed change

Scope `mergeRequired`'s additive-required-default requirement to **durable document data**:

- Exempt stream slots (`asCell: ["stream"]`) — a stream has no old value to preserve and no default it could carry. *(Implemented in the accompanying PR: an `isStreamSlot` guard that `continue`s past the default check.)*
- Optionally extend the same exemption to the framework projection keys (`NAME` / `UI` from `builder/types.ts`). Deferred in the PR as a deliberate scope boundary — a *real* home always carries them, so only a fully-degenerate synthetic doc trips them — but it belongs in the same conceptual bucket and the owners should decide whether to include it.
- Keep the negative case intact: an additive-required **plain data** field without a default still throws (verified in the PR's unit pin).

The emitted schemas do not change; only the merge-time invariant is scoped. It does not touch authorization: the additive-required-default rule is a *data-preservation* check, not a `writeAuthorizedBy`/`ifc` check, so exempting non-data fields removes no authorization guarantee. (Validated against the CFC/writer/profile safety suite — see PR.)

## Does anyone have to recreate their space?

For every failure mode we have observed: **no.** The fields that fail are all *new* — absent from the old doc — so there is no data conflict and nothing to discard. The heal mechanism already exists (#4926's cold-start repair re-runs setup in place), and setup's data-seeding is guarded (`materializeDerivedInternalCells`: fills only manifest-missing cells with `currentValue === undefined`) so it never overwrites a user's existing favorites/profiles. Once the invariant is scoped correctly, materialization over an old vintage succeeds and the home heals **in place, on next load, with no recreation and no data loss** — for everyone, regardless of version.

The only thing that would force a recreate is a genuinely *incompatible* stored state — real data that cannot map to the current schema, or a corrupted doc. We have **zero evidence** of that; everything observed is the healable "missing new field" kind.

## This is not proven complete — the acceptance criterion

We have peeled four "last" layers in this incident (compile → `$stream` marker → CFC additive-required → …). We should not declare this the final one by reasoning alone. Two specific gaps:

- One vintage's exact throw (`favorites`, on the incident reporter's own home) **could not be reproduced locally** — current `home.tsx` over a synthetic pre-favorites doc defaults favorites cleanly and advances to `defaultProfile`. So there is at least one mechanism we do not yet understand for that specific stored doc (candidate for a production-compile / durable-compile-cache / `eagerSourceAnnotation=false` difference — needs the actual stored schema to see).
- The additive-required check is only *one* CFC invariant; others, or other setup steps, could reject some vintage we have not loaded.

**Acceptance criterion:** a **population test** — take a corpus of real stored home-root schemas across vintages and materialize current `home.tsx` over each with CFC enforcement *on*, and enumerate which heal. That converts "are we chasing a moving target?" from a guess into a measured list, and is the signal that the scoped rule is *sufficient* rather than merely the next layer. This proposal should not be considered done until that test is green across the corpus.

## The testing gap that let this through

The cold-start repair harness (`packages/piece/test/check-update-default-pattern.test.ts`) runs with `cfcEnforcementMode: "disabled"`. That is why #4926 and #4933 passed their tests but failed in production against the enforcing runtime — the tests never exercised the layer that rejects the commit. The accompanying PR adds the first repro that runs enforcement **on** (`packages/runner/test/cfc-additive-default-preserves-old-doc.test.ts`); the harness gap itself should be closed so future setup-over-old-doc changes are validated against enforcement by default.

## What's landed / in flight

- **Deployed to Estuary** (`67abf6131`): #4900, #4926, #4933.
- **This PR** (draft, for review): the `isStreamSlot` exemption in `mergeRequired`, `defaultProfile?` at the author site, and the enforcement-on regression test. A concrete, validated *partial* — it fixes the stream and `defaultProfile` classes, but is explicitly **not** claimed to be the complete heal until the population test above is run.
