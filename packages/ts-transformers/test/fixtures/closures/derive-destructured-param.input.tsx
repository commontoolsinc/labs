/// <cts-enable />
import { cell, derive } from "commontools";

interface Point {
  x: number;
  y: number;
}

export default function TestDerive() {
  const point = cell({ x: 10, y: 20 } as Point);
  const multiplier = cell(2);

  // Destructuring requires .get() first since derive doesn't unwrap Cell
  const result = derive(point, (p) => {
    const { x, y } = p.get();
    return (x + y) * multiplier.get();
  });

  return result;
}
