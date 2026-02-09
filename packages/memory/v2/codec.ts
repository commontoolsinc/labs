/**
 * Memory v2 Wire Codec
 *
 * Serializes/deserializes v2 protocol messages for WebSocket transport.
 * Uses plain JSON since v2 types are already JSON-serializable.
 */

import type { Command, InvocationId, ProviderMessage } from "./protocol.ts";

/** Wire format for client-to-server messages. */
export interface WireCommand {
  id: InvocationId;
  cmd: Command;
}

/**
 * Encode a command for sending over the wire.
 */
export function encodeCommand(id: InvocationId, cmd: Command): string {
  const wire: WireCommand = { id, cmd };
  return JSON.stringify(wire);
}

/**
 * Decode a wire command received by the server.
 */
export function decodeCommand(json: string): WireCommand {
  return JSON.parse(json) as WireCommand;
}

/**
 * Encode a provider message (response/effect) for sending over the wire.
 */
export function encodeMessage(msg: ProviderMessage): string {
  return JSON.stringify(msg);
}

/**
 * Decode a provider message received by the client.
 */
export function decodeMessage(json: string): ProviderMessage {
  return JSON.parse(json) as ProviderMessage;
}
