/**
 * Authentication for Collaborative Editing
 *
 * Uses the same identity system as memory storage.
 * Clients sign a simple payload proving they have access to the room.
 */

import { VerifierIdentity } from "@commontools/identity";

/**
 * Payload that clients sign to authenticate
 */
export interface CollabAuthPayload {
  /** Room ID (typically Cell entity ID) */
  roomId: string;
  /** Timestamp when token was created (Unix ms) */
  timestamp: number;
  /** User's DID */
  userDid: string;
}

/**
 * Auth token passed in WebSocket URL
 */
export interface CollabAuthToken {
  payload: string; // Base64 encoded JSON
  signature: string; // Base64 encoded signature
  did: string; // User's DID for verification
}

/**
 * Result of verifying an auth token
 */
export interface CollabAuthResult {
  ok?: {
    userDid: string;
    roomId: string;
  };
  error?: {
    message: string;
    code: "INVALID_PAYLOAD" | "INVALID_SIGNATURE" | "EXPIRED" | "ROOM_MISMATCH";
  };
}

/** Token validity period (5 minutes) */
const TOKEN_VALIDITY_MS = 5 * 60 * 1000;

/**
 * Parse and verify a collab auth token
 *
 * @param token - The auth token from URL params
 * @param expectedRoomId - The room ID from the URL path
 * @returns Verification result with user identity or error
 */
export async function verifyCollabAuth(
  token: CollabAuthToken,
  expectedRoomId: string,
): Promise<CollabAuthResult> {
  try {
    // Decode payload
    const payloadBytes = base64Decode(token.payload);
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const payload: CollabAuthPayload = JSON.parse(payloadStr);

    // Verify payload structure
    if (!payload.roomId || !payload.timestamp || !payload.userDid) {
      return {
        error: { message: "Invalid payload structure", code: "INVALID_PAYLOAD" },
      };
    }

    // Verify room ID matches
    if (payload.roomId !== expectedRoomId) {
      return {
        error: {
          message: "Room ID mismatch",
          code: "ROOM_MISMATCH",
        },
      };
    }

    // Verify DID matches
    if (payload.userDid !== token.did) {
      return {
        error: { message: "DID mismatch", code: "INVALID_PAYLOAD" },
      };
    }

    // Verify timestamp (not expired)
    const now = Date.now();
    if (now - payload.timestamp > TOKEN_VALIDITY_MS) {
      return {
        error: { message: "Token expired", code: "EXPIRED" },
      };
    }

    // Verify signature
    const verifier = await VerifierIdentity.fromDid(token.did as `did:key:${string}`);
    const signatureBytes = base64Decode(token.signature);

    const result = await verifier.verify({
      payload: payloadBytes,
      signature: signatureBytes,
    });

    if (result.error) {
      return {
        error: { message: "Invalid signature", code: "INVALID_SIGNATURE" },
      };
    }

    // Success!
    return {
      ok: {
        userDid: payload.userDid,
        roomId: payload.roomId,
      },
    };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : "Unknown error",
        code: "INVALID_PAYLOAD",
      },
    };
  }
}

/**
 * Extract auth token from URL query params
 */
export function extractAuthToken(
  url: URL,
): CollabAuthToken | null {
  const payload = url.searchParams.get("payload");
  const signature = url.searchParams.get("sig");
  const did = url.searchParams.get("did");

  if (!payload || !signature || !did) {
    return null;
  }

  return { payload, signature, did };
}

// Base64 helpers (URL-safe)
function base64Decode(str: string): Uint8Array {
  // Handle URL-safe base64
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
