import { installDisconnectedWebSocket } from "./disconnected-websocket.ts";

installDisconnectedWebSocket();
// The disconnected WebSocket has to be installed before the worker module opens
// a connection as it loads.
// deno-lint-ignore cf-imports/no-inline-module-import
await import("../src/worker.ts");
