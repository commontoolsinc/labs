import {
  Cell,
  cell,
  constant,
  cancellable,
  sink,
  mul,
  sub,
  div
} from './propagators.js';

function fahrenheitToCelsius(f: Cell<number>, c: Cell<number>) {
  const thirtyTwo = constant(32);
  const five = constant(5);
  const nine = constant(9);
  const fMin32 = cell(0);
  const cMult9 = cell(0);
  
  return cancellable(
    sub(f, thirtyTwo, fMin32),
    mul(fMin32, five, cMult9),
    div(cMult9, nine, c)
  );
}

const input = cell(0);
const output = cell(0);

fahrenheitToCelsius(
  input,
  output
);

sink(output, value => {
  console.log(value);
});