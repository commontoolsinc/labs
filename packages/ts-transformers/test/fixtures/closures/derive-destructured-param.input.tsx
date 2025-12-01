/// <cts-enable />
import { cell, derive } from "commontools";

interface Point {
  x: number;
  y: number;
}

export default function TestDerive() {
  const point = cell({ x: 10, y: 20 } as Point);
  const multiplier = cell(2);

  // Convenience pattern: transformer unwraps Cell<Point> so callback receives Point
  // @ts-expect-error Testing convenience pattern: destructured param from Cell value
  const result = derive(point, ({ x, y }) => (x + y) * multiplier.get());

  return result;
}
