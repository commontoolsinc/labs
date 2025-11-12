/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDeriveCollisionProperty() {
  const multiplier = cell(2);

  // Input name 'multiplier' collides with captured variable 'multiplier'
  // The callback returns an object with a property named 'multiplier'
  // Only the variable reference should be renamed, NOT the property name
  const result = derive(multiplier, (m) => ({
    multiplier: multiplier.get(),
    value: m * 3,
  }));

  return result;
}
