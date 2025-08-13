/// <cts-enable />
import { toSchema, JSONSchema, recipe } from "commontools";

// NOTE: The expected output for this test is currently a placeholder.
// This test demonstrates a stack overflow bug when recursive types are
// nested inside other types. Once the bug is fixed, the expected output
// should be updated with the actual transformation result.

interface LinkedList {
  value: number;
  next?: LinkedList;
}

interface RootType {
  list: LinkedList;
}

const rootTypeSchema = toSchema<RootType>();

export { rootTypeSchema };

// Add a recipe export for ct dev testing
export default recipe("Nested Recursive Type Test", () => {
  return {
    schema: rootTypeSchema,
  };
});