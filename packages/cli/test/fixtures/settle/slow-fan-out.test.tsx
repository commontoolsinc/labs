/**
 * Fixture whose render step takes longer to settle than a small `--timeout`
 * while the scheduler keeps running actions the whole way through: many
 * computed values over one input, each spinning for a while, all demanded by
 * the rendered total. Materializing the render runs every one of them, one
 * scheduler run each, so the settle is slow but never stalls.
 */

import {
  action,
  assert,
  computed,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

const COUNT = 200;
const INPUT = 10;
const INDICES = Array.from({ length: COUNT }, (_, index) => index);
const EXPECTED_TOTAL = INDICES.reduce((sum, index) => sum + INPUT + index, 0);

/**
 * Spins for a while, then returns `value + offset`. The spin's result is
 * folded in as a term that is always zero for the values it takes, so it is
 * not dead code to the compiler, and the output stays exact.
 */
function slowAdd(value: number, offset: number): number {
  let x = 1;
  for (let i = 0; i < 1_500_000; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
  }
  return value + offset + Math.floor(x / 2 ** 40);
}

export default pattern(() => {
  const input = new Writable(0);
  const rows = INDICES.map((index) =>
    computed(() => slowAdd(input.get(), index))
  );
  // Reading every row from one place is what demands them all; a row nothing
  // reads is never computed.
  const total = computed(() => rows.reduce((sum, row) => sum + row, 0));
  return {
    [TESTS]: [
      { action: action(() => input.set(INPUT)) },
      { render: <div>{total}</div> },
      { assertion: assert(() => total === EXPECTED_TOTAL) },
    ],
  };
});
