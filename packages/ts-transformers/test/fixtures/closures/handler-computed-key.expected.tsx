import * as __ctHelpers from "commontools";
import { Cell, pattern, UI } from "commontools";
interface State {
    records: Record<string, Cell<number>>;
}
let counter = 0;
function nextKey(): string {
    counter += 1;
    return `key-${counter}`;
}
export default pattern({
    type: "object",
    properties: {
        records: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number",
                asCell: true
            }
        }
    },
    required: ["records"]
} as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const recordMap = state.records;
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                recordMap: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "number",
                        asCell: true
                    },
                    asOpaque: true
                }
            },
            required: ["recordMap"]
        } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { recordMap }) => recordMap[nextKey()]!.set(counter))({
            recordMap: recordMap
        })}>
        Step
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
