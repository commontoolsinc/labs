# Projection keys, and the schema a read is handed

This document designs
[item 2 of the verbs implementation plan](verbs-implementation.md) — refusing a
projection key the reader does not recognize — and the larger rule that refusal
is only half of. It is written to be checkable: every claim about current
behavior below was read out of the named code or measured against it, and the
three places where it corrects the plan it is designing say so in those words.

The command surface it governs is `--schema` on the read commands. The design
in [shaped reads and verb results](shaped-reads-and-verb-results.md) says what a
projection is for; this says what a projection may contain and what leaves the
CLI because of it.

In the plan's own numbering this is item 2, sequenced as step 12 behind step 9
(item 3, a rejection propagating up through what holds it) because both change
how a mask reduces. Its sibling refusal — step 12a, item 12, `cf` refusing an
undeclared field on a call — is independent of it and shares its vocabulary for
what a refusal says.

## The vocabulary, briefly

A **projection** is what a caller writes to `--schema` to say which parts of a
value to read. It has two spellings, and `parseSelectionProjection`
(`packages/cli/lib/cell-selection.ts`) chooses between them by looking at how
the argument starts: `@` names a file holding a JSON Schema, and `{`, `true` or
`false` is one written inline; anything else is the comma-separated field-path
list `--select` takes. **Only the JSON Schema spelling is this document's
subject.**

Three schemas are in play on a read, and keeping them apart is most of the
design:

- The **projection** — the caller's, normalized by `normalizeProjectionSchema`.
- The **source-read schema** — what the CLI asks the runner to load. Built by
  `selectSourceSchema` from the piece's own declared schema, narrowed by the
  mask the projection implies.
- The **output schema** — re-asserted on the result in `deriveSelectedValue` as
  `result.key("value").asSchema(outputSchema)`, and carried as the declared
  result of the computed pattern that performs the read. This is the **read
  boundary**: past it, a schema is the runner's to enforce, and the runner
  enforces everything a JSON Schema can say.

`resolveProjection` builds all three, and it builds them two different ways.
For the concise spelling it derives the output schema through
`selectSourceSchema` — constructed from the source, position by position. For
the JSON spelling it assigns the caller's own object, unchanged, to both
`projectionSchema` and `outputSchema`.

**That asymmetry is the whole of the problem below.** On one path the CLI hands
the read boundary something it built. On the other it hands over what a caller
typed.

## The problem

`normalizeProjectionSchema` consults two denylists — `FORBIDDEN_PROJECTION_KEYS`
(`asCell`, `default`, `ifc`, `scope`) and `UNSUPPORTED_PROJECTION_KEYS` (`$ref`,
`$defs`, `definitions`, the composition and conditional keywords,
`patternProperties`, `prefixItems`, `propertyNames`, `contentSchema`) — and
every key in neither is spread into the result and carried onward. Three
distinct failures come out of that, and they are not variations of one:

| A caller writes | What comes back | Exit |
| --- | --- | --- |
| `{"propertes":{"title":true}}` | nothing | 0 |
| `{"type":"object","propertes":{"title":true}}` | **the whole object**, every field | 0 |
| `{"type":"object","required":["secret"],"properties":{"title":true}}` | nothing | 0 |

**A typo can narrow a read to nothing.** With no `type` stated,
`impliedProjectionType` has nothing to infer a container from — the misspelled
key is in neither `OBJECT_PROJECTION_KEYS` nor `ARRAY_PROJECTION_KEYS` — so the
normalized projection names no container at all. Its own doc comment states
what follows: schema traversal descends `properties` only under
`type: "object"` and `items` only under `type: "array"`, so a position with
neither is silently empty.

**A typo can also widen one.** With `type: "object"` stated, the misspelling
means `declared.properties` is absent, so `normalizeProjectionSchema` takes its
open branch and sets `additionalProperties: true`. The read returns every field
the object holds, including the ones the caller deliberately did not name. This
is disclosure-shaped: the caller's schema is the only thing standing between a
value and its reader, and a single transposed letter removes it while reporting
success.

The widening case is the stronger motivation for this item, and it is the half
the plan does not carry. The plan inherits "a typo selects nothing and says
nothing" from a record written about the no-`type` case alone. Both are real,
they are opposite, and only one of them is in the plan today.

