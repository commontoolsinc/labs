/**
 * Fixture: a throwing action with expectRuntimeErrors: 1.
 * The runner must treat the error as required-and-satisfied — no failure.
 */
import { action, computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const untouched = new Writable(true);
  const stillUntouched = computed(() => untouched.get());

  const throwingAction = action(() => {
    throw new Error("verb rejected: intentional fixture throw");
  });

  return {
    tests: [
      { action: throwingAction },
      { assertion: stillUntouched },
    ],
    expectRuntimeErrors: 1,
  };
});
