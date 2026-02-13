import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestLiteralWidenNestedStructure() {
    const _nested = cell({
        users: [
            { id: 1, name: "Alice", active: true },
            { id: 2, name: "Bob", active: false }
        ],
        count: 2
    }, {
        type: "object",
        properties: {
            users: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "number"
                        },
                        name: {
                            type: "string"
                        },
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "name", "active"]
                }
            },
            count: {
                type: "number"
            }
        },
        required: ["users", "count"]
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
