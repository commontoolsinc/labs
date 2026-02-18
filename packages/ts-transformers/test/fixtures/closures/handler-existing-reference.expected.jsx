import * as __ctHelpers from "commontools";
import { handler, pattern, UI } from "commontools";
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "ct-button": any;
        }
    }
}
interface State {
    count: number;
}
const existing = handler(false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/State"
        }
    },
    required: ["state"],
    $defs: {
        State: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (_event, { state }: {
    state: State;
}) => {
    console.log(state.count);
});
export default pattern((state) => {
    return {
        [UI]: (<ct-button onClick={existing({ state })}>
        Existing
      </ct-button>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
