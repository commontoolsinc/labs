import { BaseFabricCodec } from "./BaseFabricCodec.ts";
import type { TerminalCodec } from "./interface.ts";

/**
 * Base class for a `TerminalCodec`: one whose essential state is already in
 * the domain of the wire format `Encoded`, so the walker passes it through
 * untouched. An instance belongs to that format alone.
 *
 * It adds nothing to {@link BaseFabricCodec} but its own identity, and the identity
 * is the point: `CodecRegistry` reads it to know that a state coming out of
 * here is the answer rather than more work.
 */
export abstract class BaseTerminalCodec<Encoded>
  extends BaseFabricCodec<Encoded>
  implements TerminalCodec<Encoded> {
  // This space intentionally left blank.
}
