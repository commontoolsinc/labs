/// <cts-enable />
import {
  pattern,
} from "commontools";

interface Input {
  foo: string;
}

interface Output extends Input {
  bar: number;
}

export default pattern<Input, Output>((input) => {
  return { ...input, bar: 123 };
});
