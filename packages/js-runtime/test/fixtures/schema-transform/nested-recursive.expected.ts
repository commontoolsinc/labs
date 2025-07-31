/// <cts-enable />
import { JSONSchema, recipe } from "commontools";
interface TreeNode {
    value: number;
    left?: TreeBranch;
    right?: TreeBranch;
}
interface TreeBranch {
    node: TreeNode;
    metadata: string;
}
const treeNodeSchema = {
    $ref: "#/definitions/TreeNode",
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
        TreeBranch: {
            type: "object",
            properties: {
                node: {
                    $ref: "#/definitions/TreeNode"
                },
                metadata: {
                    type: "string"
                }
            },
            required: ["node", "metadata"]
        },
        TreeNode: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                },
                left: {
                    $ref: "#/definitions/TreeBranch"
                },
                right: {
                    $ref: "#/definitions/TreeBranch"
                }
            },
            required: ["value"]
        }
    }
} as const satisfies JSONSchema;
export { treeNodeSchema };
// Add a recipe export for ct dev testing
export default recipe("Nested Recursive Types Test", () => {
    return {
        schema: treeNodeSchema,
    };
});