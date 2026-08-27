import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
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
 * every response, error, and notification crosses here, and is encoded here.
 *
 * `false` says a substitute went instead, the encoding having refused the
 * message. A caller that records what it answered needs to know which, so that
 * a failure is not counted as the reply it replaced.
 *
 * The message is encoded whole rather than field by field, which is what lets
 * a payload carry the entire `FabricValue` domain -- a `bigint` as itself, a
 * `FabricBytes` as bytes, an instance with its class -- where structured clone
 * alone would strip an instance to `{}`. The envelope is a record of fabric
 * values and so is a `FabricValue` itself, which is what makes encoding it
 * whole well-defined.
 *
 * No `LiveEnvironment` is given, so a value that asks for a cell throws here.
 * Nothing should: `convertCellsToLinks()` turns every live cell into a link
 * before a payload reaches this point, and a throw would say that something
 * does not.
 */
export function postToClient(message: IPCRemotePost): boolean {
  let encoded;
  let delivered = true;

  try {
    encoded = realmFromFabricValue(message);
  } catch (error) {
    // Defense in depth, and the mirror of the two decodes: a value can pass
    // every `FabricValue` check and still have no encoding -- an object forged
    // onto a `FabricPrimitive`'s prototype is one -- and this is the only
    // place a worker speaks. A throw here reaches whatever called it, which
    // for a console notification is a synchronous `EventTarget` listener,
    // where it becomes an uncaught error and takes the process down.
    encoded = realmFromFabricValue(undeliverableMessageFrom(message, error));
    delivered = false;
  }

  // Read off `self` at call time rather than captured at module load, so that
  // a test driving this without a real worker can substitute its own.
  self.postMessage(encoded);

  return delivered;
}

/**
 * Builds what stands in for a message the encoding refused.
 *
 * A reply is answered as a failure rather than dropped: the client is awaiting
 * one, and dropping it would hang that request until it times out. A
 * notification has nobody waiting, so it becomes an error report carrying a
 * rendering of what could not be sent -- degraded rather than silent, which
 * matters most for the console, whose whole job is to say what happened.
 *
 * What this returns is built from strings and numbers alone, which the
 * encoding cannot refuse, so the caller encodes it without a guard.
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
