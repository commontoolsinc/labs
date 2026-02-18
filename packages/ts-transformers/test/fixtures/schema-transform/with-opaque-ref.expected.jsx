import * as __ctHelpers from "commontools";
import { Cell, derive, pattern, toSchema, UI } from "commontools";
interface State {
    value: Cell<number>;
}
const model = {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"],
    "default": {
        value: 0
    }
} as const satisfies __ctHelpers.JSONSchema;
export default pattern((cell) => {
    const doubled = derive({
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, cell.value, (v: number) => v * 2);
    return {
        [UI]: (<div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        value: cell.value,
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
