import * as __ctHelpers from "commontools";
import { NAME, UI, pattern } from "commontools";
interface Entry {
    [NAME]: string;
    [UI]: string;
}
interface Input {
    items: Entry[];
}
// FIXTURE: map-symbol-key-access
// Verifies: .map() on reactive array is transformed when callback uses symbol key access
//   .map(fn) → .mapWithPattern(pattern(...), {})
//   item[NAME] → item.key(__ctHelpers.NAME), item[UI] → item.key(__ctHelpers.UI)
// Context: Symbol-keyed property access (NAME, UI) is lowered to .key() with helper references
const _p = pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
        const item = __ct_pattern_input.key("element");
        return ({ n: item.key(__ctHelpers.NAME), u: item.key(__ctHelpers.UI) });
    }, {
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/Entry"
            }
        },
        required: ["element"],
        $defs: {
            Entry: {
                type: "object",
                properties: {
                    $NAME: {
                        type: "string"
                    },
                    $UI: {
                        type: "string"
                    }
                },
                required: ["$NAME", "$UI"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            n: {
                type: "string",
                asOpaque: true
            },
            u: {
                type: "string",
                asOpaque: true
            }
        },
        required: ["n", "u"]
    } as const satisfies __ctHelpers.JSONSchema), {});
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        }
    },
    required: ["items"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                $NAME: {
                    type: "string"
                },
                $UI: {
                    type: "string"
                }
            },
            required: ["$NAME", "$UI"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            n: {
                type: "string",
                asOpaque: true
            },
            u: {
                type: "string",
                asOpaque: true
            }
        },
        required: ["n", "u"]
    },
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
