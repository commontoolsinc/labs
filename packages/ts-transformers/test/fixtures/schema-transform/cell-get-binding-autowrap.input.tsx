import { pattern, Writable } from "commonfabric";

// FIXTURE: cell-get-binding-autowrap
// Verifies: a bare `cell.get()` that feeds a computation at a variable-initializer
//   binding is auto-wrapped into a lift, the same way it is in a JSX expression.
//   Previously the validator rejected top-level cell .get() with
//   `pattern-context:get-call`; that restriction was legacy (the rewriter already
//   lowers the computation). A bare *terminal* `cell.get()` (no enclosing
//   computation) is still rejected elsewhere, since it has no lowerable site.
// Context: enabled migrating `cell.get()`-wrapped reads to drop the wrapper and
//   write a plain expression even when the input is a Writable/Cell.
export default pattern<{
  layout: Writable<string>;
}>(({ layout }) => {
  const len = layout.get().trim().length;
  return { len };
});
