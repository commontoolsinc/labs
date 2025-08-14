/// <cts-enable />
import { toSchema, JSONSchema, recipe } from "commontools";

interface NodeA {
  value: string;
  nodeB: NodeB;
}

interface NodeB {
  value: number;
  nodeA: NodeA;
}

const nodeASchema = toSchema<NodeA>();

interface A {
  b: B;
}

interface B {
  c: C;
}

interface C {
  a: A;
}

const aSchema = toSchema<A>();

export { nodeASchema, aSchema };

// Add a recipe export for ct dev testing
export default recipe("Mutually Recursive Types Test", () => {
  return {
    schema: nodeASchema,
  };
});