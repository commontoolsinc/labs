/// <cts-enable />
import { pattern, UI } from "commonfabric";

// FIXTURE: pattern-with-cells
// Verifies: pattern input property access is transformed to .key() and arithmetic to derive()
//   cell.value       → cell.key("value")
//   cell.value + 1   → derive({value: asOpaque}, ({cell}) => cell.value + 1)
//   cell.value * 2   → derive({value: asOpaque}, ({cell}) => cell.value * 2)
export default pattern<{ value: number }>((cell) => {
  return {
    [UI]: (
      <div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {cell.value + 1}</p>
        <p>Double: {cell.value * 2}</p>
      </div>
    ),
    value: cell.value,
  };
});