**A recognized key can empty a read entirely.** [#5734]: a projection naming a
`required` field it does not project returns nothing at all, exit 0. `required`
reaches the read boundary in the caller's schema, and
`SchemaObjectTraverser.traverseObjectWithSchema`
(`packages/runner/src/traverse.ts`) returns `undefined` for an object missing a
required property — so the *whole selection* reads as absent, rather than the
one position that declined to be read.

No typo is involved. `required` is spelled correctly, is legal JSON Schema, and
is a key the CLI consults on purpose. That is what makes it the case that
decides the shape of the fix.

## The rule this lands

> **The projection reader must never hand the read boundary a schema it did not
> construct itself.**

Refusing unrecognized keys does not achieve this, and `required` is the proof.
It is recognized. It is consulted — `OBJECT_PROJECTION_KEYS` lists it, so
`impliedProjectionType` reads it to infer an object. And it is then forwarded
verbatim into a schema the runner honors. A classification exercise that ended
at "known keys pass, unknown keys are refused" would file `required` under
*known*, forward it, and leave [#5734] exactly where it is.

So the design has two halves, and the second is the load-bearing one:

1. **A key the projection vocabulary does not contain is refused, by name.**
2. **The schema that crosses the read boundary is built by the reader**, from
   the mask the projection implies and the source schema, on the JSON path as
   it already is on the concise path.

Half 2 is what makes the tiers below meaningful. Once the outgoing schema is
constructed, a tier does not describe what gets forwarded — nothing is
forwarded — it describes what a caller is allowed to write and what the reader
does with it.

Note that `selectSourceSchema` already carries the exact rule half 2 needs,
with a comment giving exactly this reason:

```text
A rejected position holds nothing to require. Keeping it required makes
the object unsatisfiable, which reads as an absent value for the whole
selection rather than for the one position that declined to be read.
```

It filters `required` down to the properties that survived selection. It runs
on the source-read schema and on the concise path's output schema, and never on
the JSON path's. **This item applies an existing rule to a second call site
rather than inventing one.**

## Four tiers

The plan proposes three — honored, tolerated, refused. Four are needed, because
one group of keys is neither honored nor inert: the CLI reads it, acts on it,
and must then stop it from going any further.

| Tier | Meaning | Members |
| --- | --- | --- |
| **H** — Honored | Drives the projection | `type`, `properties`, `items`, `additionalProperties`, `$link` |
| **C** — Consulted | Read for container inference, then dropped | `required`, `minProperties`, `maxProperties`, `minItems`, `maxItems`, `uniqueItems` |
| **T** — Tolerated | Accepted, changes nothing | `ANNOTATION_KEYS` less the three tier R already claims |
| **R** — Refused | Named in an error | Everything else |

**H** is what the reader acts on. `normalizeProjectionSchema` recurses through
`properties` and `items`, lifts `$link` out into markers, and computes
`additionalProperties`; `projectionMask` then reads `type`, `properties`,
`items` and `additionalProperties` to build the mask. `$link` never reaches it,
having been lifted out one step earlier — which is why the marker is honored
without ever being a keyword the mask has to understand.

**C** is the tier the plan is missing, and calling its members "tolerated"
would be false. `impliedProjectionType` decides whether an untyped position is
an object or an array by looking for exactly these six keys — that is the
container inference a caller relies on for nested positions, and it is
behavior, not decoration. Their treatment is: **consumed during inference, then
absent from what the reader constructs.** A key that changed the read and was
then dropped is a third thing, and a registry that records a class rather than
a spelling — which the plan rightly asks for — has to be able to say so.

**T** is derived, not restated. Its source is `ANNOTATION_KEYS`
(`packages/piece/src/schema-compatibility.ts`), the compatibility checker's
record of which keywords are validation-neutral. Deriving is what keeps the two
registries from forking when a keyword like `tier` or `deprecated` is added to
the durable dialect. Because the outgoing schema is constructed, a tolerated key
has no forwarding question attached to most of its members; where one arises —
`$id` and `$schema` declare the identity and dialect of a *document*, and the
reader is not producing the caller's document — the answer is to accept and
drop.

**R** is everything else, and it keeps three keys that are *also* annotation
keys: `default`, `$defs`, and `definitions`. All three are refused today, for
good reasons that survive this change — `default` is controlled by the source
schema, and the two definition keys have no meaning without the `$ref` that
projection also refuses.

## Three corrections this design makes to the plan

### 1. "One edit admits a key to both" is not true

The plan states that deriving the tolerated set from `ANNOTATION_KEYS` means one
edit admits a key to both registries, and that where derivation is impossible
the fallback is "a test asserting every annotation key the checker knows is
non-refused by the projection reader."

`ANNOTATION_KEYS` has twelve members: `$comment`, `$defs`, `$id`, `$schema`,
`default`, `definitions`, `deprecated`, `description`, `examples`, `tags`,
`tier`, `title`. Three of them — `default`, `$defs`, `definitions` — are already
refused by projection and must stay refused. So the relation is not identity but
**`ANNOTATION_KEYS` minus a stated exception set**, and admitting a key to the
compat dialect admits it to projection only if it is not one of the three.

The consequence for the fallback test is concrete: **as the plan words it, that
test is red the day it is written**, because three of the twelve keys it asserts
are non-refused are refused on purpose. What it should assert instead is the
exception relation itself:

> Every member of `ANNOTATION_KEYS` is either tolerated by the projection
> reader or listed in projection's stated exception set, and every member of
> that exception set is a member of `ANNOTATION_KEYS`.

That second clause is the one that earns the test. It fails when a key is
dropped from `ANNOTATION_KEYS` and left stranded in projection's exception list,
which is the drift a one-directional assertion misses.

`ANNOTATION_KEYS` is a module-private `const` in
`packages/piece/src/schema-compatibility.ts`; it is not exported from that
module, `packages/piece/src/index.ts` does not re-export it, and the package
declares exactly two entry points (`.` and `./ops`), neither of which reaches
schema-compatibility. So deriving requires exporting it. `packages/cli` already
imports `@commonfabric/piece` and `@commonfabric/piece/ops` (in
`packages/cli/lib/piece.ts` and `packages/cli/lib/callable.ts`), so the
dependency runs from Operation down to Capabilities and introduces no inversion.
Whether the export is the set itself or a predicate over it is an
implementation call; the fallback test above is worth having either way, because
it is what catches an exception list that stops matching its source.

### 2. The validation half must not be derived

The plan's tolerated tier is described as "the annotation and validation
keywords". Deriving the annotation half is right. Deriving the validation half
from the same file would be wrong, and the wrongness is not subtle.

The compatibility checker's set of keys it can reason about is assembled in
`unknownKeywordIssue` as a union of `ANNOTATION_KEYS`,
`COMPLEX_CONSTRAINT_KEYS`, `SEMANTIC_EXTENSION_KEYS` and a list of simple
validation keywords. That union contains `allOf`, `if`, `then`, `else`,
`patternProperties`, `propertyNames`, `prefixItems`, `not`, `oneOf`, `contains`,
`dependentSchemas`, `contentSchema`, `asCell`, `ifc`, and `scope` — **every one
of which projection refuses today, deliberately, in one of its two denylists.**
The two sets answer different questions. The checker's asks "can I prove this
key's change safe across an update?"; projection's asks "can I honor this key
when selecting a value?" A key can be free to change and impossible to project.

So: derive the annotation tier from `ANNOTATION_KEYS`, and write the validation
tier out by hand as a list this document's tiers H and C define. The tier table
above is that list.

### 3. The remediation advice does not work on this surface

The plan says a caller met by a refusal is told to lift a source schema and
prune it, and reasons from there that the tolerated tier must exist to receive
what a lifted schema carries.

The tier still has to exist. The advice does not work here, for a plain reason:
**no CLI surface prints the read-side source schema.** `cf piece inspect` prints
values. `cf piece get` has no flag that emits the schema it read against. There
is nothing to lift.

The advice is sound one surface over, which is likely where it came from. Item
12's refusal is about a verb's event fields, and `cf piece verbs --json` carries
`inputSchema` on every row (`PieceCallableListing`, `packages/cli/lib/piece.ts`)
— the same schema `cf piece call <verb> --help --json` serves. A caller refused
there can be told exactly where to look.

What a read-side refusal should say instead is what the reader knows without
any source at all: the key that was refused, the position it appeared at, and
the vocabulary that position accepts. The denylist refusals in
`normalizeProjectionSchema` already carry the first two —

```text
Invalid --schema at <root>.notes: "allOf" is not supported by projection schemas
```

— and the refusal this item adds should carry the third as well, because for an
unrecognized key the accepted vocabulary is the entire remediation. A caller who
transposed two letters needs the honored key named, not a document that cannot
be fetched.

Two smaller notes follow from this. A tolerated tier derived from the compat
checker's annotation keys is still right, because schemas *do* get copied
between surfaces even without a command that prints them. And this refusal and
item 12's should share one vocabulary for what a refusal says — a caller meets
both through `cf piece call`.

## Blast radius

Measured over this repository: **four** JSON Schema keywords appear in keyword
position across every `--schema` argument written anywhere in the tree — `type`,
`properties`, `items`, and `$link`. All four are tier H. **No tier C, T, or R
key is used by any command in the repository, so nothing in it breaks.**

How that was counted, because the count is easy to inflate. Every occurrence of
the literal `--schema` in a tracked file was located, each one's argument
extracted by brace-balancing from the first `{` after the flag, and each parsed
argument walked as a schema — descending into `properties`, `items`, and
`additionalProperties` values but **counting only keys in keyword position**.
The distinction matters: a naive key census counts the property *names* inside a
`properties` map, which are the caller's field names and not keywords at all,
and inflates the answer with whatever the examples happen to read.

Eighteen occurrences carry a parseable JSON Schema argument — in
`packages/cli/integration/*.sh`, `packages/cli/README.md`,
`packages/cli/commands/piece.ts` help examples, `skills/cf/SKILL.md`,
`docs/common/verbs-over-the-cli.md`, and two plan documents. The rest are prose
about the flag, error-message text naming it, or the concise field-path
spelling. One doc example passes `@shape.json`, a file the tree does not
contain. Two arguments did not parse and neither is a command: a display string
in `packages/cli/integration/verb-session-demo.sh` that stands in for a schema
rather than being one, and an elided `{"propertys":{…}}` in an archived record.

The verbs plan's step table prices this item as the largest remaining step. The
measurement does not contradict that — the work is in the classification and in
constructing the outgoing schema, not in the refusal — but it does say the
compatibility cost of the behavior change is zero for everything the repository
itself runs.

## Scope

**In scope.** The JSON Schema spelling of `--schema`, on every command that
takes it. [#5734] belongs here: the `required` filter and dropping tier C's keys
from the constructed schema are the same edit as the refusal, landing in the
same branch of `resolveProjection`, and shipping a loud refusal for typos while
leaving an unsatisfiable `required` silently returning nothing would be a
strange thing to have done deliberately.

**Out of scope.** `--select`, entirely. Its grammar is comma-separated field
paths — `parseSelectProjection` refuses a JSON Schema argument outright and
points the caller at `--schema` — so it has no key vocabulary to classify, and
its projection is built by `conciseProjectionSchema` from paths the CLI parsed
itself. It already satisfies the rule this document lands. The same is true of
`--schema` given the concise spelling, which takes the same path.

Also out of scope: changing which keys projection *honors*. Every tier C, T, and
R member stays exactly as (un)honored as it is now. This item changes what
happens to a key, never what a key means.

## What "done" looks like

- A key in no tier is refused, and the message names the key and its position.
- A tier C key is read for container inference and does not appear in the schema
  the read boundary receives.
- A tier T key is accepted and changes nothing about what is read.
- A projection naming a `required` field it does not project reads the fields it
  does project, rather than nothing.
- A misspelled `properties` beside a stated `type` is refused, rather than
  returning the whole object.
- A test asserts the `ANNOTATION_KEYS` relation in both directions, per
  correction 1.
- A test asserts a **read outcome** for a projection carrying `required`, not
  only its normalized schema — the coverage [#5734] identifies as missing from
  `packages/cli/test/piece-get-transform.test.ts`.

A command that ran only because a key was silently dropped now fails loudly.
That is the point of the item rather than a regression against it.

## What is not settled here

- **Whether `ANNOTATION_KEYS` is exported as a set or behind a predicate.**
  Either satisfies correction 1. A predicate keeps the membership question in
  the package that owns it; a set is simpler to assert the relation over.
- **What the refusal message offers beyond the accepted vocabulary.** A
  near-miss suggestion against tier H is clearly worth it for a typo; whether
  the message enumerates all of H, or only the keys legal at that position's
  inferred container, is a wording call best made against the real output.
- **Whether tier C's keys should be honored rather than dropped.** Dropping is
  correct now, because nothing in the CLI enforces them and the runner enforcing
  them produces [#5734]. If a later change wants `minItems` to mean something on
  a projection, the registry will record that it was deliberately ignored rather
  than overlooked — which is the whole reason the plan asks for a class rather
  than a spelling.

[#5734]: https://github.com/commontoolsinc/labs/issues/5734
