/// <cts-enable />
/**
 * TEST PATTERN: Verify "Never use await in handlers" claim
 *
 * CLAIM FROM DEBUGGING.md:
 * "Never use await in handlers (use fetchData instead)"
 *
 * This pattern tests whether await in handlers actually blocks the UI.
 *
 * MANUAL TEST INSTRUCTIONS:
 *
 * 1. Open this pattern in the runner
 * 2. Click "Test WITH await (Bad?)" button
 *    - This triggers a handler with await and a 3-second delay
 *    - While waiting, try clicking the counter increment button
 *    - EXPECTED (if claim is TRUE): Counter button is unresponsive, UI frozen
 *    - OBSERVED: [Record your findings here after testing]
 *
 * 3. Wait for the operation to complete
 * 4. Click "Test WITHOUT await (Good)" button
 *    - This uses fetchData with the same 3-second delay
 *    - While waiting, try clicking the counter increment button
 *    - EXPECTED: Counter button works, UI responsive
 *    - OBSERVED: [Record your findings here after testing]
 *
 * 5. Compare the two approaches
 *    - Does await actually block the UI?
 *    - Is fetchData actually non-blocking?
 *
 * WHAT TO LOOK FOR:
 * - Can you increment the counter while "Awaiting..." is displayed?
 * - Can you increment the counter while "Fetching..." is displayed?
 * - Does the UI feel frozen during the await operation?
 * - Are there visual differences in how the two approaches behave?
 *
 * CONCLUSION:
 * [Fill in after manual testing - does the claim hold up?]
 */

import {
  Default,
  derive,
  fetchData,
  handler,
  NAME,
  recipe,
  UI,
  Writable,
} from "commontools";

// Handler WITH await (supposedly blocks UI)
const testWithAwait = handler<
  unknown,
  {
    awaitStatus: Writable<string>;
    awaitResult: Writable<string>;
    awaitCount: Writable<number>;
  }
>(async (_args, state) => {
  // Increment counter to show how many times this was triggered
  state.awaitCount.set(state.awaitCount.get() + 1);

  state.awaitStatus.set("Awaiting...");
  state.awaitResult.set("");

  try {
    // THIS IS THE KEY TEST: Does await block the UI?
    await new Promise((resolve) => setTimeout(resolve, 3000));
    state.awaitResult.set("Completed after 3000ms");
    state.awaitStatus.set("Completed");
  } catch (error) {
    state.awaitStatus.set("Error");
    state.awaitResult.set(String(error));
  }
});

// Handler WITHOUT await (triggers reactive flow by changing state)
// This demonstrates the correct pattern: handler is synchronous,
// async work happens in the reactive layer via fetchData
const testWithoutAwait = handler<
  unknown,
  {
    fetchTrigger: Writable<number>;
    fetchCount: Writable<number>;
  }
>((_args, state) => {
  // Increment counter to show how many times this was triggered
  state.fetchCount.set(state.fetchCount.get() + 1);

  // Trigger by updating a cell - handler returns IMMEDIATELY
  // The actual async work happens in fetchData in the pattern body
  state.fetchTrigger.set(Temporal.Now.instant().epochMilliseconds);
});

// Simple counter increment to test UI responsiveness
const incrementCounter = handler<unknown, { counter: Writable<number> }>(
  (_args, state) => {
    state.counter.set(state.counter.get() + 1);
  },
);

// Reset all state
const resetAll = handler<
  unknown,
  {
    awaitStatus: Writable<string>;
    awaitResult: Writable<string>;
    awaitCount: Writable<number>;
    fetchTrigger: Writable<number>;
    fetchCount: Writable<number>;
    counter: Writable<number>;
  }
>((_args, state) => {
  state.awaitStatus.set("Ready");
  state.awaitResult.set("");
  state.awaitCount.set(0);
  state.fetchTrigger.set(0);
  state.fetchCount.set(0);
  state.counter.set(0);
});

interface PatternState {
  // State for await test
  awaitStatus: Default<string, "Ready">;
  awaitResult: Default<string, "">;
  awaitCount: Default<number, 0>;

  // State for reactive/fetchData test
  fetchTrigger: Default<number, 0>;
  fetchCount: Default<number, 0>;

  // Interactive counter to test responsiveness
  counter: Default<number, 0>;
}

