/**
 * Fixture: console.error in a computed handler with NO allowConsoleErrors flag.
 * The test runner must fail this even though the assertion passes.
 */
import { action, computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const triggered = new Writable(false);
  const didTrigger = computed(() => triggered.get());

  const triggerError = action(() => {
    console.error("intentional-test-error: this should fail the test");
    triggered.set(true);
  });

  return {
    tests: [
      { action: triggerError },
      { assertion: didTrigger },
    ],
  };
});
