/// <cts-enable />
import {
  computed,
  pattern,
} from "commontools";

interface Input {
  foo: string;
}

interface Output extends Input {
  bar: number;
}

export default pattern<Input, Output>((input) => {
  return computed(() => ({ ...input, bar: 123 }));
});
