---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Counts and profile shares from a fabrichat room's reload before and after a pattern began holding its argument and result schemas deep-frozen from the time the builder makes it, with the entity ids that interning those schemas would have changed, October 2026."
---

# Narrowing a pattern's argument schema on a fabrichat room's reload, October 2026

Binding a pattern's nodes narrows the pattern's argument schema for every
argument alias it binds, through `ContextualFlowControl.schemaAtPath`, and
that function keeps a narrowing only for a deep-frozen schema. This records
how many of those narrowings a room's reload made of a schema that was not
deep-frozen, by which route each such schema reached the binding, what the
narrowings cost, and what changed when the builder began handing out
deep-frozen schemas. It also records why those schemas stayed separate
objects and were not interned.

## Setup

- The server: a local toolshed at a port offset, `serverExecution` off, its
  store holding a room of thirty messages and twelve members seeded the day
  before and opened many times since.
- The client: a Deno `cf piece render` of the room through
  `skills/perf-investigation/scripts/profile-cf.ts`.
- The code: main at `83c5203f2e` for the base arm, and that commit with the
  change for the new arm. Two further pairs of renders are from main at
  `1ed00a44f1`, forty-three commits later, and that commit with the change.
- The machine ran at a one-minute load of 250 to 470 throughout, from other
  sessions. A render took five to thirty-two minutes. So nothing here is a
  wall time. The counts are exact. The shares are of the samples a V8
  profile took outside `(idle)`, compared between two renders started
  together, one per arm, with the arm that started first alternating. They
  count samples and not the time between them: at this load most of the
  time between two samples is time the process was descheduled, and summing
  it weighs a function by where the process happened to be parked.

The narrowings were counted with a temporary counter in
`unwrapOneLevelAndBindToDoc()`. For each argument alias bound it counted the
narrowings the alias's path makes of the pattern's own argument schema: one
per path segment, and one more for the whole path where the caller passes
the schema as `sourceSchemas.argument`. It did not count the narrowings of
the argument link's schema, which is interned. Each count was keyed by
whether the schema was deep-frozen and by how the pattern holding it came to
be, which `resolveOriginal()` reports: a pattern the builder returned, or a
copy of one.

## Which schemas were narrowed

The counts are from main at `83c5203f2e`. A reload bound 62,250 aliases in
every render of either arm. Of those,
62,136 were argument aliases bound under a pattern's argument schema, and
they narrowed it 75,317 times. The other 114 bound with no such schema to
narrow.

| pattern holding the schema | schema when narrowed | base: aliases | base: narrowings | new: aliases | new: narrowings |
| --- | --- | ---: | ---: | ---: | ---: |
| a copy of a pattern the builder returned | not deep-frozen | 38,168 | 38,448 | 0 | 0 |
| a copy of a pattern the builder returned | deep-frozen | 17,800 | 18,035 | 55,968 | 56,483 |
| a pattern the builder returned | not deep-frozen | 4,128 | 12,621 | 0 | 0 |
| a pattern the builder returned | deep-frozen | 2,040 | 6,213 | 6,168 | 18,834 |

On the base arm 51,069 of the 75,317 narrowings were of a schema that was
not deep-frozen. A second base render gave the same counts.

On the base arm six schema objects were narrowed while not deep-frozen:
three held by patterns the builder returned, of four such patterns, and
three held by copies, of six. Each of the six was narrowed deep-frozen later
in the same reload.

Two routes brought a schema to the binding, and no third. No pattern in the
reload was a plain object that was not a copy of a builder pattern, so none
came from a stored graph.

- **A pattern the builder returned.** `factoryFromPattern` handed out the
  result of `sanitizeSchemaForLinks()`. For three of the four patterns that
  was a mutable tree throughout: the schema the pattern was given was not
  deep-frozen when the sanitizer ran, so the sanitizer's memo did not apply
  and its result shared nothing frozen.
- **A copy of one.** The builder's binding walk (`withAliasBindings()`)
  rebuilds a nested pattern's graph into the node that instantiates it,
  record by record, and that rebuilt the nested pattern's schemas as mutable
  copies. A child pattern runs from that copy. This route carried three
  quarters of the narrowings of a schema that was not deep-frozen.

What froze those six schemas partway through the base reload is the first
run of the pattern holding each. `Cell.asSchema()` interns the schema it is
given, which freezes a mutable one in place, and setup calls it with the
pattern's argument schema. The resume pre-sync binds a pattern's nodes
before the pattern has run, so its narrowings came before that.

`frozenSchemaStandIn()` in `pattern-binding.ts`, which substituted a
deep-frozen clone for a schema that was a mutable root over deep-frozen
members, applied to none of the aliases on the base arm. No schema reached
the binding in that shape.

## What the narrowings cost

Five pairs of renders, each pair started together: three at `83c5203f2e`
and two at `1ed00a44f1`. Each cell is the share of the profile's samples
outside `(idle)` whose stack holds the function.

