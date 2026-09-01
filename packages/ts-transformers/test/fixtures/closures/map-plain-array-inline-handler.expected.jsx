function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const COLORS = __cfHelpers.__cf_data(["red", "green", "blue"]);
interface Input {
    selected: Writable<string>;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        color: {
            type: "string"
        },
        selected: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["color", "selected"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { selected, color }) => selected.set(color));
// FIXTURE: map-plain-array-inline-handler
// Verifies: an inline handler inside a plain-array .map() captures that
// iteration's element, so each rendered node carries its own handler
//   COLORS.map(fn)                          -> plain .map() remains plain
//   onClick={() => selected.set(color)}     -> hoisted handler factory applied
//                                              per element, capturing `color`
//                                              and `selected`
// Context: The render-loop shape authored patterns use after moving away from
// pre-built action arrays — the per-element binding is what a shared or
// last-one-wins handler would silently break, and it is otherwise pinned only
// by live pattern runs
export default pattern((__cf_pattern_input) => {
    const selected = __cf_pattern_input.key("selected");
    return {
        [UI]: (<div>
        {COLORS.map((color) => (<button type="button" onClick={__cfHandler_1({
                selected: selected,
                color: color
            })}>
            {color}
          </button>))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        selected: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["selected"]
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1
});
