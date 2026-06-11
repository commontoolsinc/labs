function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, type Default, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: default-survives-capture-shrink
// Verifies: Default<…> annotations on properties survive capture shrinking
// as alias references, so the injected capture schemas keep their
// `"default"` values. When the shrunken type node expands the alias
// structurally (`boolean | (false & { [DEFAULT_MARKER]: false })`), the
// schema generator no longer recognizes the spelling and silently drops
// the default — and literal default values can widen away entirely
// (`Default<string, "">` → `{ [DEFAULT_MARKER]: string }`).
interface Item {
    done: boolean | Default<false>;
    label: Default<string, "">;
}
interface Input {
    items: Item[];
}
const __cfLift_1 = __cfHelpers.lift<{
    items: {
        done: __cfHelpers.Default<boolean | (false & { readonly [DEFAULT_MARKER]: false; }), false>;
    }[];
}, boolean>(({ items }) => items[0]?.done === true, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean",
                        "default": false
                    }
                },
                required: ["done"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    items: {
        label: __cfHelpers.Default<string | (string & { readonly [DEFAULT_MARKER]: string; }), "">;
    }[];
}, boolean>(({ items }) => items[0]?.label === "", {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: {
                        type: "string",
                        "default": ""
                    }
                },
                required: ["label"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const firstDone = __cfLift_1({ items: items }).for("firstDone", true);
    const firstLabelEmpty = __cfLift_2({ items: items }).for("firstLabelEmpty", true);
    return { firstDone, firstLabelEmpty };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean",
                    "default": false
                },
                label: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["done", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        firstDone: {
            type: "boolean"
        },
        firstLabelEmpty: {
            type: "boolean"
        }
    },
    required: ["firstDone", "firstLabelEmpty"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
