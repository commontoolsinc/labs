/// <cts-enable />
import { JSONSchema, recipe } from "commontools";

// NOTE: This expected output is currently a PLACEHOLDER.
// The actual test causes a stack overflow due to a bug with nested recursive types.
// Once the bug is fixed, this file should be updated with the actual expected
// transformation output.

interface LinkedList {
    value: number;
    next?: LinkedList;
}

interface RootType {
    list: LinkedList;
}

const rootTypeSchema = {
    $ref: "#/definitions/RootType",
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
        LinkedList: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                },
                next: {
                    $ref: "#/definitions/LinkedList"
                }
            },
            required: ["value"]
        },
        RootType: {
            type: "object",
            properties: {
                list: {
                    $ref: "#/definitions/LinkedList"
                }
            },
            required: ["list"]
        }
    }
} as const satisfies JSONSchema;
export { rootTypeSchema };

// Add a recipe export for ct dev testing
export default recipe("Nested Recursive Type Test", () => {
    return {
        schema: rootTypeSchema,
    };
});
