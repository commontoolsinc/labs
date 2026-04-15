function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: handler-captured-callable-export-binding
// Verifies: inline JSX handlers should not route captured plain callables through
// explicit handler state. The helper should remain lexical in the callback body.
function makePattern(helper: (value: string) => string) {
    return pattern(() => {
        return {
            [UI]: <cf-button onClick={__cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
                type: "object",
                properties: {}
            } as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, __cf_handler_params) => helper("x"))({})}>Go</cf-button>,
        };
    }, false as const satisfies __cfHelpers.JSONSchema, {
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
}
__cfHardenFn(makePattern);
const helper = __cfHardenFn((value: string) => value.toUpperCase());
const myPattern = __cfHelpers.__cf_data(makePattern(helper));
export default myPattern;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
