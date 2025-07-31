/// <cts-enable />
import { JSONSchema, recipe } from "commontools";
interface NodeA {
    value: string;
    nodeB: NodeB;
}
interface NodeB {
    value: number;
    nodeA: NodeA;
}
const nodeASchema = {
    $ref: "#/definitions/NodeA",
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
        NodeB: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                },
                nodeA: {
                    $ref: "#/definitions/NodeA"
                }
            },
            required: ["value", "nodeA"]
        },
        NodeA: {
            type: "object",
            properties: {
                value: {
                    type: "string"
                },
                nodeB: {
                    $ref: "#/definitions/NodeB"
                }
            },
            required: ["value", "nodeB"]
        }
    }
} as const satisfies JSONSchema;
export { nodeASchema };
// Add a recipe export for ct dev testing
export default recipe("Mutually Recursive Types Test", () => {
    return {
        schema: nodeASchema,
    };
});