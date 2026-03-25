import * as __cfHelpers from "commonfabric";
import { Cell, derive, pattern, toSchema, UI } from "commonfabric";
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
} as const satisfies __cfHelpers.JSONSchema;
// FIXTURE: with-opaque-ref
// Verifies: Cell<> fields generate asCell in schema and derive() gets input/output type schemas injected
//   Cell<number> → { type: "number", asCell: true }
//   toSchema<State>({default: ...}) → schema with "default" key preserved
//   derive(cell.value, fn) → derive(inputSchema, outputSchema, cell.key("value"), fn)
export default pattern((cell) => {
    const doubled = derive({
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, cell.key("value"), (v: number) => v * 2);
    return {
        [UI]: (<div>
        <p>Value: {cell.key("value")}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        value: cell.key("value"),
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
