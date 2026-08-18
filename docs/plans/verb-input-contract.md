# The verb input contract: one decision

A verb carries two input schemas, and they diverge by construction. Every
surface that judges a caller's payload has picked one of the two implicitly,
and the next capability in the references arc cannot be built until the pick
is explicit. This document frames that single decision, names what hangs on
it, and recommends an answer. It decides nothing about outputs: a verb's
declared result is already the authored type, end to end.

## The two candidates

**The authored event.** The interface the pattern author wrote — field names,
types, required-ness, and reference declarations such as a `Writable<>`
position. It compiles in full: the pattern's durable `$defs` carry the whole
declared event ([references as arguments](references-as-arguments.md),
"A schema emission fix" — measured).

**The body's usage summary.** The schema the deployed stream cell carries and
the CLI is served. `applyCapabilitySummaryToArgument`
(`packages/ts-transformers/src/transformers/schema-injection.ts`) shrinks the
event parameter to what the handler body actually reads: a declared field the
body never touches disappears from the served `properties` and `required`,
and a reference position's emitted `asCell` marker records the body's
capability use (`["readonly"]` for a read-only body), not the author's
declaration.

The two agree exactly when a handler body reads every field its interface
declares, in the way the interface declares it. Nothing enforces that, so the
contract question is which one a caller is owed when they differ.

## What judges payloads today, and against which candidate

| Surface | Judges against | Consequence when the two diverge |
| --- | --- | --- |
| The CLI's undeclared-field refusal (`verbInputSchemaError`, `packages/cli/lib/callable.ts`) | usage summary | a field the interface declares and the body never reads is refused as "not a field this verb declares" |
| The CLI's flag parser (`parseObjectInput`, `packages/cli/lib/exec-schema.ts`) | usage summary | the same field has no generated flag |
| The generated help page and the verbs listing | usage summary | the page documents a narrower verb than the author wrote |
| The runtime dispatch gate (`closedWorldEventRejection`, `packages/runner/src/runner.ts`) | usage summary, links passed opaquely | a link value passes at any position without a type being consulted |

Every row leans the same way, so today the usage summary is the de facto
contract — including its sharpest edge, recorded when the refusal landed: a
caller who sends a field the interface declares and the body ignores is told
the verb does not declare it. The author and the caller are both reading the
interface; the surface is reading the body.

## What hangs on the decision

**The emitted-address spelling for reference arguments.** The one open gap in
the verb session (demo act 12, the harness's last probe) is accepting the
address a read emits, as printed, where a verb declares a reference. Doing
that safely is schema-directed: the gate converts a string to a reference
only where the position *is* a reference. Under the usage summary, "is a
reference" is an inference from the handler body — a refactor that changes
how the body reads a field silently moves which payloads get converted,
an interface change nobody authored. Under the authored event, it is a
declaration. The conversion is only honest under the second reading.

**The protective refusal beside it.** A shape-matching literal payload in a
reference position still stores a detached copy and reports success (#5560).
Refusing it needs the same answer to "is this position a reference", with the
same two readings.

**The evolution policy.** [Designing verbs so they can change](verb-evolution.md)
versions interfaces and holds compatibility judgments against them. A
contract that shifts when a body is refactored is not versionable; the
policy's checker needs the contract to be the thing an author edits
deliberately.

**The closed-world contradiction.** #5686 records that design rule 1 calls
input schemas closed-world while the runtime, after the #5589 ruling, does
the opposite. Whichever way this decision goes, that document and the rule
resolve together against the same candidate.

## The decision

**Recommendation: the authored event is the contract.** The usage summary
remains real and useful — it is what the runtime provably consumes, the right
basis for capability narrowing and for internal optimization — but it stops
being what a caller is validated against, documented with, or refused by.

The grounds, in order of weight:

1. **A contract must be edited deliberately.** The usage summary changes when
   a body is refactored; under it, every surface above shifts without the
   author touching the interface. The evolution design cannot version that,
   and a caller cannot rely on it.
2. **Both humans in the exchange are already reading the authored type.** The
   author wrote it; the caller reads it in the pattern source and on the help
   page's own claims of provenance. The surfaces are the only parties reading
   the body.
3. **The reference capability needs a declaration, not an inference.**
   Converting a caller's string into a live reference on the strength of a
   guess about the body reintroduces, at the type level, the same
   silent-reinterpretation class the arc's refusals were built to end.
4. **The sharp edge inverts from a bug into behavior.** Refusing a declared
   field because the body ignores it is a misrefusal under this reading, and
   the fix is the same emission change the rest requires.

What the other reading has in its favor — the summary is what dispatch
actually honors, so validating against it never promises delivery the runtime
will not make — is real, and survives the decision: a field the body does not
read is still delivered-and-ignored, exactly as dispatch behaves today. The
contract names what a caller may say; it does not promise every word changes
the outcome.

## What the decision unlocks, in order

1. **Emission serves the authored event** — `schema-injection.ts` injects the
   declared interface (reference markers included) as the stream cell's input
   schema, with the usage summary carried beside it where the runtime wants
   it, not in front of callers. This edit sits in the file the one-file rule
   currently queues behind #5746; it waits its turn.
2. **The judging surfaces follow without code changes of their own** — the
   refusal, the flags, the help page, and the listing all read the served
   schema; serving the authored event corrects all four at once.
3. **String acceptance becomes checkable** — the gate converts the emitted
   address form exactly where the served (now authored) schema declares a
   reference, and demo act 12's refusal flips on the day it lands, announced
   by the demo and the harness as designed.
4. **The protective refusal lands beside it**, closing #5560's silent-copy
   hazard.

## What this document does not decide

How the usage summary travels once it is no longer the served contract —
a second schema beside the first, a runtime-internal annotation, or derived
on demand — is the implementer's call in step 1. Whether dispatch should
begin enforcing the contract it delivers past (#5686's other horn) is the
closed-world question, resolved with that issue, not here. And the date for
step 1 is #5746's to set, per the one-file rule.
