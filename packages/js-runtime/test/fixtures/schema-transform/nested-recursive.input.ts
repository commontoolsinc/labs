/// <cts-enable />
import { toSchema, JSONSchema, recipe } from "commontools";

interface TreeNode {
  value: number;
  left?: TreeBranch;
  right?: TreeBranch;
}

interface TreeBranch {
  node: TreeNode;
  metadata: string;
}

const treeNodeSchema = toSchema<TreeNode>();

export { treeNodeSchema };

// Add a recipe export for ct dev testing
export default recipe("Nested Recursive Types Test", () => {
  return {
    schema: treeNodeSchema,
  };
});