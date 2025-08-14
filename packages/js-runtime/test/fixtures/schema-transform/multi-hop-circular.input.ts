/// <cts-enable />
import { toSchema, JSONSchema, recipe } from "commontools";

// Multi-hop circular reference pattern
interface A {
  b: B;
}

interface B {
  c: C;
}

interface C {
  a: A;
}

const multiHopSchema = toSchema<A>();

export { multiHopSchema };

// Add a recipe export for ct dev testing
export default recipe("Multi-Hop Circular Reference Test", () => {
  return {
    schema: multiHopSchema,
  };
});