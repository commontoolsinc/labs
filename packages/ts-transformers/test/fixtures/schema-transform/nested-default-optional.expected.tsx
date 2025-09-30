/// <cts-enable />
import { type Cell, Default, handler, recipe, JSONSchema } from "commontools";
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
const increment = handler(true as const satisfies JSONSchema, {
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        state: {
            $ref: "#/definitions/NestedOptionalState",
            asCell: true
        }
    },
    required: ["state"],
    definitions: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/definitions/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/definitions/OptionalBranch"
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
} as const satisfies JSONSchema, (_, context: {
    state: Cell<NestedOptionalState>;
}) => {
    const current = context.state.get() ?? {};
    const branch = current.nested?.branch ?? {};
    const counter = (branch.counter ?? 0) + 1;
    context.state.set({ nested: { branch: { counter } } });
});
export default recipe({
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        state: {
            allOf: [{
                    $ref: "#/definitions/NestedOptionalState"
                }],
            default: {}
        }
    },
    required: ["state"],
    definitions: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/definitions/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/definitions/OptionalBranch"
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
} as const satisfies JSONSchema, ({ state }) => {
    return {
        state,
        increment: increment({ state }),
    };
});