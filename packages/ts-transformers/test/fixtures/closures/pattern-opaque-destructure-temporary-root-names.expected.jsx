import * as __ctHelpers from "commontools";
import { computed, generateObject, pattern } from "commontools";
// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: destructured opaque temporaries preserve generated root suffixes
//   const { result } = generateObject(...) uses the synthesized __ct_destructure_* binding consistently
export default pattern((__ct_pattern_input) => {
    const messages = __ct_pattern_input.key("messages");
    const preview = __ctHelpers.derive({
        type: "object",
        properties: {
            messages: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["messages"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, { messages: messages }, ({ messages }) => messages[0] ?? "");
    const __ct_destructure_1 = generateObject({
        prompt: preview,
        schema: {
            type: "object",
            properties: {
                title: { type: "string" },
            },
            required: ["title"],
        },
    }), result = __ct_destructure_1.key("result");
    return <div>{__ctHelpers.derive({
        type: "object",
        properties: {
            result: true
        },
        required: ["result"]
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { result: result }, ({ result }) => result?.title ?? "Untitled")}</div>;
}, {
    type: "object",
    properties: {
        messages: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["messages"]
} as const satisfies __ctHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
