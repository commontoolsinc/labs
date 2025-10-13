import * as __ctHelpers from "commontools";
import { cell, h, recipe, UI } from "commontools";
export default recipe("OpaqueRefOperations", (state) => {
    const count = cell(10);
    const price = cell(10);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {__ctHelpers.derive(count, count => count + 1)}</p>
        <p>Double: {__ctHelpers.derive(count, count => count * 2)}</p>
        <p>Total: {__ctHelpers.derive(price, price => price * 1.1)}</p>
      </div>)
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
