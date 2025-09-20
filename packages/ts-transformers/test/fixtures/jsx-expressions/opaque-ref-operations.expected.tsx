/// <cts-enable />
import { cell, h, recipe, UI, derive } from "commontools";
export default recipe("OpaqueRefOperations", (state) => {
    const count = cell(10);
    const price = cell(10);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {derive(count, count => count + 1)}</p>
        <p>Double: {derive(count, count => count * 2)}</p>
        <p>Total: {derive(price, price => price * 1.1)}</p>
      </div>)
    };
});
