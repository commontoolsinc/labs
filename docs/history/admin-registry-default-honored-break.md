---
status: historical
created: 2026-09-17
archived: 2026-09-17
reason: "Record of the deliberate contract break taken when the group chat demo's admin registry started carrying the default its type had declared all along."
---

# Group chat demo: the admin registry's declared default takes effect

`packages/patterns/cfc-group-chat-demo/trusted.tsx` declares

```ts
// Shown for illustration only.
export type ChatAdminRegistryValue =
  | ChatAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
export type ChatAdminRegistryCell = Writable<ChatAdminRegistryValue>;
```

with `EmptyAdminRegistryValue = Record<PropertyKey, never>`, and
`cfc-group-chat-demo/main.tsx` takes `adminRegistry: PerSpace<ChatAdminRegistryCell>`
as an argument and republishes it as a result. The declaration says an
unset registry reads as `{}`.

The recorded contracts never carried that default. The schema generator
reached the type through `PerSpace<…>`, where the checker has resolved the
`Default` alias into `Stored | Empty | (Empty & { [DEFAULT_MARKER]: Empty })`,
and its recovery of a default from that expanded form selected every
propertyless member as a brand candidate. The plain `Empty` arm has no
properties, so it was a candidate too; it carries no marker, so the recovery
bailed, emitted `anyOf: [Stored, Empty]` with no default, and reported
`schema-default:unresolved` — a warning whose text recommends an empty-object
type, which is what the declaration already used.

Selecting only members that carry the marker fixes that, and the argument and
result schemas of `main.tsx` gain `default: {}` under their `anyOf`. The
compatibility proof reads that as "defaults changed below a constraint that
is not stable under default insertion": a piece holding an unset registry
under the recorded contract reads `undefined`, and under the new one reads
`{}`.

## Why this could not be done compatibly

The only compatible alternatives are to keep emitting the schema without the
default — which keeps the generator wrong for every `Default<EmptyObject>`
reached through a resolved type, and keeps the misleading warning — or to
change the pattern to stop declaring the default it has always meant. Neither
is the schema the pattern's author wrote. The pattern is a demo; the pieces
holding the old shape are accepted casualties, and every reader of the
registry (`packages/patterns/cfc/admin/mod.ts`, `trusted.tsx`) goes through
optional chaining on `registry.get()`, so an absent registry and an empty one
already behave alike.

## What is accepted

`cfc-group-chat-demo/main.tsx` over `20260729T022742Z-piF14M8QDh5pSPw1`,
`20260821T064855Z-7vNcdzNpQKWFJXVr`, and `20260831T222745Z-kIL5Ew24PVUYtyxy`,
paths `argument.adminRegistry` and `result.adminRegistry`.
