import { realmFromFabricValue } from "@commonfabric/data-model/codecs";

import type { IPCRemotePost } from "@/protocol/mod.ts";

/**
 * Posts one message from the worker to its client. This is the whole of the
 * worker's outbound side: every response, error, and notification crosses
 * here, and is encoded here.
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
export function postToClient(message: IPCRemotePost): void {
  // Read off `self` at call time rather than captured at module load, so that
  // a test driving this without a real worker can substitute its own.
  self.postMessage(realmFromFabricValue(message));
}
