import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
export default pattern((cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {__ctHelpers.derive({ cell: {
                value: cell.value
            } }, ({ cell }) => cell.value + 1)}</p>
        <p>Double: {__ctHelpers.derive({ cell: {
                value: cell.value
            } }, ({ cell }) => cell.value * 2)}</p>
      </div>),
        value: cell.value,
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
