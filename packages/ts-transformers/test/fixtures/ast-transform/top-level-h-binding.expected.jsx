import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: top-level-h-binding
// Verifies: a module that binds `h` at top level gets the bare `void __cfHelpers;`
//   trailer instead of the forwarding `h` shim, so the authored `h` is not a
//   duplicate identifier and JSX still dispatches through `__cfHelpers.h`
const h = __cfHelpers.__cf_data(["a", "b"]);
export default pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    return (<ul title={title}>{h.map((item) => <li>{item}</li>)}</ul>);
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
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
void __cfHelpers;
