import * as __ctHelpers from "commontools";
import { cell } from "commontools";
// FIXTURE: collections-array-of-objects
// Verifies: schema injection generates array-of-objects schema with typed items and required keys
//   cell([{id: 1, name: "Alice", ...}]) → cell([...], { type: "array", items: { type: "object", properties: {...}, required: [...] } })
export default function TestCollectionsArrayOfObjects() {
    // Array of objects
    const _arrayOfObjects = cell([
        { id: 1, name: "Alice", score: 95.5 },
        { id: 2, name: "Bob", score: 87.3 },
        { id: 3, name: "Charlie", score: 92.1 }
    ], {
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
                score: {
                    type: "number"
                }
            },
            required: ["id", "name", "score"]
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return _arrayOfObjects;
}
void __ctHelpers;
