/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const multiplier = Writable.of(2);

  // Input name 'multiplier' collides with captured variable 'multiplier'
  // The callback returns an object with a property named 'multiplier'
  // Only the variable reference should be renamed, NOT the property name
  const result = derive(multiplier, (m) => ({
    multiplier: multiplier.get(),
    value: m.get() * 3,
  }));

  return result;
});
