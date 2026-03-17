import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
// CT-1334: computed() with template literal capturing pattern parameter.
// The `token` from pattern destructuring must be captured as an explicit
// input to the derived derive() call, so the callback receives the
// resolved value—not the OpaqueRef proxy.
export default pattern((__ct_pattern_input: {
    token: string;
}) => {
    const token = __ct_pattern_input.key("token");
    const url = __ctHelpers.derive({
        type: "object",
        properties: {
            token: {
                type: "string"
            }
        },
        required: ["token"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, { token: token }, ({ token }) => `http://api.example.com?token=${token}`);
    const options = __ctHelpers.derive({
        type: "object",
        properties: {
            token: {
                type: "string"
            }
        },
        required: ["token"]
    } as const satisfies __ctHelpers.JSONSchema, {
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
    } as const satisfies __ctHelpers.JSONSchema, { token: token }, ({ token }) => ({
        headers: { Authorization: `Bearer ${token}` },
    }));
    return { url, options };
}, false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
