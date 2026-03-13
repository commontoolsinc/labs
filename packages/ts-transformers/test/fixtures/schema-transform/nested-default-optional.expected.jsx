import * as __ctHelpers from "commontools";
import { type Cell, Default, handler, pattern } from "commontools";
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
    // deno-lint-ignore ban-types
    state: Default<NestedOptionalState, {}>;
}
const increment = handler(false as const satisfies __ctHelpers.JSONSchema, {
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
// FIXTURE: nested-default-optional
// Verifies: nested optional interfaces with Default<> generate schemas with $ref/$defs and "default" values
//   Default<NestedOptionalState, {}> → schema property with "default": {}
//   Optional nested fields → $ref without "required" entries
//   handler() → injects event/context schemas with asCell annotations
//   pattern<Args>() → generates input schema, output schema (with asOpaque/asStream)
// Context: deeply nested optional types (OptionalBranch inside OptionalNested inside NestedOptionalState)
export default pattern((__ct_pattern_input) => {
    const state = __ct_pattern_input.key("state");
    return {
        state,
        increment: increment({ state }),
    };
}, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            "default": {}
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            asOpaque: true
        },
        increment: {
            type: "unknown",
            asStream: true
        }
    },
    required: ["state", "increment"],
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
