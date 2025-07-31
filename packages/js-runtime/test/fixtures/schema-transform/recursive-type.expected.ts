/// <cts-enable />
import { JSONSchema, recipe } from "commontools";
interface LinkedList {
    value: number;
    next?: LinkedList;
}
const linkedListSchema = {
    $ref: "#/definitions/LinkedList",
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
        }
    }
} as const satisfies JSONSchema;
export { linkedListSchema };
// Add a recipe export for ct dev testing
export default recipe("Recursive Type Test", () => {
    return {
        schema: linkedListSchema,
    };
});