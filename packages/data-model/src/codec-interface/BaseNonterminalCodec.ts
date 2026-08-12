import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/codec-interface/BaseFabricCodec.ts";
import type { NonterminalCodec } from "@/codec-interface/interface.ts";

/**
 * Base class for a `NonterminalCodec`: one whose essential state is made of
 * fabric values, which the walker encodes in turn. One instance serves every
 * wire format.
 *
 * It adds nothing to {@link BaseFabricCodec} but the `FabricValue` domain and
 * its own identity, and the identity is the point: `CodecRegistry` reads it to
 * know that a state coming out of here is more work rather than an answer.
 */
export abstract class BaseNonterminalCodec extends BaseFabricCodec<FabricValue>
  implements NonterminalCodec {
  // This space intentionally left blank.
}
