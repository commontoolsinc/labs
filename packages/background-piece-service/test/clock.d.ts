// Ambient types for the clock preload (`clock-preload.ts`). `deno check` sees
// this because it type-checks the package as one program (`deno task check`);
// test files reference `clock` with no import. Declared with `var` rather than
// `const` so it merges with the identical global that `packages/runner` declares
// for its own copy of this harness: `deno task check` compiles every workspace
// package as one program, and two block-scoped `const clock` bindings there
// collide (TS2451), while two `var` bindings of the same type merge.
// deno-lint-ignore no-var
declare var clock: {
  // Drain reactive (zero-delay) work to a fixpoint without moving the clock.
  settle(): Promise<void>;
  // Advance logical time by `ms`, firing positive-delay timers in lockstep with
  // Date.now and performance.now.
  tick(ms: number): Promise<void>;
  // Return logical time to zero and drop every pending timer. Call from
  // `beforeEach` in a suite whose cases each start from a known instant.
  reset(): void;
};
