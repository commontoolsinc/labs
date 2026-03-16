import * as __ctHelpers from "commontools";
import { computed, pattern, UI, VNode, } from "commontools";
// Simulates `any` leaking through a generic function (like generateObject)
declare function fetchAny(): any;
// FIXTURE: pattern-any-result-override
// Verifies: explicit Output type parameter overrides inferred `any` return type for schema generation
//   pattern<Input, string>() → output schema { type: "string" } instead of inferred any
//   pattern<Input, { [UI]: VNode }>() → output schema with $UI vnode $ref
// Context: simulates `any` leaking through generic functions; two named exports, no default
// Case 1: Explicit Output type overrides inferred `any` return
export const TypedFromAny = pattern((__ct_pattern_input) => {
    const prompt = __ct_pattern_input.key("prompt");
    const result = fetchAny();
    return __ctHelpers.derive({
        type: "object",
        properties: {
            result: true,
            prompt: {
                type: "string"
            }
        },
        required: ["result", "prompt"]
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        result: result,
        prompt: prompt
    }, ({ result, prompt }) => result?.title || prompt || "Untitled");
}, {
    type: "object",
    properties: {
        prompt: {
            type: "string"
        }
    },
    required: ["prompt"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
// Case 2: { [UI]: VNode } Output type instead of { [UI]: any }
type Entry = {
    name: string;
};
export const TypedUIOutput = pattern((__ct_pattern_input) => {
    const name = __ct_pattern_input.key("name");
    return {
        [UI]: (<div>{name}</div>),
    };
}, {
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
