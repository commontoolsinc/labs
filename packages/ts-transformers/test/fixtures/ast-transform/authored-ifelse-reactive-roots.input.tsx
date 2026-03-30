/// <cts-enable />
import { ifElse, pattern, Writable } from "commontools";

const identity = <T,>(value: T) => value;

// FIXTURE: authored-ifelse-reactive-roots
// Verifies: authored ifElse outside JSX and top-level receiver-method roots lower reactively
//   ifElse(show, count + 1, 0)         → compute-wrapped branch
//   ifElse(show, cell.get(), 0)        → reactive branch lowering around Writable.get()
//   ifElse(show, name.trim(), "x")     → reactive receiver-method branch
//   name.trim() / identity(name.trim()) → top-level receiver-method roots lowered via derive
export default pattern<{
  count: number;
  show: boolean;
  name: string;
  cell: Writable<number>;
}>(({ count, show, name, cell }) => {
  const upper = identity(name.trim());
  return {
    value: ifElse(show, count + 1, 0),
    cellValue: ifElse(show, cell.get(), 0),
    trimmed: ifElse(show, name.trim(), "fallback"),
    upper,
    upperDirect: name.trim(),
  };
});
