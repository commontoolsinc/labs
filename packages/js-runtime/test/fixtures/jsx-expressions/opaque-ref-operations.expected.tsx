/// <cts-enable />
import { cell, h, recipe, UI, derive } from "commontools";
export default recipe("OpaqueRefOperations", (state) => {
    const count = cell(10);
    const price = cell(10);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {commontools_1.derive(count, count => count + 1)}</p>
        <p>Double: {commontools_1.derive(count, count => count * 2)}</p>
        <p>Total: {commontools_1.derive(price, price => price * 1.1)}</p>
      </div>)
    };
});