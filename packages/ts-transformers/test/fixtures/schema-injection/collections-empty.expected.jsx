import * as __ctHelpers from "commontools";
import { Writable, pattern } from "commontools";
export default pattern(() => {
    // Empty array
    const _emptyArray = Writable.of<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    // Empty object
    const _emptyObject = Writable.of({}, {
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        emptyArray: _emptyArray,
        emptyObject: _emptyObject,
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        emptyArray: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: true
        },
        emptyObject: {
            type: "object",
            properties: {},
            asCell: true
        }
    },
    required: ["emptyArray", "emptyObject"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
