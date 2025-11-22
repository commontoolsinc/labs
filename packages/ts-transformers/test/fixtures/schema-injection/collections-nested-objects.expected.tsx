import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestCollectionsNestedObjects() {
    // Nested objects
    const _nested = cell({
        user: {
            name: "Alice",
            age: 30,
            address: {
                street: "123 Main St",
                city: "NYC"
            }
        },
        timestamp: 1234567890
    }, {
        type: "object",
        properties: {
            user: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    age: {
                        type: "number"
                    },
                    address: {
                        type: "object",
                        properties: {
                            street: {
                                type: "string"
                            },
                            city: {
                                type: "string"
                            }
                        },
                        required: ["street", "city"]
                    }
                },
                required: ["name", "age", "address"]
            },
            timestamp: {
                type: "number"
            }
        },
        required: ["user", "timestamp"]
    } as const satisfies __ctHelpers.JSONSchema);
    return _nested;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
