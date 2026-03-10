import * as __ctHelpers from "commontools";
/**
 * Writable.of() result accessed via .get()/.set() in action
 * callbacks. These are terminal methods handled correctly regardless
 * of opaque classification — Writable.of() is an opaque origin and
 * .get()/.set() are terminal methods.
 */
import { action, pattern, UI, Writable } from "commontools";
interface State {
    title: string;
}
export default pattern((__ct_pattern_input) => {
    const title = __ct_pattern_input.key("title");
    const counter = Writable.of(0, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const label = Writable.of("Count", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const reset = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            counter: {
                type: "number",
                asCell: true
            },
            label: {
                type: "string",
                asCell: true
            }
        },
        required: ["counter", "label"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { counter, label }) => {
        counter.set(0);
        label.set("Count");
    })({
        counter: counter,
        label: label
    });
    return {
        [UI]: (<div>
        <span>{title} {label}: {counter}</span>
        <ct-button onClick={reset}>Reset</ct-button>
      </div>),
        counter,
        label,
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        counter: {
            type: "number",
            asCell: true
        },
        label: {
            type: "string",
            asCell: true
        }
    },
    required: ["$UI", "counter", "label"],
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
