import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  attachOtelBridgeWhenInitialized,
  executeWorkerRequest,
  formatConsoleMessage,
  handleWorkerMessage,
  recordLatestError,
  resetWorkerStateForTesting,
  runPiece,
  safeFormat,
  setWorkerStateForTesting,
  throwUnhandledRejectionReason,
  workerConsoleContext,
} from "../src/worker.ts";
import { WorkerIPCMessageType } from "../src/worker-ipc.ts";
import { RuntimeTelemetry } from "@commonfabric/runner";

const TEST_DID = "did:key:z6Mktestspace";
const OTHER_DID = "did:key:z6Mkotherspace";
const PIECE_ID = `fid1:${"a".repeat(54)}`;

try {
  resetWorkerStateForTesting();

  // No provider is registered in this subprocess, which is the same state the
  // fail-open OTel initializer leaves after setup failure.
  const telemetry = new RuntimeTelemetry();
  assertEquals(
    attachOtelBridgeWhenInitialized(
      telemetry,
      TEST_DID as never,
      TEST_DID as never,
    ),
    null,
  );
  assertEquals(telemetry.detailedEventCommitTelemetryEnabled, false);

  assertEquals(workerConsoleContext(undefined), "Worker(NO_SPACE)");
  assertEquals(workerConsoleContext(TEST_DID as never), `Worker(${TEST_DID})`);
  assertThrows(
    () =>
      formatConsoleMessage(
        { metadata: undefined, args: [] } as never,
        undefined,
      ),
    Error,
    "FatalError: Piece executing but worker has no space ID.",
  );
  assertThrows(
    () =>
      formatConsoleMessage(
        { metadata: { space: OTHER_DID }, args: [] } as never,
        TEST_DID as never,
      ),
    Error,
    "FatalError: Mismatched space ids in worker.",
  );

  assertEquals(
    formatConsoleMessage(
      {
        metadata: { space: TEST_DID, pieceId: PIECE_ID },
        args: [{ rawIdentity: "secret" }],
      } as never,
      TEST_DID as never,
    ),
    [`Piece(${PIECE_ID})`, `{"rawIdentity":"<REDACTED>"}`],
  );
  assertEquals(
    formatConsoleMessage(
      { metadata: undefined, args: ["hello"] } as never,
      TEST_DID as never,
    ),
    ["Piece(NO_PIECE)", "hello"],
  );

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert(safeFormat(circular) === circular);
  assertEquals(safeFormat("plain"), "plain");
  setWorkerStateForTesting({
    latestError: new Error("remembered"),
    currentSession: {} as never,
    loadedPieces: [[PIECE_ID, { key: () => undefined } as never]],
  });
  assertThrows(
    () =>
      throwUnhandledRejectionReason({
        reason: new Error("rejected"),
      } as PromiseRejectionEvent),
    Error,
    "rejected",
  );

  const calls: string[] = [];
  const posts: unknown[] = [];
  const errors: unknown[][] = [];
  const handlers = {
    initialize: () => {
      calls.push("initialize");
      return Promise.resolve();
    },
    runPiece: () => {
      calls.push("run");
      return Promise.resolve();
    },
    cleanup: () => {
      calls.push("cleanup");
      return Promise.resolve();
    },
    postMessage: (message: unknown) => posts.push(message),
    error: (...args: unknown[]) => errors.push(args),
  };
  const identity = await Identity.generate({ implementation: "noble" });

  await handleWorkerMessage(
    {
      msgId: 1,
      type: WorkerIPCMessageType.Initialize,
      data: {
        did: identity.did(),
        toolshedUrl: "memory://worker-handler-test",
        rawIdentity: identity.serialize(),
      },
    },
    handlers,
  );
  await handleWorkerMessage(
    { msgId: 2, type: WorkerIPCMessageType.Run, data: { pieceId: PIECE_ID } },
    handlers,
  );
  await handleWorkerMessage(
    { msgId: 3, type: WorkerIPCMessageType.Cleanup },
    handlers,
  );
  await assertRejects(
    () =>
      executeWorkerRequest(
        { msgId: 4, type: "unknown" } as never,
        handlers,
      ),
    Error,
    "Unknown message type.",
  );
  await handleWorkerMessage({ msgId: 5, type: "unknown" }, handlers);
  await handleWorkerMessage(
    { msgId: 6, type: WorkerIPCMessageType.Cleanup },
    {
      ...handlers,
      cleanup: () => Promise.reject("string failure"),
    },
  );

  assertEquals(calls, ["initialize", "run", "cleanup"]);
  assertEquals(posts.slice(0, 3), [
    { msgId: 1 },
    { msgId: 2 },
    { msgId: 3 },
  ]);
  assertStringIncludes(
    String((posts.at(-1) as { error: unknown }).error),
    "string failure",
  );
  assertEquals(errors.length, 2);

  const pieceCell = { piece: true };
  const setRunState = (
    overrides: {
      activeEntry?: unknown;
      loadedPiece?: unknown;
      idle?: () => Promise<void>;
    } = {},
  ) => {
    const sends: unknown[] = [];
    const updater = {
      runtime: {
        edit: () => ({
          commit: () => sends.push("commit"),
        }),
      },
      withTx: (tx: unknown) => ({
        send: (value: unknown) => sends.push({ tx, value }),
      }),
    };
    const loadedPiece = "loadedPiece" in overrides ? overrides.loadedPiece : {
      key: (key: string) => key === "bgUpdater" ? updater : undefined,
    };
    let getCalls = 0;
    const manager = {
      runtime: {
        getCellFromEntityId: (space: string) => {
          assertEquals(space, TEST_DID);
          return pieceCell;
        },
      },
      getActivePiece: (cell: unknown) => {
        assertEquals(cell, pieceCell);
        return Promise.resolve(
          "activeEntry" in overrides ? overrides.activeEntry : { active: true },
        );
      },
      get: () => {
        getCalls++;
        return Promise.resolve(loadedPiece);
      },
    };
    setWorkerStateForTesting({
      initialized: true,
      spaceId: TEST_DID as never,
      manager: manager as never,
      runtime: {
        idle: overrides.idle ?? (() => Promise.resolve()),
      } as never,
      loadedPieces: [],
      streamValidator: ((value: unknown): value is never =>
        value === updater) as never,
    });
    return { getCalls: () => getCalls, sends };
  };

  let state = setRunState();
  await runPiece({ pieceId: PIECE_ID });
  await runPiece({ pieceId: PIECE_ID });
  assertEquals(state.getCalls(), 1);
  assertEquals(state.sends.length, 4);

  setWorkerStateForTesting({
    manager: {} as never,
    spaceId: undefined as never,
  });
  await assertRejects(
    () => runPiece({ pieceId: PIECE_ID }),
    Error,
    "Worker space not initialized",
  );

  setRunState({ activeEntry: undefined });
  await assertRejects(
    () => runPiece({ pieceId: PIECE_ID }),
    Error,
    `No pieces list entry found for piece: ${PIECE_ID}`,
  );

  setRunState({ loadedPiece: undefined });
  await assertRejects(
    () => runPiece({ pieceId: PIECE_ID }),
    Error,
    `Piece not found: ${PIECE_ID}`,
  );

  setRunState({ loadedPiece: { key: () => undefined } });
  await assertRejects(
    () => runPiece({ pieceId: PIECE_ID }),
    Error,
    `No updater stream found for piece: ${PIECE_ID}`,
  );

  state = setRunState({
    idle: () => {
      recordLatestError(
        Object.assign(new Error("runtime failed"), {
          space: TEST_DID,
          pieceId: PIECE_ID,
          patternId: "pattern",
        }) as never,
      );
      return Promise.resolve();
    },
  });
  await assertRejects(
    () => runPiece({ pieceId: PIECE_ID }),
    Error,
    `runtime failed @ ${TEST_DID}:${PIECE_ID} running pattern`,
  );
  assertEquals(state.sends.length, 2);
} finally {
  resetWorkerStateForTesting();
}
