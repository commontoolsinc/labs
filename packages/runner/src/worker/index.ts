/**
 * Worker module for running Runtime in a web worker.
 *
 * This module provides:
 * - RuntimeWorker: Main-thread controller for worker-based Runtime
 * - CellProxy: Cell interface that delegates to worker
 * - IPC protocol types for communication
 *
 * Usage:
 * ```typescript
 * import { RuntimeWorker } from "@commontools/runner/worker";
 *
 * const worker = new RuntimeWorker({
 *   apiUrl: new URL("https://api.example.com"),
 *   identity: myIdentity,
 *   spaceDid: "did:...",
 * });
 *
 * await worker.ready();
 *
 * // Get a cell proxy
 * const cellProxy = worker.getCellFromLink(someSigilLink);
 *
 * // Sync to fetch value from worker
 * await cellProxy.sync();
 *
 * // Use reactively with effect()
 * cellProxy.sink((value) => console.log("Value:", value));
 *
 * // Clean up
 * await worker.dispose();
 * ```
 */

export {
  RuntimeWorker,
  type RuntimeWorkerConsoleDetail,
  type RuntimeWorkerConsoleEvent,
  type RuntimeWorkerErrorDetail,
  type RuntimeWorkerErrorEvent,
  type RuntimeWorkerEventMap,
  type RuntimeWorkerNavigateDetail,
  type RuntimeWorkerNavigateEvent,
  type RuntimeWorkerOptions,
  RuntimeWorkerState,
} from "./runtime-worker.ts";

export { CELL_MARKER, isRemoteCell, RemoteCell } from "./cell-handle.ts";

export {
  type CellRef,
  type CellUpdateNotification,
  type CharmInfo,
  type InitializationData,
  isCellUpdateNotification,
  isReadyResponse,
  isWorkerIPCRequest,
  isWorkerIPCResponse,
  RuntimeWorkerMessageType,
  type WorkerIPCMessage,
  type WorkerIPCRequest,
  type WorkerIPCResponse,
} from "./ipc-protocol.ts";
