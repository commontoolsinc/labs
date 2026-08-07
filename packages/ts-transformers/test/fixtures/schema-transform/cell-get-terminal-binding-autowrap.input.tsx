import { pattern, Writable } from "commonfabric";

interface Row {
  sentAt: number;
  body: string;
}

// FIXTURE: cell-get-terminal-binding-autowrap
// Verifies: a cell read at a variable-initializer binding is auto-wrapped into a
//   lift whether or not a computation sits on top of it — a bare `rows.get()`,
//   an element access, a value-returning method call, and an array method taking
//   a callback all lower the same way. Each lift's input schema shrinks to what
//   its body actually reads: `.length` needs no element shape and gets
//   `items: { type: "unknown" }`, while the reads that hand the elements onward
//   carry the full `Row`.
// Context: `.filter` over the read array lowers through `filterWithPattern`, so
//   the element schema of its own lift shrinks to the `sentAt` the callback
//   reads.
export default pattern<{ rows: Writable<Row[]> }>(({ rows }) => {
  const count = rows.get().length;
  const all = rows.get();
  const first = rows.get()[0];
  const joined = rows.get().join(",");
  const recent = rows.get().filter((row) => row.sentAt > 0);
  return { count, all, first, joined, recent };
});
