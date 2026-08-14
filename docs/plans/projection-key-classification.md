# Projection keys, and the schema a read is handed

This document designs
[item 2 of the verbs implementation plan](verbs-implementation.md) — refusing a
projection key the reader does not recognize — and the larger rule that refusal
is only half of. It is written to be checkable: every claim about current
behavior below was read out of the named code or measured against it, and the
symbol it was read from is named beside it.

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
  boundary**: past it, a schema is the runner's to act on.
  `SchemaObjectTraverser` (`packages/runner/src/traverse.ts`) acts on the
  traversal semantics it supports — the declared `type`, the descent through
  `properties` and `items`, `required`, which decides whether an object is read
  at all, the item schema under `items`, which decides the same for an array,
  and `$comment`, three values of which the runner reserves as control
  markers. Value constraints are not among them: `minLength`, `minimum`,
  `minItems` and their neighbours appear nowhere in that traversal. That
  `required` and `$comment` are both keywords it acts on is what makes a
  caller's schema crossing this boundary consequential.

`resolveProjection` builds all three, and it builds them two different ways.
For the concise spelling it derives the output schema through
`selectSourceSchema` — constructed from the source, position by position. For
the JSON spelling it assigns the caller's own object, unchanged, to both
`projectionSchema` and `outputSchema`.

**That asymmetry is the whole of the problem below.** On one path the CLI hands
the read boundary something it built. On the other it hands over what a caller
typed. The two inputs are not interchangeable, though, and the fix turns on
that: a field list has only positions to state, while a JSON projection also
states scalar types.

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

