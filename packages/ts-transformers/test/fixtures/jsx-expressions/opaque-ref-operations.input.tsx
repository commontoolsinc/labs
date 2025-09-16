/// <cts-enable />
import { cell, h, recipe, UI } from "commontools";

export default recipe("OpaqueRefOperations", (state) => {
  const count = cell(10);
  const price = cell(10);

  return {
    [UI]: (
      <div>
        <p>Count: {count}</p>
        <p>Next: {count + 1}</p>
        <p>Double: {count * 2}</p>
        <p>Total: {price * 1.1}</p>
      </div>
    )
  };
});
