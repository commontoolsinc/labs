# Interfaces for the pieces a pattern holds

A pattern that stores other pieces writes down what it needs from them. Those
pieces persist, each carrying the interface it was created with, so a holder
sooner or later holds pieces of several generations at once. This document is
about how to shape that demand so a holder keeps working across generations
without its code turning into a thicket of existence checks.

It concerns held pieces specifically. For composing patterns into a reactive
graph, see [composition.md](composition.md).

## Two mechanics decide the shape

**A schema is a visibility filter.** Reading a reference typed as some interface
yields only the properties that interface declares; everything else is dropped,
even when the underlying data has it. So a holder cannot discover a member it
did not declare — declaring a member is what buys permission to ask about it.

**A holder's demand is proven against every piece it holds.** Raising a demand
is refused while any held piece fails it. So a holder cannot require a member
that some of its pieces lack, however much it would prefer to.

Together these say: a holder that spans generations must declare the newer
members **optionally**, and resolve that optionality itself.

## Where optionality belongs

A piece's own published interface states its generation completely: every member
that generation has, declared required. `Default<>` covers values that may be
unset, so a member is absent only when the generation genuinely lacks it.

The optionality lives in the **demand** — the projection a holder declares of
the pieces it stores. There, and only there, an absent member means "this piece
is of an older generation".

```ts
// Shown as interface or class members.
/** The piece's own interface — complete for its generation. */
title: string;
commentCount: number | Default<0>;
```

Keeping those two meanings apart is what makes `undefined` legible. If a demand
uses optionality for both "may be unset" and "may be an older generation", an
absent value cannot be attributed to either.

## Prefer a default to a branch

A data member that can carry a sensible default needs no branching at all. The
default materializes for pieces that never wrote the field, so every piece
satisfies the demand and the holder iterates all of them.

```ts
// Shown as interface or class members.
/** Every held piece answers this, whatever generation it is. */
name: string | Default<"(untitled)">;
description: string | Default<"">;
```

A verb cannot carry a default, because it is a stream. An "inert" verb that
accepted and discarded would be worse than an absent one: it reproduces the
failure where nothing happens and nothing says so. **So data rarely needs a
branch, and behavior always does.**

## Group a capability, do not scatter its members

When several members only make sense together, declare them as a named group
that is present or absent as a unit. The holder then asks one question instead
of one per member.

```ts
// Shown as interface or class members.
/** A capability, named and atomic: a piece either implements it or does not. */
printable?: { print: Stream<{ copies: number }>; pageCount: number };
```

A group keeps the number of states linear. Scattered optional members multiply:
five independent ones describe thirty-two possible pieces, and no branch has a
name. One group is two states, and the name says what they are.

Version a group by name rather than by adding members to it. `printable` and
`printableV2` are two optional keys, so asking which one a piece implements is
the same question as asking whether it implements either.

**Group a genuine capability; do not group members that merely arrived
together.** The test: would you still group these if every piece had them from
the first day? If not, the grouping records migration history in a shape that
outlives the migration.

## Resolve once, then hold a guarantee

Optionality belongs at the boundary of the holder's code, not throughout it. Ask
once, narrow the type, and let everything downstream work against a member that
is certainly there.

```ts
// Shown for illustration only.
// Defers the question to every call site, and does nothing when the answer is no.
for (const item of items) item.printable?.print.send({ copies: 1 });

// Asks once; `printable` is a guarantee for everything below.
const printables = items.filter(hasPrintable);
for (const item of printables) item.printable.print.send({ copies: 1 });
```

A predicate that narrows the type is what carries the guarantee across the
boundary:

```ts
// Shown at module scope.
interface HeldItem {
  name: string;
  printable?: { print: Stream<{ copies: number }>; pageCount: number };
}
type Printable = HeldItem & Required<Pick<HeldItem, "printable">>;

export const hasPrintable = (item: HeldItem): item is Printable =>
  item.printable !== undefined;

export const partition = (items: HeldItem[]) => ({
  printables: items.filter(hasPrintable),
  needsUpgrade: items.filter((item) => !hasPrintable(item)),
});
```

## The complement is the migration worklist

The pieces that fail the predicate are exactly the ones still to migrate, so a
holder gets that list without building anything for it.

`needsUpgrade` drives an upgrade affordance, and its emptiness is the signal
that the demand can be tightened: a holder may require a member exactly when no
held piece lacks it, which is what the proof against held pieces will check.

The same partition is available from the command line, so the worklist does not
require a pattern to read it:

```sh
cf get --cell ID items --filter '.printable != null' --select 'name,printable.pageCount'
cf get --cell ID items --filter '.printable == null' --select 'name'
```

## The shape of a holder over time

1. **Before a capability exists** — every member required, no predicates.
2. **While it is spreading** — the capability optional in the demand, one
   predicate per method that needs it, and a worklist view. Data members added
   alongside need nothing, because their defaults cover every generation.
3. **Once the worklist is empty** — require the member, delete the predicates.

The branching is scaffolding for a migration rather than a permanent tax, and it
is proportional to how many methods need the new *behavior* — not to the size of
the interface, and not to how many generations have ever existed.
