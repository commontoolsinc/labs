/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const a = Writable.of(10);
  const b = Writable.of(20);
  const c = Writable.of(30);

  const result = derive(a, (x) => (x.get() * b.get() + c.get()) / 2);

  return result;
});
