/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface Point {
  x: number;
  y: number;
}

// FIXTURE: derive-destructured-param
// Verifies: a captured cell works alongside destructuring inside the callback body
//   derive(point, fn) → derive(schema, schema, { point, multiplier }, fn)
// Context: `const { x, y } = p` destructures inside the body, not the parameter
export default pattern(() => {
  const point = Writable.of({ x: 10, y: 20 } as Point);
  const multiplier = Writable.of(2);

  const result = derive(point, (p) => {
    const { x, y } = p;
    return (x + y) * multiplier.get();
  });

  return result;
});
