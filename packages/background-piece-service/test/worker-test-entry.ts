import { installDisconnectedWebSocket } from "./disconnected-websocket.ts";

installDisconnectedWebSocket();
await import("../src/worker.ts");
