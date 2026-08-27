import { toCompactDebugString } from "@commonfabric/data-model/value-debug";

import { type IPCRemotePost, NotificationType } from "@/protocol/mod.ts";
import { describeFailure } from "@/shared/utils.ts";

/**
 * How much of an undeliverable message to render. Enough to recognize which
 * message it was, short enough that a hostile payload cannot flood the
 * channel it is being reported on.
 */
const MAX_UNDELIVERABLE_RENDER = 512;

/**
 * Posts one message from the worker to its client, reporting whether what was
 * asked for is what went. This is the whole of the worker's outbound side:
 * every response, error, and notification crosses here.
 *
 * `false` says a substitute went instead, the post having been refused. A
 * caller that records what it answered needs to know which, so that a failure
 * is not counted as the reply it replaced.
 */
export function postToClient(message: IPCRemotePost): boolean {
  try {
    // Read off `self` at call time rather than captured at module load, so
    // that a test driving this without a real worker can substitute its own.
    self.postMessage(message);
    return true;
  } catch (error) {
    // Defense in depth. `postMessage` refuses part of the value domain the
    // protocol types admit -- an interned `symbol` is a `FabricValue` and is
    // not structured-cloneable, nested or not -- and the notification paths
    // reach here from a `queueMicrotask` callback, outside any caller's
    // `try`. A throw there is an uncaught error rather than something that
    // becomes an error reply, so losing one message loudly beats taking the
    // worker's dispatch with it.
    self.postMessage(undeliverableMessageFrom(message, error));
    return false;
  }
}

/**
 * Builds what stands in for a message that could not be posted.
 *
 * A reply is answered as a failure rather than dropped: the client is awaiting
 * one, and dropping it would hang that request until it times out. A
 * notification has nobody waiting, so it becomes an error report carrying a
 * rendering of what could not be sent -- degraded rather than silent, which
 * matters most for the console, whose whole job is to say what happened.
 *
 * What this returns is built from strings and numbers alone, which
 * `postMessage` cannot refuse, so the caller posts it without a guard.
 */
function undeliverableMessageFrom(
  message: IPCRemotePost,
  error: unknown,
): IPCRemotePost {
  const reason = `Undeliverable message: ${describeFailure(error)}: ${
    toCompactDebugString(message, MAX_UNDELIVERABLE_RENDER)
  }`;
  const msgId = (message as { msgId?: unknown }).msgId;

  return typeof msgId === "number"
    ? { msgId, error: reason }
    : { type: NotificationType.ErrorReport, message: reason };
}
