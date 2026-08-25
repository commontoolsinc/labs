import type { IPCRemotePost } from "@/protocol/mod.ts";

/**
 * Posts one message from the worker to its client. This is the whole of the
 * worker's outbound side: every response, error, and notification crosses
 * here.
 */
export function postToClient(message: IPCRemotePost): void {
  // Read off `self` at call time rather than captured at module load, so that
  // a test driving this without a real worker can substitute its own.
  self.postMessage(message);
}
