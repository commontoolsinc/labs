import type { FabricValue } from "@/interface.ts";
import { BaseCodec } from "./BaseCodec.ts";
import type { DecomposingCodec } from "./interface.ts";

/**
 * Base class for a `DecomposingCodec`: one whose essential state is made of
 * fabric values, which the walker encodes in turn. One instance serves every
 * wire format.
 *
 * It adds nothing to {@link BaseCodec} but the `FabricValue` domain and its
 * own identity, and the identity is the point: `CodecRegistry` reads it to
 * know that a state coming out of here is more work rather than an answer.
 */
export abstract class BaseDecomposingCodec extends BaseCodec<FabricValue>
  implements DecomposingCodec {
  // This space intentionally left blank.
}
