/**
 * Collab Auth - Client-side auth token generation for collaborative editing
 *
 * Signs auth tokens that can be verified by the collab server.
 * Uses the same identity system as memory storage.
 */

import type { Cell } from "@commontools/runner";

/**
 * Payload that gets signed to authenticate
 */
interface CollabAuthPayload {
  roomId: string;
  timestamp: number;
  userDid: string;
}

/**
 * Auth token to pass in WebSocket URL
 */
export interface CollabAuthToken {
  payload: string; // Base64 encoded JSON
  signature: string; // Base64 encoded signature
  did: string; // User's DID
}

/**
 * Generate a signed auth token for collab WebSocket connection.
 *
 * @param cell - A Cell to get the Signer from
 * @param roomId - The room ID to authenticate for
 * @returns Auth token to include in WebSocket URL, or null if signing unavailable
 */
export async function createCollabAuthToken(
  cell: Cell<unknown>,
  roomId: string,
): Promise<CollabAuthToken | null> {
  try {
    // Access runtime through the Cell implementation
    // Note: This works even though it's not in the Cell interface type
    const runtime = (cell as unknown as { runtime: any }).runtime;
    if (!runtime?.storageManager?.as) {
      console.warn("[collab-auth] No signer available on cell runtime");
      return null;
    }

    const signer = runtime.storageManager.as;
    const userDid = signer.did();

    // Create payload
    const payload: CollabAuthPayload = {
      roomId,
      timestamp: Date.now(),
      userDid,
    };

    // Encode payload
    const payloadStr = JSON.stringify(payload);
    const payloadBytes = new TextEncoder().encode(payloadStr);

    // Sign payload
    const result = await signer.sign(payloadBytes);
    if (result.error) {
      console.warn("[collab-auth] Signing failed:", result.error);
      return null;
    }

    // Encode as base64 (URL-safe)
    const payloadB64 = base64Encode(payloadBytes);
    const signatureB64 = base64Encode(result.ok);

    return {
      payload: payloadB64,
      signature: signatureB64,
      did: userDid,
    };
  } catch (error) {
    console.warn("[collab-auth] Error creating auth token:", error);
    return null;
  }
}

/**
 * Append auth token to a WebSocket URL
 */
export function appendAuthToUrl(
  baseUrl: string,
  token: CollabAuthToken,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("payload", token.payload);
  url.searchParams.set("sig", token.signature);
  url.searchParams.set("did", token.did);
  return url.toString();
}

// Base64 helpers (URL-safe)
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // Convert to base64 and make URL-safe
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
