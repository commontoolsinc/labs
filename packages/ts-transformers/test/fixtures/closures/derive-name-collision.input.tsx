/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const multiplier = cell(2);

  // Input name collides with capture name
  // multiplier is both the input AND a captured variable (used via .get())
  const result = derive(multiplier, (m) => m.get() * 3 + multiplier.get());

  return result;
}
