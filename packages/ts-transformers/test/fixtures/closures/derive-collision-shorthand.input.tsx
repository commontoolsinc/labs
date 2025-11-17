/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDeriveCollisionShorthand() {
  const multiplier = cell(2);

  // Input name 'multiplier' collides with captured variable 'multiplier'
  // The callback uses shorthand property { multiplier }
  // This should expand to { multiplier: multiplier_1 } after renaming
  const result = derive(multiplier, (m) => ({
    value: m * 3,
    data: { multiplier },
  }));

  return result;
}
