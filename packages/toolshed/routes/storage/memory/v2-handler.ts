/**
 * v2 WebSocket Handler
 *
 * Handles WebSocket connections for the v2 memory protocol.
 * Each connection gets its own ProviderSession backed by a shared SpaceV2.
 */
import type { Context } from "@hono/hono";
import { ProviderSession } from "@commontools/memory/v2/provider";
import type {
  Command,
  InvocationId,
  ProviderMessage,
} from "@commontools/memory/v2/protocol";
import { SpaceV2Manager } from "./v2-spaces.ts";
import env from "@/env.ts";

// Lazily initialized space manager
let spaceManager: SpaceV2Manager | null = null;

function getSpaceManager(): SpaceV2Manager {
  if (!spaceManager) {
    const memoryDir = new URL(env.MEMORY_DIR).pathname;
    spaceManager = new SpaceV2Manager(memoryDir);
  }
  return spaceManager;
}

/** Wire format for client commands */
interface WireCommand {
  id: InvocationId;
  cmd: Command;
}

/**
 * Handle a v2 WebSocket connection.
 */
export function handleV2WebSocket(c: Context): Response {
  const spaceId = c.req.query("space");
  if (!spaceId) {
    return c.json({ error: "Missing ?space= query parameter" }, 400);
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

  const manager = getSpaceManager();
  const space = manager.getOrCreate(spaceId);
  const session = new ProviderSession(space);

  // Register effect listener to push subscription updates
  const cleanupEffects = session.onEffect((msg: ProviderMessage) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  });

  socket.onmessage = (event: MessageEvent) => {
    try {
      const wire = JSON.parse(event.data as string) as WireCommand;
      const result = session.invoke(wire.id, wire.cmd);
      socket.send(JSON.stringify(result));
    } catch (err) {
      const error = err as Error;
      socket.send(JSON.stringify({
        the: "task/return",
        of: "job:error",
        is: { error: { name: "TransactionError", message: error.message } },
      }));
    }
  };

  socket.onclose = () => {
    cleanupEffects();
    session.close();
  };

  socket.onerror = () => {
    cleanupEffects();
    session.close();
  };

  return response;
}
