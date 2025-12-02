import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface State {
    counter: {
        value: number;
    };
}
export default function TestDerive(state: State) {
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Capture property before method call
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            state: {
                type: "object",
                properties: {
                    counter: {
                        type: "object",
                        properties: {
                            value: {
                                type: "number"
                            }
                        },
                        required: ["value"]
                    }
                },
                required: ["counter"]
            }
        },
        required: ["value", "state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        state: {
            counter: {
                value: state.counter.value
            }
        }
    }, ({ value: v, state }) => v.get() + state.counter.value);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
