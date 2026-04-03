import * as __ctHelpers from "commontools";
import { generateText, pattern, UI } from "commontools";
// FIXTURE: generate-text-local-ternary
// Verifies: local reactive builder results still trigger JSX ternary lowering
//   text.pending ? "Loading" : text.result -> __ctHelpers.ifElse(...)
// Context: `text` is a local `generateText()` result rather than a pattern
// input binding, so this exercises expression-site lowering on local reactive
// aliases in JSX.
export default pattern(() => {
    const text = generateText({ prompt: "hi" });
    return {
        [UI]: <div>{__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, text.pending, "Loading", text.result)}</div>,
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
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
