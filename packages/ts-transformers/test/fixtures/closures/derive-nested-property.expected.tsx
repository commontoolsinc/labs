import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface State {
    config: {
        multiplier: number;
    };
}
export default function TestDerive(state: State) {
    const value = cell(10);
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
                    config: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number"
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["config"]
            }
        },
        required: ["value", "state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        state: {
            config: {
                multiplier: state.config.multiplier
            }
        }
    }, ({ value: v, state }) => v * state.config.multiplier);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
