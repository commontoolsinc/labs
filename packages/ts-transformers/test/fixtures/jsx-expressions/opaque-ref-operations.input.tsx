/// <cts-enable />
import { cell, pattern, UI } from "commontools";

export default pattern((_state) => {
  const count = cell(10);
  const price = cell(10);

  return {
    [UI]: (
      <div>
        <p>Count: {count}</p>
        <p>Next: {count.get() + 1}</p>
        <p>Double: {count.get() * 2}</p>
        <p>Total: {price.get() * 1.1}</p>
      </div>
    ),
  };
});
