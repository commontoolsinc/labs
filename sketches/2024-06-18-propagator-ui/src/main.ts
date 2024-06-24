import {
  config,
  Cell,
  cell,
  constant,
  cancellable,
  sink,
  mul,
  sub,
  div,
  AnyCell
} from './propagators.js';

config.debug = false;

function fahrenheitToCelsius(f: Cell<number>, c: Cell<number>) {
  const thirtyTwo = constant(32);
  const five = constant(5);
  const nine = constant(9);
  const fMin32 = cell(() => 0);
  const cMult9 = cell(() => 0);
  
  return cancellable(
    sub(f, thirtyTwo, fMin32),
    mul(fMin32, five, cMult9),
    div(cMult9, nine, c)
  );
}

const input = cell(() => 0);
const output = cell(() => 0);

fahrenheitToCelsius(
  input,
  output
);

sink(output, value => {
  console.log(value);
});

export const diamond = (input: AnyCell<number>, output: Cell<number>) => {
  const l = cell(() => 0);
  const r = cell(() => 0);
  
  return cancellable(
    mul(input, constant(10), l),
    div(input, constant(2), r),
    mul(l, r, output)
  );
}

const input2 = cell(() => 3);
const output2 = cell(() => 0);

diamond(input2, output2);

sink(output2, value => {
  console.log(value);
});