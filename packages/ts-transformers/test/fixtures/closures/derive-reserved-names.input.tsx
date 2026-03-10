/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const value = Writable.of(10);
  // Reserved JavaScript keyword as variable name (valid in TS with quotes)
  const __ct_reserved = Writable.of(2);

  const result = derive(value, (v) => v.get() * __ct_reserved.get());

  return result;
});
