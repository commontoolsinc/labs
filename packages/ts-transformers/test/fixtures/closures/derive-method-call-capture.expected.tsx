import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface State {
    counter: {
        value: number;
    };
}
export default function TestDerive(state: State) {
    const value = cell(10);
    // Capture property before method call
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
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
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        state: {
            counter: {
                value: state.counter.value
            }
        }
    }, ({ value: v, state }) => v + state.counter.value);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
