/// <cts-enable />
import { Cell, derive, pattern, toSchema, UI } from "commontools";

interface State {
  value: Cell<number>;
}

const model = toSchema<State>({
  "default": { value: 0 },
});

// FIXTURE: with-opaque-ref
// Verifies: Cell<> fields generate asCell in schema and derive() gets input/output type schemas injected
//   Cell<number> → { type: "number", asCell: true }
//   toSchema<State>({default: ...}) → schema with "default" key preserved
//   derive(cell.value, fn) → derive(inputSchema, outputSchema, cell.key("value"), fn)
export default pattern<State, State>((cell) => {
  const doubled = derive(cell.value, (v: number) => v * 2);

  return {
    [UI]: (
      <div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
      </div>
    ),
    value: cell.value,
  };
}, model, model);
