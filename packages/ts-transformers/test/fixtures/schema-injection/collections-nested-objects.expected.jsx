import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
// FIXTURE: collections-nested-objects
// Verifies: deeply nested object literals produce recursively nested object schemas
//   cell({ user: { address: { street, city } }, timestamp }) → cell(..., { type: "object", properties: { user: { type: "object", properties: { address: { type: "object", ... } } } } })
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
    } as const satisfies __cfHelpers.JSONSchema);
    return _nested;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
