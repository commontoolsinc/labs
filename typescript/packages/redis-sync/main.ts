// server.ts
//
// To run this server with Deno, use a command like:
//   deno run --allow-net --allow-env server.ts
//
// Make sure you have a Redis server running (default on 127.0.0.1:6379).

import { connect } from "@db/redis";

// A set of connected WebSocket clients.
const clients = new Set<WebSocket>();

// Redis key prefix and pub/sub channel name.
const STORAGE_KEY_PREFIX = "storage:";
const PUBSUB_CHANNEL = "storage_channel";

// Create a Redis connection for normal commands.
const redis = await connect({
  hostname: "127.0.0.1",
  port: 6379,
});

// Create a second Redis connection for subscribing.
const redisSubscriber = await connect({
  hostname: "127.0.0.1",
  port: 6379,
});

/**
 * Handle messages coming from a connected WebSocket client.
 *
 * Expected incoming messages are JSON objects with at least:
 *
 * - type: "send" | "sync"
 * - entityId: an object (or value) that identifies the storage cell.
 * - For "send" messages, also a "value" property (of shape { value: any, source?: any }).
 */
async function handleClient(ws: WebSocket): Promise<void> {
  clients.add(ws);
  console.log("New WebSocket client connected. Total clients:", clients.size);

  // Listen for messages.
  ws.addEventListener("message", async (event) => {
    if (typeof event.data === "string") {
      try {
        const data = JSON.parse(event.data);
        await handleMessage(ws, data);
      } catch (err) {
        console.error("Error parsing client message:", err);
      }
    }
    // (You can ignore binary messages or handle them as needed.)
  });

  // Listen for close events.
  ws.addEventListener("close", () => {
    clients.delete(ws);
    console.log("WebSocket client disconnected. Total clients:", clients.size);
  });

  // Optionally, handle error events.
  ws.addEventListener("error", (err) => {
    console.error("WebSocket error:", err);
  });
}

/**
 * Process a message from a client.
 */
async function handleMessage(ws: WebSocket, data: any): Promise<void> {
  const type = data.type;
  const entityId = data.entityId;
  // Use the JSON string of the entityId as part of the Redis key.
  const key = STORAGE_KEY_PREFIX + JSON.stringify(entityId);

  if (type === "send") {
    // Client is sending an update.
    const value = data.value;
    const valueString = JSON.stringify(value);
    // Save the value in Redis.
    await redis.set(key, valueString);
    console.log("Received send for", key, valueString);
    // Publish an "update" message on the pub/sub channel.
    const updateMessage = JSON.stringify({
      type: "update",
      entityId,
      value,
    });
    await redis.publish(PUBSUB_CHANNEL, updateMessage);
  } else if (type === "sync") {
    console.log("Received sync request for", key);
    const stored = await redis.get(key);
    // Instead of setting responseValue to null, set it to undefined.
    const responseValue = stored !== null ? JSON.parse(stored) : undefined;
    const syncResponse = {
      type: "syncResponse",
      entityId,
      value: responseValue,
    };
    ws.send(JSON.stringify(syncResponse));
  } else {
    console.warn("Unknown message type:", type);
  }
}

/**
 * Broadcast a message string to all connected WebSocket clients.
 */
function broadcast(message: string): void {
  for (const client of clients) {
    try {
      client.send(message);
    } catch (err) {
      console.error("Error broadcasting to client:", err);
    }
  }
}

/**
 * Listen to the Redis pub/sub channel and broadcast any messages to clients.
 */
async function listenToRedisPubSub() {
  const sub = await redisSubscriber.subscribe(PUBSUB_CHANNEL);
  console.log("Subscribed to Redis channel:", PUBSUB_CHANNEL);
  // Iterate over messages received from Redis.
  for await (const { channel, message } of sub.receive()) {
    // For every published message, broadcast to all connected clients.
    console.log(`Received pub/sub message on ${channel}:`, message);
    broadcast(message);
  }
}

// Start the Redis pub/sub listener in the background.
listenToRedisPubSub();

// Start an HTTP server that upgrades connections to WebSockets using Deno.serve.
const port = 8080;
console.log(`WebSocket server is running on :${port}`);

Deno.serve({ port }, (req) => {
  // Ensure the client is requesting an upgrade to WebSocket.
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response(null, { status: 501 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  handleClient(socket);
  return response;
});
