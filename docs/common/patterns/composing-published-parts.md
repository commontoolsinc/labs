# Composing Published Parts

A pattern index holds **parts**: patterns earlier runs published, each recorded
under an id with a declared argument shape and a declared result shape. A part
is not source to copy. It is a component to wire, and wiring one is how a task
gets answered without writing the whole of it.

This document is the end-to-end route from what a run was granted to a piece
that displays it: the references a run holds, the part that reads data out of
one of them, and the part that renders what the first returned.
[composition.md](composition.md) covers the same call mechanism between two
patterns declared in one file; everything here applies to that case too.

## A run's granted references are its only data sources

A run is granted a set of references and holds no others. There is no directory
to look one up in, no path to open, and no way to widen the set from inside the
run. A reference is an address rather than a value: it is wired into a pattern
as an input, and the pattern reads through it live.

A piece registry is a catalog of what a space has published, so it answers
"what exists here" and never "what is in my mailbox". Running against the
registry in place of a database that was not granted produces a working piece
about the wrong thing, which is worse than no piece at all, because nothing in
the result says the source was substituted.

So a task naming data no granted reference reaches is not runnable, and the
correct outcome is to say which input is missing. See
[When a part declares an input you were not granted](#when-a-part-declares-an-input-you-were-not-granted).

## What a search returns about a part

A pattern-index search returns each part's id, the import specifier that
composes it, and the two shapes that make up its contract:

- the **argument shape** — the fields the part declares as its input, by name
  and type, `orders: SqliteDb` among them;
- the **result shape** — the fields the part returns, by name and type, which
  is what a caller reads and what another part's input can be fed from.

Those shapes are the whole contract. A part's source is never returned and is
never needed: everything a caller has to know to wire one is in the two shapes
and the one-line description beside them.

## Running a part, and importing a part

There are two ways to reach a part, and which one fits depends on what is being
built.

**Run it by id** when the part answers the whole task on its own. The runtime
fetches the published program, compiles it, and runs it, and nothing is
authored at all.

**Import it** when the part is one component of something larger. The specifier
is `cf:pattern:<patternId>`, the import resolves before the importing source
compiles, and the composition runs as one pattern:

```text
import DonutOrderRows from "cf:pattern:pat-donut-order-rows";
import DonutOrderTable from "cf:pattern:pat-donut-order-table";
```

An id is a content hash the search reported rather than a name anyone chose;
`pat-donut-order-rows` stands in for one above.

A result cell that an earlier run already produced is a third thing, and it is
wired in by its reference rather than by either of these. An indexed part has
no result until something runs it, so there is nothing of it to wire by
reference.

## Satisfying a declared input: forwarding a `SqliteDb` handle to an imported part

A part that declares `orders: SqliteDb` is asking for a database handle. The
composing pattern satisfies that by **declaring the same input on itself and
forwarding it**:

```tsx
// Shown at module scope.
import { pattern, type SqliteDb, UI, type VNode } from "commonfabric";

interface Input {
  orders: SqliteDb;
}

interface Output {
  [UI]: VNode;
}

export default pattern<Input, Output>(({ orders }) => ({
  // `orders` arrived as this pattern's own input and is handed straight on.
  [UI]: <div>{DonutOrderRows({ orders })[UI]}</div>,
}));
```

That is the whole move, and it is the one that connects a granted handle to a
part that queries it. The handle is never opened, read, or copied on the way:
the composing pattern declares the same type, and the value that arrives is the
same live reference.

Nothing about it is specific to databases. Any declared input — a handle, a
number, a list of rows — is satisfied the same way, either by forwarding an
input of the composing pattern or by passing a value it computed.

## Feeding one part's rows into another part's view

A part that returns rows and a part that renders rows compose by name: the
first part's result field becomes the second part's input.

```tsx
// Shown inside a pattern body.
const found = DonutOrderRows({ orders });
const table = DonutOrderTable({ rows: found.rows });
```

`found.rows` is the field the source part declared in its result shape, and
`rows` is the field the view part declared in its argument shape. A search
reported both, which is what makes the join checkable before anything runs: if
the names or the element types do not line up, the two parts do not compose,
and a third part or a small derivation between them is what is missing.

## A worked example: a handle, a source part, a view part

The usual shape of a data task is three links long — the granted handle, a part
that reads rows out of it, and a part that displays them.

The **source part** takes the handle and returns rows. It bounds its own query,
projects only the columns it returns, and returns a total beside the rows so a
caller can tell an empty table from a predicate that matched nothing:

```tsx
// Shown at module scope.
import { computed, NAME, pattern, type SqliteDb, UI, type VNode } from "commonfabric";

export interface DonutOrder {
  id: number;
  glaze: string;
  boxes: number;
}

interface RowsInput {
  orders: SqliteDb;
}

interface RowsOutput {
  [NAME]: string;
  [UI]: VNode;
  rows: DonutOrder[];
  total: number;
}

export const DonutOrderRows = pattern<RowsInput, RowsOutput>(({ orders }) => {
  const open = orders.query<DonutOrder>(
    "SELECT id, glaze, boxes FROM orders WHERE shipped = 0 ORDER BY id DESC LIMIT 200",
    { scope: "session" },
  );
  const counted = orders.query<{ n: number }>(
    "SELECT count(*) AS n FROM orders",
    { scope: "session" },
  );
  const rows = computed(() => open.result ?? []);
  const total = computed(() => counted.result?.[0]?.n ?? 0);

  return {
    [NAME]: "Open donut orders",
    [UI]: <cf-text>{computed(() => `${rows.length} of ${total}`)}</cf-text>,
    rows,
    total,
  };
});
```

The **view part** takes rows and returns a rendering. It declares no handle at
all, which is what makes it reusable over any rows of that shape:

```tsx
// Shown at module scope.
interface TableInput {
  rows: DonutOrder[];
}

interface TableOutput {
  [NAME]: string;
  [UI]: VNode;
}

export const DonutOrderTable = pattern<TableInput, TableOutput>(({ rows }) => ({
  [NAME]: "Donut orders",
  [UI]: (
    <cf-vstack gap="2">
      {rows.map((row: DonutOrder) => (
        <cf-hstack gap="2" justify="between">
          <cf-text>{row.glaze}</cf-text>
          <cf-text tone="muted">{row.boxes}</cf-text>
        </cf-hstack>
      ))}
    </cf-vstack>
  ),
}));
```

The **composing pattern** declares the handle, forwards it to the source part,
and hands that part's `rows` to the view part:

```tsx
// Shown at module scope.
interface ShopInput {
  orders: SqliteDb;
}

interface ShopOutput {
  [NAME]: string;
  [UI]: VNode;
  total: number;
}

export default pattern<ShopInput, ShopOutput>(({ orders }) => {
  const found = DonutOrderRows({ orders });
  const table = DonutOrderTable({ rows: found.rows });

  return {
    [NAME]: "Donut shop",
    [UI]: <cf-vstack gap="3">{table[UI]}</cf-vstack>,
    total: found.total,
  };
});
```

Three declarations carry the whole composition: `orders: SqliteDb` on the
composing pattern and on the source part, and `rows: DonutOrder[]` on the view
part. Nothing else had to be written, and neither part's source was read.

## When a part declares an input you were not granted

A search that returns exactly the right part does not make the part runnable.
The part's argument shape names what it needs, and a run either holds a
reference for each of those or it does not.

Where it does not, the answer is a failure that names the missing input — "this
needs a mail database and this run was granted none" — and not a substitute.
Wiring a different reference into the slot, or authoring a pattern that reads
whatever the run does hold, both produce a result that looks like an answer and
is not one.

The same check is worth making before the search: read the granted references
with `describe_handle` first, and search for parts that take what is actually
in hand.

## Telling an empty source from a wrong predicate

A part that returns no rows has not failed. The query settled, the result is an
empty list, and every field derived from it is empty in turn. That is data, and
the view will render its empty state without anything reporting a problem.

One check separates the two cases. Run the same read without the predicate
least certain of — as a `count(*)`, which returns one row and needs no bound —
and compare the two numbers. Rows under the count and none under the predicate
put the disagreement in the predicate rather than in the store, and the thing
to report onward is the predicate that emptied it rather than that the source
was empty. The source part above returns `total` beside `rows` for this reason.

[capabilities/sqlite.md](../capabilities/sqlite.md) covers the query surface
itself: bounding the rows, session-scoped results under a read ceiling, and the
column conventions a connector store carries.

## See Also

- [composition.md](composition.md) — the call mechanism, and composing patterns
  declared in one file
- [primitives.md](primitives.md) — the contract a reusable part holds itself to
- [capabilities/sqlite.md](../capabilities/sqlite.md) — reading a `SqliteDb`
  handle a pattern was given as an input
- [concepts/piece-discovery.md](../concepts/piece-discovery.md) — what the piece
  registry is for, and the limits of what it discovers
