import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("ElementAccessBothOpaque", false as const satisfies __ctHelpers.JSONSchema, (_state) => {
    const items = cell(["apple", "banana", "cherry"]);
    const index = cell(1);
    return {
        [UI]: (<div>
        <h3>Element Access with Both OpaqueRefs</h3>
        {/* Both items and index are OpaqueRefs */}
        <p>Selected item: {__ctHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    },
                    asCell: true
                },
                index: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["items", "index"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            items: items,
            index: index
        }, ({ items, index }) => items.get()[index.get()])}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;

