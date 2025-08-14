/// <cts-enable />
import { JSONSchema, recipe } from "commontools";
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