export default recipe<PatternState>("Await in Handlers Test", (state) => {
  // Build URL reactively from trigger - uses local /_health endpoint with delay
  const fetchUrl = derive(
    state.fetchTrigger,
    (trigger) => trigger ? `/_health?delay=3000&_=${trigger}` : "",
  );

  // fetchData runs in the reactive layer - doesn't block the handler
  const fetchDataResult = fetchData<Record<string, unknown>>({
    url: fetchUrl,
    mode: "json",
  });

  const fetchStatus = derive(
    [fetchDataResult.pending, fetchDataResult.error, state.fetchTrigger],
    ([pending, error, trigger]) => {
      if (pending) return "Fetching...";
      if (error) return "Error";
      if (trigger) return "Completed";
      return "Ready";
    },
  );

  const fetchResultText = derive(
    [fetchDataResult.error, fetchDataResult.result, state.fetchCount],
    ([error, result, count]) => {
      if (error) return String(error);
      if (result) return `Fetched successfully (${count} triggers)`;
      return "(none)";
    },
  );

  return {
    [NAME]: "Test: Await in Handlers",
    [UI]: (
      <div style="padding: 20px; font-family: system-ui;">
        <h2>Test: Does await Block UI in Handlers?</h2>

        {/* All buttons together for quick clicking */}
        <div style="background: #f0f0f0; padding: 15px; margin: 20px 0; border-radius: 8px;">
          <h3 style="margin-top: 0;">
            Test Buttons (click test, then spam counter)
          </h3>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <ct-button id="test-with-await" onClick={testWithAwait(state)}>
              WITH await (3s)
            </ct-button>
            <ct-button
              id="test-without-await"
              onClick={testWithoutAwait(state)}
            >
              WITHOUT await (3s)
            </ct-button>
            <ct-button id="increment-counter" onClick={incrementCounter(state)}>
              Counter: {state.counter}
            </ct-button>
            <ct-button id="reset-all" onClick={resetAll(state)}>
              Reset
            </ct-button>
          </div>
          <p style="margin: 10px 0 0 0; font-size: 13px; color: #666;">
            Click a test button, then immediately spam the Counter button to
            test responsiveness
          </p>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
          <div style="border: 2px solid #ff6b6b; padding: 15px; border-radius: 8px;">
            <h3 style="margin-top: 0; color: #ff6b6b;">
              Test 1: WITH await (Supposedly Bad)
            </h3>

            <div style="margin: 15px 0;">
              <div style="margin: 8px 0;">
                <strong>Status:</strong>
                <span
                  id="await-status"
                  style="margin-left: 10px; padding: 4px 8px; background: #f0f0f0; border-radius: 4px;"
                >
                  {state.awaitStatus}
                </span>
              </div>
              <div style="margin: 8px 0;">
                <strong>Result:</strong>
                <span id="await-result" style="margin-left: 10px;">
                  {state.awaitResult || "(none)"}
                </span>
              </div>
              <div style="margin: 8px 0;">
                <strong>Triggered:</strong> {state.awaitCount} times
              </div>
            </div>

            <div style="background: #fff3cd; padding: 10px; border-radius: 4px; font-size: 13px; margin-top: 10px;">
              <strong>Expected:</strong>{" "}
              Counter button unresponsive while "Awaiting..."
            </div>
          </div>

          <div style="border: 2px solid #4CAF50; padding: 15px; border-radius: 8px;">
            <h3 style="margin-top: 0; color: #4CAF50;">
              Test 2: WITHOUT await (Supposedly Good)
            </h3>

            <div style="margin: 15px 0;">
              <div style="margin: 8px 0;">
                <strong>Status:</strong>
                <span
                  id="fetch-status"
                  style="margin-left: 10px; padding: 4px 8px; background: #f0f0f0; border-radius: 4px;"
                >
                  {fetchStatus}
                </span>
              </div>
              <div style="margin: 8px 0;">
                <strong>Result:</strong>
                <span id="fetch-result" style="margin-left: 10px;">
                  {fetchResultText}
                </span>
              </div>
              <div style="margin: 8px 0;">
                <strong>Triggered:</strong> {state.fetchCount} times
              </div>
            </div>

            <div style="background: #d4edda; padding: 10px; border-radius: 4px; font-size: 13px; margin-top: 10px;">
              <strong>Expected:</strong>{" "}
              Counter button works while "Fetching..."
            </div>
          </div>
        </div>

        <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Expected Results (According to Claim)</h3>
          <ul style="margin: 10px 0;">
            <li>
              <strong>WITH await:</strong>{" "}
              UI should freeze. Counter button unresponsive while "Awaiting..."
              is shown.
            </li>
            <li>
              <strong>WITHOUT await (fetchData):</strong>{" "}
              UI should stay responsive. Counter button works while
              "Fetching..." is shown.
            </li>
          </ul>
        </div>
      </div>
    ),
  };
});
