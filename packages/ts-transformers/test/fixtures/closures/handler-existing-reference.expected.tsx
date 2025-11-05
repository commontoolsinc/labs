import * as __ctHelpers from "commontools";
import { handler, recipe, UI } from "commontools";
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
const existing = handler(true as const satisfies __ctHelpers.JSONSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
export default recipe({
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<ct-button onClick={existing({ state })}>
        Existing
      </ct-button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
