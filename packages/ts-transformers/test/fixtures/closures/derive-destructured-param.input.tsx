/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface Point {
  x: number;
  y: number;
}

export default pattern(() => {
  const point = Writable.of({ x: 10, y: 20 } as Point);
  const multiplier = Writable.of(2);

  // Destructuring requires .get() first since derive doesn't unwrap Cell
  const result = derive(point, (p) => {
    const { x, y } = p.get();
    return (x + y) * multiplier.get();
  });

  return result;
});
