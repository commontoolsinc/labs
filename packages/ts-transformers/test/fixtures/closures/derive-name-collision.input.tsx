/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

export default pattern(() => {
  const multiplier = Writable.of(2);

  // Input name collides with capture name
  // multiplier is both the input AND a captured variable (used via .get())
  const result = derive(multiplier, (m) => m.get() * 3 + multiplier.get());

  return result;
});
