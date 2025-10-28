import * as __ctHelpers from "commontools";
import { type Cell, Default, handler, recipe } from "commontools";
interface OptionalBranch {
    counter?: number;
    label?: string;
}
interface OptionalNested {
    branch?: OptionalBranch;
}
interface NestedOptionalState {
    nested?: OptionalNested;
}
interface NestedOptionalArgs {
    state: Default<NestedOptionalState, {}>;
}
const increment = handler(true as const satisfies __ctHelpers.JSONSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            asCell: true
        }
    },
    required: ["state"],
    $defs: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/$defs/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/$defs/OptionalBranch"
                }
            }
        },
        OptionalBranch: {
            type: "object",
            properties: {
                counter: {
                    type: "number"
                },
                label: {
                    type: "string"
                }
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (_, context: {
    state: Cell<NestedOptionalState>;
}) => {
    const current = context.state.get() ?? {};
    const branch = current.nested?.branch ?? {};
    const counter = (branch.counter ?? 0) + 1;
    context.state.set({ nested: { branch: { counter } } });
});
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            default: {}
        }
    },
    required: ["state"],
    $defs: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/$defs/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/$defs/OptionalBranch"
                }
            }
        },
        OptionalBranch: {
            type: "object",
            properties: {
                counter: {
                    type: "number"
                },
                label: {
                    type: "string"
                }
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => {
    return {
        state,
        increment: increment({ state }),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
