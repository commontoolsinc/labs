/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const multiplier = Writable.of(2);

  // Input name 'multiplier' collides with captured variable 'multiplier'
  // The callback uses shorthand property { multiplier }
  // This should expand to { multiplier: multiplier_1 } after renaming
  const result = derive(multiplier, (m) => ({
    value: m.get() * 3,
    data: { multiplier },
  }));

  return result;
});
