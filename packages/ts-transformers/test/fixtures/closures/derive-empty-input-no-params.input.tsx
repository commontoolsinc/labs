/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);

  // Zero-parameter callback that closes over a and b
  const result = derive({}, () => a.get() + b.get());

  return result;
});
