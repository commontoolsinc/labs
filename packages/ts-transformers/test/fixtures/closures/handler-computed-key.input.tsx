import { Cell, pattern, UI } from "commonfabric";

interface State {
  records: Record<string, Cell<number>>;
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `key-${counter}`;
}

// FIXTURE: handler-computed-key
// Verifies: handler capturing a Record with computed (dynamic) key access is transformed correctly
//   onClick={() => recordMap[nextKey()]!.set(counter)) → handler(false, { recordMap: { additionalProperties, asOpaque } }, ...)({ recordMap })
// Context: Dynamic property access via computed key; Record type uses additionalProperties in schema
export default pattern<State>((state) => {
  const recordMap = state.records;
  return {
    [UI]: (
      <button type="button" onClick={() => recordMap[nextKey()]!.set(counter)}>
        Step
      </button>
    ),
  };
});
