import { Writable, derive, pattern } from "commonfabric";

interface Point {
  x: number;
  y: number;
}

// FIXTURE: derive-destructured-param
// Verifies: a captured cell works alongside destructuring inside the callback body
//   derive(point, fn) → derive(schema, schema, { point, multiplier }, fn)
// Context: `const { x, y } = p.get()` destructures inside the body, not the parameter
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
