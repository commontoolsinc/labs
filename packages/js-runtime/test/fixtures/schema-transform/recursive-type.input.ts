/// <cts-enable />
import { toSchema, JSONSchema, recipe } from "commontools";

interface LinkedList {
  value: number;
  next?: LinkedList;
}

const linkedListSchema = toSchema<LinkedList>();

export { linkedListSchema };

// Add a recipe export for ct dev testing
export default recipe("Recursive Type Test", () => {
  return {
    schema: linkedListSchema,
  };
});