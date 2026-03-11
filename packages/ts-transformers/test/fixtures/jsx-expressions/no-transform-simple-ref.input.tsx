/// <cts-enable />
import { NAME, OpaqueRef, pattern } from "commontools";
const count: OpaqueRef<number> = {} as any;
const _element = <div>{count}</div>;

// FIXTURE: no-transform-simple-ref
// Verifies: a bare OpaqueRef in JSX ({count}) is NOT wrapped in derive() -- passed through as-is
//   <div>{count}</div> → <div>{count}</div>  (unchanged)
// Context: Negative test -- simple ref interpolation needs no transformation
export default pattern((_state) => {
  return {
    [NAME]: "test",
  };
});
