/// <cts-enable />
import { toSchema, recipe } from "commontools";

interface B {
  value: string;
}

interface A {
  b1: B;
  b2: B;
}

const schema = toSchema<A>();

export default recipe("shared-type test", () => {
  return { schema };
});