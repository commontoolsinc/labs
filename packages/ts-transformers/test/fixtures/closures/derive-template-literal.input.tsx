/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  const prefix = Writable.of("Value: ");

  const result = derive(value, (v) => `${prefix.get()}${v}`);

  return result;
});
