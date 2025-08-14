/// <cts-enable />
import { toSchema, JSONSchema, recipe } from "commontools";

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