| base | pair | arm | samples | `selectReferencedCfcSchemaDefs` | `schemaAtPath` | `unwrapOneLevelAndBindToDoc` | `sanitizeSchemaForLinksInternal` | `factoryFromPattern` |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `83c5203f2e` | 1 | base | 114,904 | 4.36% | 5.05% | 11.53% | 1.78% | 0.68% |
| | 1 | new | 104,874 | 0.62% | 0.83% | 4.82% | 0.46% | 0.76% |
| | 2 | base | 127,666 | 4.43% | 5.10% | 11.71% | 2.28% | 0.66% |
| | 2 | new | 117,413 | 0.68% | 2.06% | 5.09% | 0.50% | 0.75% |
| | 3 | base | 129,276 | 4.51% | 5.09% | 11.46% | 1.80% | 0.73% |
| | 3 | new | 115,215 | 0.64% | 0.83% | 5.16% | 0.49% | 0.80% |
| `1ed00a44f1` | 4 | base | 99,104 | 1.81% | 2.16% | 3.64% | 0.87% | 0.77% |
| | 4 | new | 96,792 | 0.53% | 0.67% | 1.16% | 0.24% | 0.79% |
| | 5 | base | 69,355 | 1.24% | 1.51% | 2.12% | 0.47% | 0.54% |
| | 5 | new | 68,833 | 0.42% | 0.73% | 0.91% | 0.25% | 0.45% |

At `83c5203f2e` the binding walk fell from 11.5–11.7% of the samples to
4.8–5.2%, and `selectReferencedCfcSchemaDefs` from 4.4–4.5% to 0.6–0.7%.
The new arm of each pair took 8 to 11% fewer samples outside `(idle)` than
the base arm it ran beside.

At `1ed00a44f1` the walk fell from 2.1–3.6% to 0.9–1.2%, and
`selectReferencedCfcSchemaDefs` from 1.2–1.8% to 0.4–0.5%. The new arm took
2.3% and 0.8% fewer samples. Between the two commits main began holding a node's
binding from the resume pre-sync to the node's instantiation
(`packages/runner/src/node-binding-memo.ts`), so a reload binds a node
fewer times and makes fewer narrowings for this change to remove. The
counts above were not taken again at that commit.

The binding walk's share falls by more than the narrowing's. The walk also
sanitizes and interns the argument link's schema on every call
(`canonicalSchemaLink()`), and that is a memo hit for a deep-frozen schema
and a strip, a clone and a hash for a mutable one.

The builder's own share rose by 0.07 to 0.09 of a percentage point in each
pair at `83c5203f2e`, for the freezing it now does, and moved by less than
the pairs differ at `1ed00a44f1`.

At `83c5203f2e` all six renders, and the renders that carried the counter,
wrote the same 232,190 bytes of HTML. At `1ed00a44f1` the four renders
wrote 232,190 bytes each that differ in the order of the declarations
inside `style` attributes and in nothing else: sorting each attribute's
declarations makes the four equal to one another and to the earlier
renders. The order differs between the two base renders, in 140 places,
and one base render and the new render beside it are byte for byte the
same, so the order is not something the change moves.

## What interning costs in the same reload

`internSchema()` was 9.5%, 10.4% and 9.8% of the base arm's samples at
`83c5203f2e` and 8.2%, 9.9% and 8.3% of the new arm's; at `1ed00a44f1` it
was 9.3% and 8.8% of the base arm's and 7.6% and 8.8% of the new arm's. The
change did not aim at it. In the new arm's five profiles its samples divide
by caller as follows.

| caller | pair 1 | pair 2 | pair 3 | pair 4 | pair 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `internPathSelector`, under a sync's `normalizeSyncSelector` and `externalizeSyncSelector` | 30.9% | 26.9% | 29.9% | 30.7% | 36.0% |
| `internCellLinkSchema` in `asSchema`, under `#cellsNodePlanReads` | 19.0% | 15.5% | 18.5% | 19.0% | 14.9% |
| `internSchemaPairAsKey`, under `combineSchemaForLink` and `mergeSchemaFlags` | 20.1% | 18.1% | 20.7% | 19.9% | 15.6% |

## Why the schemas were not interned

The first version of the change had the builder return the interned instance
of each schema, and had the builder's binding walk return a deep-frozen
record it left unchanged as the same object, so that a pattern and every
copy of its graph shared one schema object. It removed the same narrowings.
It was withdrawn because it changed derived entity ids.

`createRef()` guards against cycles by hashing an object it reaches a second
time in one cause as `null`. So the id it derives depends on which objects a
cause shares, and not only on what the cause holds. A node's cause holds its
bound inputs and outputs, a handler's holds its bound inputs, and either can
hold a pattern's graph with its schemas.

Twenty-three ids were derived with `createRef()` from ten built patterns:
one from each pattern's schemas, result and nodes, and one from each node's
inputs and outputs. The patterns were built from mutable and from deep-frozen
schemas, from one object given as both schemas, from equal schemas, with a
pattern nested once, twice and at three levels, and with patterns and a
shared deep-frozen constant passed as a node's input values.

- With the interning version, nine of the twenty-three differed from main's:
  the three patterns given one object or equal objects as both schemas,
  every pattern nesting another, and the pattern holding patterns as input
  values together with the id of its node.
- With the version that landed, none differed. It freezes the objects main
  already made and shares none that main kept apart.
