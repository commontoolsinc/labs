/// <cts-enable />
import { cell, derive } from "commontools";

interface Point {
  x: number;
  y: number;
}

export default function TestDerive() {
  const point = cell({ x: 10, y: 20 } as Point);
  const multiplier = cell(2);

  // Destructured parameter
  const result = derive(point, ({ x, y }) => (x + y) * multiplier.get());

  return result;
}
