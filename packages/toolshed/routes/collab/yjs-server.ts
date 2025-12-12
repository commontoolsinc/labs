/**
 * Yjs WebSocket Server for Collaborative Editing
 *
 * This module implements a Deno-native Yjs sync server using y-protocols.
 * It manages Y.Doc instances per room and handles the Yjs sync protocol.
 *
 * Key concepts:
 * - Room: A collaborative document identified by a room ID (typically Cell entity ID)
 * - Y.Doc: The Yjs document that holds collaborative state
 * - Awareness: Protocol for sharing cursor positions and user presence
 */

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import * as syncProtocol from "y-protocols/sync.js";
import * as encoding from "lib0/encoding.js";
import * as decoding from "lib0/decoding.js";

// Message types from y-websocket protocol
const messageSync = 0;
const messageAwareness = 1;

/**
 * Room represents a collaborative document with connected clients
 */
interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
}

// Store all active rooms
const rooms = new Map<string, Room>();

/**
 * Get or create a room for the given room ID
 */
export function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);

    // Clean up awareness state when all clients disconnect
    awareness.on("update", ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }, _origin: unknown) => {
      const changedClients = added.concat(updated).concat(removed);
      const room = rooms.get(roomId);
      if (room && room.clients.size > 0) {
        // Broadcast awareness changes to all clients
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
        );
        const message = encoding.toUint8Array(encoder);
        broadcastToRoom(room, message);
      }
    });

    room = { doc, awareness, clients: new Set() };
    rooms.set(roomId, room);
    console.log(`[collab] Created room: ${roomId}`);
  }
  return room;
}

/**
 * Broadcast a message to all clients in a room
 */
function broadcastToRoom(
  room: Room,
  message: Uint8Array,
  excludeSocket?: WebSocket,
) {
  for (const client of room.clients) {
    if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Handle a new WebSocket connection to a room
 */
export function handleConnection(socket: WebSocket, roomId: string): void {
  const room = getOrCreateRoom(roomId);
  room.clients.add(socket);
  console.log(
    `[collab] Client connected to room ${roomId}. Total clients: ${room.clients.size}`,
  );

  // Send sync step 1 (state vector) to the new client
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  socket.send(encoding.toUint8Array(encoder));

  // Send awareness state to the new client
  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, messageAwareness);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(awarenessStates.keys()),
      ),
    );
    socket.send(encoding.toUint8Array(awarenessEncoder));
  }

  // Listen for document updates and broadcast to all clients
  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin !== socket) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      broadcastToRoom(room, message);
    }
  };
  room.doc.on("update", updateHandler);

  // Handle incoming messages
  socket.onmessage = (event: MessageEvent) => {
    try {
      const data = event.data;
      let message: Uint8Array;

      if (data instanceof ArrayBuffer) {
        message = new Uint8Array(data);
      } else if (data instanceof Uint8Array) {
        message = data;
      } else if (data instanceof Blob) {
        // Handle Blob asynchronously
        data.arrayBuffer().then((buffer) => {
          handleMessage(new Uint8Array(buffer), socket, room);
        });
        return;
      } else {
        console.warn("[collab] Unexpected message type:", typeof data);
        return;
      }

      handleMessage(message, socket, room);
    } catch (error) {
      console.error("[collab] Error handling message:", error);
    }
  };

  socket.onclose = () => {
    room.clients.delete(socket);
    room.doc.off("update", updateHandler);

    // Remove awareness state for this client
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [room.doc.clientID],
      "connection closed",
    );

    console.log(
      `[collab] Client disconnected from room ${roomId}. Remaining clients: ${room.clients.size}`,
    );

    // Clean up empty rooms after a delay
    if (room.clients.size === 0) {
      setTimeout(() => {
        const currentRoom = rooms.get(roomId);
        if (currentRoom && currentRoom.clients.size === 0) {
          rooms.delete(roomId);
          console.log(`[collab] Cleaned up empty room: ${roomId}`);
        }
      }, 30000); // 30 second delay before cleanup
    }
  };

  socket.onerror = (error) => {
    console.error(`[collab] WebSocket error in room ${roomId}:`, error);
  };
}

/**
 * Handle an incoming message from a client
 */
function handleMessage(
  message: Uint8Array,
  socket: WebSocket,
  room: Room,
): void {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case messageSync: {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);

      const syncMessageType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        room.doc,
        socket,
      );

      // If we have a response (sync step 2), send it back
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }

      // If this was an update, broadcast to other clients
      if (syncMessageType === syncProtocol.messageYjsUpdate) {
        // The update was already applied to the doc, which triggers
        // the 'update' event handler that broadcasts to others
      }
      break;
    }

    case messageAwareness: {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socket);
      // Awareness updates are broadcast via the awareness 'update' event handler
      break;
    }

    default:
      console.warn("[collab] Unknown message type:", messageType);
  }
}

/**
 * Initialize a room with content (for server-side initialization from Cell)
 *
 * @param roomId - The room identifier
 * @param content - The initial content (plain text or HTML)
 * @param type - Content type: "codemirror" for code editor, "prosemirror" for rich text
 */
export function initializeRoomContent(
  roomId: string,
  content: string,
  type: "codemirror" | "prosemirror" = "codemirror",
): void {
  const room = getOrCreateRoom(roomId);

  if (type === "codemirror") {
    // For ct-code-editor - plain text in Y.Text
    const ytext = room.doc.getText("codemirror");
    if (ytext.length === 0 && content) {
      ytext.insert(0, content);
      console.log(`[collab] Initialized room ${roomId} with codemirror content (${content.length} chars)`);
    }
  } else if (type === "prosemirror") {
    // For ct-richtext-editor - TipTap/ProseMirror uses Y.XmlFragment
    // TipTap's Collaboration extension creates the fragment automatically
    // We just need to ensure the room exists; TipTap will handle initialization
    // via the first client's content if the fragment is empty
    console.log(`[collab] Room ${roomId} ready for prosemirror content`);
  }
}

/**
 * Get the current content from a room
 */
export function getRoomContent(
  roomId: string,
  type: "codemirror" | "prosemirror" = "codemirror",
): string | null {
  const room = rooms.get(roomId);
  if (!room) return null;

  if (type === "codemirror") {
    return room.doc.getText("codemirror").toString();
  } else {
    // ProseMirror/TipTap content is in XmlFragment - would need serialization
    // For now, return null as the client manages this
    return null;
  }
}

/**
 * Get statistics about active rooms
 */
export function getStats(): { rooms: number; totalClients: number } {
  let totalClients = 0;
  for (const room of rooms.values()) {
    totalClients += room.clients.size;
  }
  return { rooms: rooms.size, totalClients };
}
