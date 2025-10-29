import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("LogicalComplexExpressions", (_state) => {
    const items = cell<string[]>([]);
    const isEnabled = cell(false);
    const count = cell(0);
    return {
        [UI]: (<div>
        {/* Nested && - both conditions reference opaque refs */}
        {__ctHelpers.when(__ctHelpers.derive({ items, isEnabled }, ({ items: items, isEnabled: isEnabled }) => items.length > 0 && isEnabled), <div>Enabled with items</div>)}

        {/* Mixed || and && */}
        {__ctHelpers.when(__ctHelpers.derive({ count, items }, ({ count: count, items: items }) => (count > 10 || items.length > 5)), <div>Threshold met</div>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
