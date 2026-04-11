function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, generateObject, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: destructured opaque temporaries preserve generated root suffixes
//   const { result } = generateObject(...) uses the synthesized __cf_destructure_* binding consistently
export default pattern((__cf_pattern_input) => {
    const messages = __cf_pattern_input.key("messages");
    const preview = __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { messages: messages }, ({ messages }) => messages[0] ?? "").for("preview", true);
    const __cf_destructure_1 = generateObject({
        prompt: preview,
        schema: {
            type: "object",
            properties: {
                title: { type: "string" },
            },
            required: ["title"],
        },
    }), result = __cf_destructure_1.key("result");
    return <div>{__cfHelpers.derive({
        type: "object",
        properties: {
            result: true
        },
        required: ["result"]
    } as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, { result: result }, ({ result }) => result?.title ?? "Untitled")}</div>;
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
