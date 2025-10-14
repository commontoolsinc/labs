import * as __ctHelpers from "commontools";
import { Cell, derive, recipe, toSchema, UI } from "commontools";
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
    default: {
        value: 0
    }
} as const satisfies __ctHelpers.JSONSchema;
export default recipe(model, model, (cell) => {
    const doubled = derive(true as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, cell.value, (v) => v * 2);
    return {
        [UI]: (<div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        value: cell.value,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