The widening case is the stronger motivation for this item. The two are
opposite, both are real, and the narrowing one is the easier to reach for
because it is what a missing `type` was fixed for twice already. A design that
only stops narrowing leaves the disclosure-shaped half standing.

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
verbatim into a schema whose `required` the runner acts on. A classification
exercise that ended at "known keys pass, unknown keys are refused" would file
`required` under *known*, forward it, and leave [#5734] exactly where it is.

So the design has two halves, and the second is the load-bearing one:

1. **A key the projection vocabulary does not contain is refused, by name.**
2. **The schema that crosses the read boundary is built by the reader**, key by
   key, out of the classification below: an honored key is carried through, a
   consulted key is consumed during inference and dropped, a tolerated key is
   carried only where carrying it is provably inert, and a refused key never
   reaches construction because the projection naming it was rejected. To that
   the reader adds a key of its own, derived from the source: `required`, below.

**The mask is not the material to build from**, and it fails on the honored key
the whole classification rests hardest on. `ProjectionMask`
(`packages/cli/lib/cell-selection.ts:ProjectionMask`) records `true`, `false`,
and the two containers, and nothing else. It therefore carries `type` only where
`type` names a container: `projectionMask` reduces every scalar position to
`true`, because a scalar is neither container and the mask has no third thing
for it to be. **A reader that constructed the outgoing schema from the mask
could not honor a scalar `type`, having discarded it before construction
began.** Two losses follow, and both of them widen a read:

- A scalar leaf whose declared type does not match the stored value is omitted
  today — deliberately, documented in `packages/cli/README.md`, and tested in
  `packages/cli/test/piece-get-transform.test.ts` ("filters and projects arrays
  through the runtime pattern graph", which projects `{"type":"string"}` over a
  numeric `id` and expects the property gone). That leaf masks to `true`, and
  `selectSourceSchema` answers a `true` mask with the source's own schema, so a
  mask-built output schema would derive the source's numeric leaf and return
  the value the caller's `type` excluded.
- A scalar projection standing over an object source masks to `true` the same
  way, so a mask-built output schema is the source object's, entire.
  `projectValue` already copies every key of an object it is handed a scalar
  schema for; the output schema re-asserted at the read boundary is the only
  thing standing between that value and the caller. Sourcing that schema from
  the mask removes the only stop.

The concise path can build from the mask precisely because it has no scalar type
to lose: `conciseSelectionSchema` writes containers and `true` leaves and
nothing else. A JSON projection states scalar types, so the two paths converge
on the rule and not on the code.

Half 2 is what makes the tiers below meaningful. Once the outgoing schema is
constructed, a tier does not describe what gets forwarded — no key crosses the
boundary because a caller wrote it — it describes what a caller is allowed to
write and what the reader puts in the schema it builds because of it.

The reader supplies exactly one key from somewhere other than the classified
projection, and `selectSourceSchema`
(`packages/cli/lib/cell-selection.ts:selectSourceSchema`) already derives that
key this way, with a comment giving exactly this reason:

```text
A rejected position holds nothing to require. Keeping it required makes
the object unsatisfiable, which reads as an absent value for the whole
selection rather than for the one position that declined to be read.
```

It takes the *source* schema's `required`, filters it to the properties that
survived selection, and re-emits it — so the schema the reader constructs does
carry `required`, on the reader's own authority and with the source's meaning
rather than the caller's. That derivation runs on the source-read schema and on
the concise path's output schema, and on no JSON-path output schema. **This item
extends an existing derivation to a second call site rather than inventing
one**, and what it extends is *derive the constraint*, not *delete the
keyword*. What "survived selection" has to mean is the next section, because it
is not what the filter currently asks.

### What "survived selection" has to mean

Extended as it stands, that derivation would reproduce [#5734] through the
document that folds [#5734] in.

`selectSourceSchema` keeps a source-required key where
`key in properties && properties[key] !== false`. Both clauses ask about the
caller's **projection membership**: the first whether the caller named the
position, the second whether the caller rejected it outright. Neither asks
whether the value at that position survives traversal. A property the caller
projected under a constraint that value then fails stays required — and the
runner voids the object around it.

What it collides with is any caller constraint the value fails, and the
simplest of those is a mismatched scalar. Take a source declaring `id`
(number, `required`) alongside `title`, read through a projection asking for
`id` as a string and `title`. Today that returns `{"title":"Visible"}`: the
caller's schema crosses the boundary verbatim, it carries no `required` of its
own, and the mismatched `id` is dropped by itself. Hand the same read a
constructed schema carrying the derived `required: ["id"]` and the answer is
`undefined` — the whole object, not the one position. `traverseWithSchema`
fails the child `invalidType`, `traverseObjectWithSchema` leaves it out of the
object it assembles, and that function's closing required check returns
`undefined` for the object. A parent reads that as `invalidObject` and voids in
turn, so the emptying climbs to the root of the read.

That is [#5734]'s failure mode exactly — an unsatisfiable `required` silently
emptying a whole read, exit 0 — arriving through the design that claims to fix
it, over a key no caller wrote. **Ceasing to carry the caller's `required` does
not fix [#5734] by itself; it relocates it.** The two requirements have to be
settled together or they collide.

So the derivation needs the survival test its own comment already describes and
its filter does not implement:

> **A source-`required` property stays required in the schema the reader
> constructs only where nothing the caller wrote inside that property can cause
> the property itself to be rejected.** A position the caller narrowed may be
> omitted; the object holding it must not be voided because it was.

Whether a caller's constraint stays where it was written or rejects the
property holding it is the runner's decision, and the two containers do not
decide it the same way.

### An object contains a rejection; an array does not

`traverseObjectWithSchema` (`packages/runner/src/traverse.ts`) assembles an
object property by property and keeps the ones whose traversal returned no
error; a property that failed is simply never assigned, and assembly carries
on. `traverseArrayWithSchema` in the same module carries one `valid` flag
across every element and returns `undefined` if any element failed. Its own
comment states the consequence:

```text
This array is invalid; one or more items do not match the
schema — the ENTIRE array reads as invalid for this caller.
```

**A rejected object property is omitted. A rejected array element voids the
array around it.** Measured against a `SchemaObjectTraverser`, with the caller
narrowing one of two children to `string` in each case and neither container
required:

| Source value | Constructed child | Result |
| --- | --- | --- |
| `{"a":1,"b":"ok"}` | object, `a` and `b` both `string` | `{"b":"ok"}` |
| `[1,"ok"]` | array, `items` `string` | the property is **gone** |

The object drops the child that failed and hands back the one that passed. The
array hands back nothing at all — the element that matched is discarded with
the element that did not. **The two rows are the same shape of narrowing**:
`{"properties":{"a":{"type":"string"}}}` and `{"items":{"type":"string"}}` are
both a caller stating a scalar type one level down. Only one of them can take
the property with it.

Put the array row under a source-`required` key and the derived `required`
finds a property that is not there:

| Constructed schema over `{"values":[1],"title":"Visible"}` | Result |
| --- | --- |
| `values` an array of `string` | `{"title":"Visible"}` |
| `values` an array of `string`, **`required`** | **`undefined`** |

That is [#5734]'s shape a third time, over a container that any rule treating
both containers alike keeps. The asymmetry is why the two cannot share one case,
and it is invisible from the projection: nothing in what the caller wrote says
which of the two narrowings is survivable.

Against the classified projection the rule resolves into a question about where
the child's type comes from, with one answer per case:

- **The caller states no type there** — `true`, or `{}`, which normalizes to
  the same wildcard. `selectSourceSchema` answers a `true` mask with the
  source's own schema, so the constructed child *is* the unprojected one: it
  declines exactly the values an unprojected read declines. That is the
  source's meaning, which is the meaning `required` is being derived to carry.
  **Stays required.**
- **The caller states a scalar `type`** — the constraint is the caller's, and
  declining a value is what a caller writes one for. **Drops out of
  `required`.** This is the case projection membership misses, and it is also
  the case the mask cannot see: a scalar position masks to `true`, so a reader
  consulting the mask here would conclude "no caller type" and keep the key.
  The reader has the caller's `type` in hand only because it builds from the
  classification — the same reason half 2 gives for not building from the
  mask.
- **The caller states an object** — `properties`, or a keyword
  `impliedProjectionType` derives an object from. A constraint the caller wrote
  inside narrows a *descendant*, and a narrowed descendant is omitted from the
  object rather than rejecting it, so nothing written below this point reaches
  the property itself. That holds on one condition: each descendant's own
  derived `required` follows this same rule, which is what stops an inner
  `required` from voiding the object an outer one is keeping. **Stays
  required.**
- **The caller states an array** — `items`, or a keyword
  `impliedProjectionType` derives an array from. Here what the caller wrote
  does not stay where it was written: it constrains elements, and one rejected
  element voids the array itself. So the answer follows the element schema
  rather than the array. A wildcard `items` rejects no element and the property
  **stays required**. An `items` naming a **scalar `type`** rejects every
  element whose value that type excludes, which rejects the array, so the
  property **drops out**. An array carries no `required` of its own for the
  recursion to empty, so there is nothing below it to absorb the rejection. An
  `items` naming an object rejects an element only through that item object's
  own derived `required`, which this rule has already emptied of everything the
  caller can fail, so the property **stays required**.
- **The caller writes `false`** — the case the existing comment was written
  for. **Drops out**, as it does today.

Where the implied container contradicts the source's declared type, either
container has narrowed the position to nothing readable, and it **drops out**.

**The recursion descends `items` as well as `properties`.** That is what makes
both container answers hold at depth, and each half of it is a read that
changes when the descent is missing:

| Constructed schema | Result |
| --- | --- |
| `details` object `required`, its `values` array of `string` `required` | `undefined` |
| the same, `values` **not** required | `{"details":{},"title":"Visible"}` |
| `rows` array `required`, item object's `id` `required` and narrowed to `string` | `undefined` |
| the same, `id` **not** required at the item level | `{"rows":[{"name":"a"}],"title":"Visible"}` |

Rows one and two are the array case reached through an object: dropping the
inner `required` contains the failure at `details`, and the read survives. Rows
three and four are the object case reached through an array, and they are the
sharper of the two — an item object that voids does not merely lose itself, it
voids the array holding it, and the array's absence then voids whatever
required the array. **An object's tolerance of an omitted property does not
survive being an array element**, so the rule has to reach the item's own
`required` to keep the read.

What bounds it: nothing else in the honored vocabulary escalates. The honored
keys descend to exactly two kinds of child — an object property, whether named
in `properties` or admitted by `additionalProperties`, and an array element —
and only the element descent voids its container on a child's failure.
`invalidArray` is returned from exactly two places in `traverse.ts`, the array
branch of `_traverseWithSchemaInner` and the fast path in
`traversePlainSchemaWithReads`, and both are the same whole-array `valid` flag
set by a failing element. The tier C keywords that might otherwise reject a
container — `minItems`, `maxItems`, `uniqueItems`, `minProperties`,
`maxProperties` — appear nowhere in `traverse.ts`, and tier C stops them at the
boundary regardless.

One narrower bound, stated so it is not mistaken for a reason to keep a key:
where the caller's item schema admits `null` or `undefined`,
`traverseArrayWithSchema` substitutes that in the failing element's place
instead of voiding, so `{"type":["string","null"]}` over `[1]` reads `[null]`
and the array survives. The rule does not lean on it. Dropping a key that would
have survived costs nothing — the rule only ever declines to void a read —
while keeping one that would not costs the entire read.

Two consequences worth stating. The concise path is undisturbed:
`conciseSelectionSchema` writes `type: "object"`, `properties`,
`additionalProperties` and `true` leaves, with no `items` and no scalar types
at all, so every position it produces falls under the first case or the object
case and keeps the `required` it derives now — which is what lets `--select`
stay out of scope. The array case cannot arise there at all, because stating an
element type needs a spelling the field-path grammar does not have. And the
rule only ever declines to void a read; it cannot empty one that succeeds
today.

## Four tiers

Honored, consulted, tolerated, refused. **Consulted** is the one a three-tier
split has nowhere to put: a group of keys that is neither honored nor inert,
because the CLI reads it, acts on it, and must then stop it from going any
further.

| Tier | Meaning | Members |
| --- | --- | --- |
| **H** — Honored | Drives the projection | `type`, `properties`, `items`, `additionalProperties`, `$link` |
| **C** — Consulted | Read for container inference; the caller's constraint goes no further | `required`, `minProperties`, `maxProperties`, `minItems`, `maxItems`, `uniqueItems` |
| **T** — Tolerated | Accepted, changes nothing | `ANNOTATION_KEYS` less the three tier R already claims |
| **R** — Refused | Named in an error | Everything else |

**H** is what the reader acts on. `normalizeProjectionSchema` recurses through
`properties` and `items`, lifts `$link` out into markers, and computes
`additionalProperties`; `projectionMask` then reads `type`, `properties`,
`items` and `additionalProperties` to build the mask. `$link` never reaches it,
having been lifted out one step earlier — which is why the marker is honored
without ever being a keyword the mask has to understand.

An honored key is also the only kind the reader carries into the schema it
constructs, and `type` is why that construction reads the classified projection
rather than the mask: a scalar leaf's declared `type` is the whole of what
filters that leaf, and a scalar `type` is exactly what the mask does not keep.

**C** is the tier that earns the fourth slot, and calling its members
"tolerated" would be false. `impliedProjectionType` decides whether an untyped
position is an object or an array from nine keys, and these six are the ones
tier H does not already claim: `ARRAY_PROJECTION_KEYS` holds `items`,
`minItems`, `maxItems` and `uniqueItems` and is tested first,
`OBJECT_PROJECTION_KEYS` holds `properties`, `additionalProperties`,
`required`, `minProperties` and `maxProperties`. The six tier C members
participate on equal footing with the honored three — a position naming only
`minItems` reads as an array — which is the container inference a caller relies
on for nested positions, and it is behavior, not decoration.

Their treatment is: **the caller's tier C constraint is consumed during
inference and is not propagated.** That is a claim about the caller's key, not
about the keyword. The reader may legitimately emit the same keyword from a
different origin: `selectSourceSchema` reconstructs `required` from the *source*
schema, filtered by the survival rule above, and that `required` carries the
source's meaning across the read boundary. Discarding what the caller wrote must
leave that derivation intact — the two are one spelling over two origins, and
only one of them is the caller's to supply. A key that changed the read, was
then discarded, and whose spelling the reader may re-emit on its own authority
is a third thing. A registry that records a class rather than a
spelling has to be able to say so — which is the reason to record a class at
all: a key admitted without its kind has its treatment decided by whatever the
reader happens to default to.

**T** is derived, not restated. Its source is `ANNOTATION_KEYS`
(`packages/piece/src/schema-compatibility.ts`), the compatibility checker's
record of which keywords are validation-neutral. Deriving is what keeps the two
registries from forking when a keyword like `tier` or `deprecated` is added to
the durable dialect. Because the outgoing schema is constructed key by key, a
tolerated key is a decision rather than a default: it is accepted from the
caller, and it reaches the constructed schema only where carrying it is provably
inert.

**The derivation supplies the candidates. It does not supply that proof.**
`ANNOTATION_KEYS` records which keywords the compatibility checker may ignore
when it compares two schemas across an update. That says nothing about what the
*runner* does with a key on a read; they are different questions about
different code, and only the second one decides whether carrying a key is
inert. So inertness is a separate obligation, discharged **per key against the
runner** — `packages/runner/src/traverse.ts` and
`packages/runner/src/schema-view.ts`, the modules that act on a schema past the
read boundary — and never against the registry the candidates came from. A key
that cannot be shown inert there is accepted and dropped rather than carried.

Three of the twelve are accepted without reaching the constructed schema:

- `$id` and `$schema` declare the identity and dialect of a *document*, and the
  reader is not producing the caller's document.
- **`$comment` is not inert: the runner acts on it.** Three of its values are
  reserved as control markers. `schema-view.ts` defines `EXCLUDED_EMPTY`,
  `EXCLUDED_MISSING` and `EXCLUDED_REJECTED` as `$comment: "emptyProperties"`,
  `"missingProperty"` and `"rejectedProperty"`, and `isExcluded` in that module
  tests a schema for exactly those three; `traverse.ts` holds the first two as
  `EMPTY_PROPERTIES_MARKER` and `MISSING_PROPERTY_MARKER`, and
  `SchemaObjectTraverser.traverseObjectWithSchema` tests a property's schema
  for them by value. They are how the runner tells a position the schema did
  not select from one it selected as anything, so a caller writing one is not
  annotating a schema — they are writing runner control flow and having the
  CLI carry it across the read boundary.

Measured on a read: where a property schema of `true` returns that property, a
property schema of `{"$comment":"emptyProperties"}` returns `{}`, and
`"missingProperty"` does the same — `traverseObjectWithSchema` routes both to
`addOptionalProperty`, which the eager read's object creator implements as a
no-op. Put either on a position the source marks `required` and the read
returns `undefined` altogether: the property never reaches the object, and the
required check voids the object around it. That is [#5734]'s shape a fourth
time, over a key the tier called inert because nobody asked the runner.

**A carried `$comment` is caller-forgeable control flow reaching the read
boundary** — precisely what this document's general rule exists to prevent.

Dropping the key beats refusing the three reserved values, though refusing is
the option that would preserve a caller's genuine comments. A refusal has to
know what is reserved, and that list is not derivable: both marker sets are
module-private frozen constants, they sit in two different runner modules, and
they do not agree with each other — `traverse.ts` acts on two of the values,
`schema-view.ts` on three. Tracking them from `packages/cli` would add a second
cross-package coupling, this one with no registry to derive from and no
fallback test available, and a marker added to the runner later would re-open
the hole in silence. Dropping needs to know nothing and cannot be circumvented
by a value nobody has reserved yet. What it costs is a caller's genuine
`$comment`, which has no reader: the schema that reaches the boundary is the
CLI's, and nothing displays the caller's copy.

**R** is everything else, and it keeps three keys that are *also* annotation
keys: `default`, `$defs`, and `definitions`. All three are refused today, for
good reasons that survive this change — `default` is controlled by the source
schema, and the two definition keys have no meaning without the `$ref` that
projection also refuses.

## Three things the coupling has to respect

Tier T couples the projection reader to the compatibility checker. Three
properties of that coupling are easy to state wrongly, and each one wrong costs
something concrete: a red test, a derivation that admits keys projection cannot
honor, and a refusal message that sends a caller somewhere that does not exist.

All three are about which keys the derivation *offers*. Whether carrying an
offered key is inert is a separate question with a different answer key — the
runner — and tier T above says how it is discharged.

### 1. The derivation is not one-to-one

Deriving tier T from `ANNOTATION_KEYS` does not mean one edit admits a key to
both registries.

`ANNOTATION_KEYS` has twelve members: `$comment`, `$defs`, `$id`, `$schema`,
`default`, `definitions`, `deprecated`, `description`, `examples`, `tags`,
`tier`, `title`. Three of them — `default`, `$defs`, `definitions` — are already
refused by projection and must stay refused. So the relation is not identity but
**`ANNOTATION_KEYS` minus a stated exception set**, and admitting a key to the
compat dialect admits it to projection only if it is not one of the three.

The consequence for the fallback test — the one that guards the coupling where
the derivation itself cannot — is concrete. **A test asserting that every
annotation key the checker knows is non-refused by the projection reader is red
the day it is written**, because three of the twelve are refused on purpose.
What it asserts instead is the exception relation itself:

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

Tier T is the annotation keywords, derived. The validation keywords a
projection tolerates are not derivable from the same file, and the reason is not
subtle.

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

### 3. A refusal cannot tell a caller to lift a source schema

"Lift the source schema and prune it" is the natural remediation for a refusal
over a schema-shaped argument, and it does not work on this surface, for a plain
reason: **no CLI surface prints the read-side source schema.** `cf piece
inspect` prints values. `cf piece get` has no flag that emits the schema it read
against. There is nothing to lift.

It is sound one surface over. Item 12's refusal is about a verb's event fields,
and `cf piece verbs --json` carries `inputSchema` on every row
(`PieceCallableListing`, `packages/cli/lib/piece.ts`) — the same schema
`cf piece call <verb> --help --json` serves. A caller refused there can be told
exactly where to look.

What a read-side refusal says instead is what the reader knows without any
source at all: the key that was refused, the position it appeared at, and the
vocabulary that position accepts. The denylist refusals in
`normalizeProjectionSchema` already carry the first two —

```text
Invalid --schema at <root>.notes: "allOf" is not supported by projection schemas
```

— and the refusal this item adds carries the third as well, because for an
unrecognized key the accepted vocabulary is the entire remediation. A caller who
transposed two letters needs the honored key named, not a document that cannot
be fetched.

Two smaller notes follow from this. Tier T is still worth deriving from the
compat checker's annotation keys, because schemas *do* get copied between
surfaces even without a command that prints them. And this refusal and item 12's
share one vocabulary for what a refusal says — a caller meets both through
`cf piece call`.

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
takes it. [#5734] belongs here: deriving the constructed schema's `required`
from the source rather than carrying the caller's is the same edit as the
refusal, landing in the same branch of `resolveProjection`, and shipping a loud
refusal for typos while leaving an unsatisfiable `required` silently returning
nothing would be a strange thing to have done deliberately.

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
- A caller-written tier C key is read for container inference and no
  caller-written tier C constraint reaches the read boundary.
- The reader's own derivation survives the bullet above: a read whose source
  schema marks a projected property required still carries `required` past the
  read boundary. It is filtered by the survival rule rather than by projection
  membership, so `selectSourceSchema`'s present filter is the part that
  changes, not the part that is preserved.
- A test holds those two apart, **inspecting the output schema specifically**: a
  caller's `required` does not survive into it, and a source-derived `required`
  does, filtered by the survival rule. The schema it inspects is the one
  `deriveSelectedValue` re-asserts on `result.key("value")`, read back off that
  output cell. **A selector captured from the storage provider does not satisfy
  this and cannot stand in for it**: that selector is `sourceReadSchema`, built
  by a separate `selectSourceSchema` call for the source read, and an
  implementation that kept the caller's `required` on the source read while
  dropping it from the output schema would pass an assertion over it while
  failing this criterion. The two schemas have to be asserted separately because
  they are two schemas.
- **A tier T key is accepted, and a read through a projection carrying it
  returns what the same projection returns without it.** Asserted as a read
  outcome, per key, against a value the key could plausibly disturb — not as
  membership in `ANNOTATION_KEYS`, and not as a property of the normalized
  schema. This is the criterion `$comment` fails, and would have failed on the
  day it was admitted: a membership assertion passes for a key the runner acts
  on, so membership can never stand in for inertness.
- A projection naming a `required` field it does not project reads the fields it
  does project, rather than nothing.
- **One test covers a source-required property and a caller type mismatch
  together**: a source declaring `id` (number) `required` alongside `title`,
  read through a projection asking for `id` as a string and `title`, returns
  the object with `title` and without `id` — not `undefined`. **The two
  criteria this one combines do not expose the interaction between them**, so a
  reader who assumes they do will leave it untested. The [#5734] criterion
  projects a required field the caller *does not name*, which the derivation
  drops for absence under any survival rule; the nested type-mismatch criterion
  uses a property the source does not require, so nothing voids around the
  omission. The failure needs both halves at once and shows up in neither half
  alone.
- **One test covers a source-required array and a caller item-type mismatch
  together**: a source declaring `values` (an array of numbers) `required`
  alongside `title`, read through a projection asking for `values` with
  `items` of `{"type":"string"}`, returns the object with `title` and without
  `values` — not `undefined`. **The combined criterion above does not cover
  this one**, and neither does any pairing of the criteria it combines. That
  one narrows a *scalar property*, and the object it sits in survives the
  narrowing by omitting it; here the caller narrows an *element*, the whole
  array is rejected because one element was, and the read fails at the array
  before any `required` under it is consulted. A survival rule that treats the
  two containers as one case passes the scalar criterion and fails this one.
- **A source-required array of objects with a mismatched leaf still reads.** A
  source declaring `rows` (an array of objects, each with a required number
  `id`) `required`, projected with `id` narrowed to `{"type":"string"}`,
  returns `rows` with each object's remaining fields rather than `undefined`.
  This is the criterion that fails when the survival rule recurses through
  `properties` but not through `items`: the item object's own derived
  `required` is the only thing standing between a narrowed leaf and a voided
  array.
- A misspelled `properties` beside a stated `type` is refused, rather than
  returning the whole object.
- **A scalar leaf whose declared type does not match the stored value is still
  omitted at a nested position**, not only at an array item: a projection
  declaring `{"type":"string"}` for a property the source declares a number
  returns the surrounding object without that property. This is the criterion a
  mask-built output schema fails, and it fails it silently.
- **A scalar projection over an object source does not widen to that object.**
  A projection of `{"type":"string"}` against an object value behaves as it does
  now and in particular does not return the object's fields. The mask records
  `true` at that position, so a reader building the output schema from the mask
  would return all of them — and `projectValue`, which copies every key of an
  object handed a scalar schema, has that value ready to hand over.
- A test asserts the `ANNOTATION_KEYS` relation in both directions, as the
  first of the three coupling constraints words it.
- A test asserts a **read outcome** for a projection carrying `required`, not
  only its normalized schema — the coverage [#5734] identifies as missing from
  `packages/cli/test/piece-get-transform.test.ts`.

A command that ran only because a key was silently dropped now fails loudly.
That is the point of the item rather than a regression against it.

## What is not settled here

- **Whether `ANNOTATION_KEYS` is exported as a set or behind a predicate.**
  Either satisfies the first coupling constraint above. A predicate keeps the
  membership question in the package that owns it; a set is simpler to assert
  the relation over.
- **What the refusal message offers beyond the accepted vocabulary.** A
  near-miss suggestion against tier H is clearly worth it for a typo; whether
  the message enumerates all of H, or only the keys legal at that position's
  inferred container, is a wording call best made against the real output.
- **Whether a caller's tier C constraint should be honored rather than
  discarded.** Discarding it is correct now, because nothing in the CLI enforces
  it and the runner acting on a caller's `required` produces [#5734]. If a later
  change wants `minItems` to mean something a caller can state on a projection,
  the registry will record that it was deliberately ignored rather than
  overlooked — which is the whole reason to record a class rather than a
  spelling.

[#5734]: https://github.com/commontoolsinc/labs/issues/5734
