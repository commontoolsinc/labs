import { build } from "@commonfabric/felt";
import { LaunchOptions } from "@astral/astral";
import * as path from "@std/path";
import { exists } from "@std/fs/exists";

// These configurations can be applied
// by placing a `deno-web-test.config.ts` in package root.
export type Config = {
  // Whether the test runner should run headlessly. Default: true.
  headless?: boolean;
  // What browser to run.
  product?: "chrome" | "firefox";
  // Arguments to be passed into the browser.
  args?: string[];
  // Whether or not console commands should be propagated to the deno-web-test process.
  pipeConsole?: boolean;
  // How long a single test may run, in ms, before the harness stops waiting on
  // it and fails it as stuck. Default: `DEFAULT_TEST_TIMEOUT_MS`. Raise it for
  // a suite with genuinely long tests; it is a stuck-test detector, so it
  // belongs well above anything the suite does when it is healthy.
  testTimeout?: number;
  // A map of relative file paths to copy to the static server during testing.
  // The keys are relative file paths and the values are the destination from
  // the server root.
  include?: Record<string, string>;
  esbuildConfig?: Parameters<typeof build>[0];
};

// How long a test may run before the harness calls it stuck.
//
// This is a safety net, not a latency bound. Its early fire fails a passing
// test, so by the reasoning in docs/development/waiting-in-tests.md it is a
// bound whose early fire is not safe, kept only because the alternative is
// worse. The alternative is astral's own deadline: each test is awaited through
// one `page.evaluate`, which astral wraps in `retry(() => deadline(evaluate,
// 10_000))`. That does not re-run a slow test. The evaluate is issued once, and
// each of the five attempts re-waits on that same in-flight call with a fresh
// ten-second deadline, so the test body runs once and a slow one is returned by
// whichever attempt is live when it settles. A test that never settles exhausts
// the attempts around fifty seconds — five ten-second timers no machine runs
// through faster, plus the retry's backoff, measured at 53 to 57 seconds — and
// throws a `RetryError` that names no test, prints no summary, and abandons
// every test file still queued. Firing before that, by name, and letting the
// run continue is the whole point.
//
// That fifty-second floor also caps this bound, and the cap is what sizes it.
// The bound can trip early on a healthy test whenever the clock jumps — a
// suspend, a CI pause, a live-migration — by more than the bound. Astral's
// re-waiting rides such a jump out, since a later attempt returns the same call
// once it settles, where this single timer does not. The window in which this
// bound fires but astral would not is the gap between the
// bound and the floor, so the bound wants to sit as high under the floor as
// still reliably beats it, not low: a large margin here is a wider failure
// window, not safety. Forty seconds clears the fifty-second floor with room for
// the backoff on top and holds the clock-jump window to about ten seconds. The
// slowest healthy test in any suite using this runner is about a second, and
// that one is deliberately waiting out a timer, so real work never approaches
// forty. A suite that somehow needs more should raise `testTimeout` and keep it
// under the fifty-second floor.
export const DEFAULT_TEST_TIMEOUT_MS = 40_000;

export const applyDefaults = (config: object): Config => {
  const applied: Config = Object.assign({
    headless: true,
    devtools: false,
    pipeConsole: true,
    testTimeout: DEFAULT_TEST_TIMEOUT_MS,
  }, config);

  // A `testTimeout` that is not a positive, finite number cannot mean anything
  // the detector can act on. Zero and a negative both ask `setTimeout` to fire
  // at once and would fail every test in the suite; `Infinity` is clamped to
  // the same thing. Say so here rather than let the harness quietly substitute
  // its own default and run with a bound the config did not ask for.
  const { testTimeout } = applied;
  if (!Number.isFinite(testTimeout) || (testTimeout as number) <= 0) {
    throw new Error(
      `deno-web-test.config.ts: \`testTimeout\` must be a positive number of ` +
        `milliseconds, got ${testTimeout}.`,
    );
  }

  return applied;
};

export const extractAstralConfig = (config: Config): LaunchOptions => {
  const astralConfig: LaunchOptions = {};
  if ("headless" in config) astralConfig.headless = config.headless;
  if ("product" in config) astralConfig.product = config.product;
  if ("args" in config) astralConfig.args = config.args;
  return astralConfig;
};

export const getConfig = async (projectDir: string): Promise<Config> => {
  const configPath = path.join(projectDir, "deno-web-test.config.ts");

  if (await exists(configPath, { isFile: true })) {
    // Try to evaluate it
    try {
      const config = (await import(configPath)).default;
      return applyDefaults(config);
    } catch (_) {
      console.error(`Unable to execute deno-web-test.config.ts`);
    }
  }
  return applyDefaults({});
};
