/// <cts-enable />
/**
 * TEST PATTERN: bgUpdater Server vs Browser Execution
 *
 * CLAIM: bgUpdater handlers can run in both browser (manual) and server (background) contexts
 * SOURCE: folk_wisdom/background-execution.md
 * STATUS: ✅ VERIFIED (2024-12-11)
 *
 * IMPORTANT DISCOVERY: bgUpdater is POLLING-BASED, not event-driven!
 * - bgUpdater does NOT auto-trigger when captured cells change
 * - It requires the background-piece-service to be running
 * - The service polls pieces on a schedule (default: 60 seconds)
 * - The piece must be registered with the service via POST /api/integrations/bg
 *
 * VERIFICATION STATUS:
 * - Browser execution: ✅ VERIFIED (click button, see [BROWSER] logs)
 * - Server execution: ✅ VERIFIED BY CODE REVIEW (background-piece-service/src/worker.ts:188-196)
 *   The worker calls `updater.withTx(tx).send({})` to trigger bgUpdater server-side
 *
 * FULL BACKGROUND SERVICE SETUP (for live server-side testing):
 * 1. Registration API: POST /api/integrations/bg with {pieceId, space, integration}
 *    - CLI: curl -X POST localhost:8000/api/integrations/bg -d '{"pieceId":"...","space":"did:key:...","integration":"..."}'
 *    - UI: <ct-updater> component (has CORS issue locally)
 * 2. Space DID derivation: Identity.fromPassphrase("common user").derive(spaceName).did()
 * 3. System space: did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88 (common user + toolshed-system)
 * 4. Service requires ACL authorization to access system space
 * 5. Start: cd packages/background-piece-service && IDENTITY=<keyfile> API_URL=localhost:8000 deno task start
 *
 * LOCAL TESTING BLOCKERS:
 * - Background service needs identity with authority over system space
 * - Requires production-style ACL configuration
 * - Code review verification is sufficient for claim validation
 */
import { Default, handler, NAME, pattern, UI, Writable } from "commontools";

interface Input {
  runCount: Default<number, 0>;
  logs: Default<string[], []>;
}

// Browser-triggered handler - explicitly marks source as BROWSER
const browserTrigger = handler<
  unknown,
  { runCount: Writable<number>; logs: Writable<string[]> }
>((_event, state) => {
  const count = state.runCount.get() + 1;
  state.runCount.set(count);
  state.logs.push(
    `[BROWSER] Run #${count} at ${Temporal.Now.instant().toString()}`,
  );
});

// Clear logs handler
const clearLogs = handler<
  unknown,
  { runCount: Writable<number>; logs: Writable<string[]> }
>(
  (_event, state) => {
    state.runCount.set(0);
    state.logs.set([]);
  },
);

// bgUpdater handler - runs on server when background-piece-service triggers it
// The service sends {} as the event, handler executes server-side
const bgUpdateHandler = handler<
  unknown,
  { runCount: Writable<number>; logs: Writable<string[]> }
>((_event, state) => {
  const count = state.runCount.get() + 1;
  state.runCount.set(count);
  state.logs.push(
    `[SERVER] Run #${count} at ${Temporal.Now.instant().toString()} (bgUpdater poll)`,
  );
});

export default pattern<Input>(({ runCount, logs }) => {
  return {
    [NAME]: "Test: bgUpdater Server vs Browser",
    [UI]: (
      <div
        style={{ padding: "20px", fontFamily: "monospace", maxWidth: "700px" }}
      >
        <h2>bgUpdater: Server vs Browser Execution</h2>

        <div
          style={{
            backgroundColor: "#fff3cd",
            padding: "15px",
            borderRadius: "8px",
            marginBottom: "15px",
          }}
        >
          <strong>Claim:</strong>{" "}
          bgUpdater handlers run on SERVER via background-piece-service polling.
        </div>

        <div
          style={{
            backgroundColor: "#ffebee",
            padding: "15px",
            borderRadius: "8px",
            marginBottom: "15px",
          }}
        >
          <strong>Key Discovery:</strong>{" "}
          bgUpdater is POLLING-BASED (60s default), not event-driven!
          <ul
            style={{
              margin: "8px 0 0 0",
              paddingLeft: "20px",
              fontSize: "13px",
            }}
          >
            <li>Does NOT auto-trigger on cell changes</li>
            <li>Requires background-piece-service running</li>
            <li>Piece must be registered with service</li>
            <li>Service polls and sends {} to bgUpdater Stream</li>
          </ul>
        </div>

        <div
          style={{
            backgroundColor: "#e8f5e9",
            padding: "15px",
            borderRadius: "8px",
            marginBottom: "15px",
          }}
        >
          <strong>Run Count:</strong> {runCount}
        </div>

        <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
          <ct-button onClick={browserTrigger({ runCount, logs })}>
            Browser Trigger (click me)
          </ct-button>
          <ct-button onClick={clearLogs({ runCount, logs })}>
            Clear Logs
          </ct-button>
        </div>

        <div
          style={{
            backgroundColor: "#f5f5f5",
            padding: "15px",
            borderRadius: "8px",
            maxHeight: "250px",
            overflowY: "auto",
          }}
        >
          <strong>Execution Log (look for [BROWSER] vs [SERVER]):</strong>
          <ul style={{ margin: "10px 0", paddingLeft: "20px" }}>
            {logs.map((log, idx) => (
              <li
                key={idx}
                style={{
                  color: log.includes("[BROWSER]")
                    ? "#2e7d32"
                    : log.includes("[SERVER]")
                    ? "#1565c0"
                    : "#333",
                  fontWeight: log.includes("[SERVER]") ? "bold" : "normal",
                }}
              >
                {log}
              </li>
            ))}
          </ul>
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "15px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
          }}
        >
          <strong>VERIFICATION STATUS:</strong>
          <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li style={{ color: "#2e7d32" }}>
              [BROWSER] execution: Click button above - VERIFIED
            </li>
            <li style={{ color: "#1565c0" }}>
              [SERVER] execution: VERIFIED BY CODE REVIEW
            </li>
          </ul>
          <p style={{ fontSize: "12px", marginTop: "10px", color: "#666" }}>
            Server execution verified by reading
            background-piece-service/src/worker.ts:188-196. The worker calls
            {" "}
            <code>updater.withTx(tx).send({})</code>{" "}
            to trigger bgUpdater server-side.
          </p>
        </div>

        <div
          style={{
            marginTop: "15px",
            padding: "15px",
            backgroundColor: "#fce4ec",
            borderRadius: "8px",
          }}
        >
          <strong>To Test Server Execution Live:</strong>
          <ol
            style={{
              margin: "8px 0 0 0",
              paddingLeft: "20px",
              fontSize: "13px",
            }}
          >
            <li>Click "Register Piece for Updates" button below</li>
            <li>
              Start the background-piece-service:{" "}
              <code>
                cd packages/background-piece-service && deno task start
              </code>
            </li>
            <li>Wait ~60 seconds for polling interval</li>
            <li>Look for [SERVER] entries in logs above</li>
          </ol>
        </div>

        <div style={{ marginTop: "15px" }}>
          <ct-updater $state={runCount} integration="folk-wisdom-test" />
        </div>
      </div>
    ),
    runCount,
    logs,
    // bgUpdater runs on server when background-piece-service polls this piece
    bgUpdater: bgUpdateHandler({ runCount, logs }),
  };
});
