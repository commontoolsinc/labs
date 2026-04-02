function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// CT-1334: computed() with template literal capturing pattern parameter.
// The `token` from pattern destructuring must be captured as an explicit
// input to the derived derive() call, so the callback receives the
// resolved value—not the OpaqueRef proxy.
export default pattern((__ct_pattern_input: {
    token: string;
}) => {
    const token = __ct_pattern_input.key("token");
    const url = __cfHelpers.derive({
        type: "object",
        properties: {
            token: {
                type: "string"
            }
        },
        required: ["token"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { token: token }, ({ token }) => `http://api.example.com?token=${token}`);
    const options = __cfHelpers.derive({
        type: "object",
        properties: {
            token: {
                type: "string"
            }
        },
        required: ["token"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            headers: {
                type: "object",
                properties: {
                    Authorization: {
                        type: "string"
                    }
                },
                required: ["Authorization"]
            }
        },
        required: ["headers"]
    } as const satisfies __cfHelpers.JSONSchema, { token: token }, ({ token }) => ({
        headers: { Authorization: `Bearer ${token}` },
    }));
    return { url, options };
}, {
    type: "object",
    properties: {
        token: {
            type: "string"
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        url: {
            type: "string"
        },
        options: {
            type: "object",
            properties: {
                headers: {
                    type: "object",
                    properties: {
                        Authorization: {
                            type: "string"
                        }
                    },
                    required: ["Authorization"]
                }
            },
            required: ["headers"]
        }
    },
    required: ["url", "options"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
