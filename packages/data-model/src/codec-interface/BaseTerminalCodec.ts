import { BaseFabricCodec } from "@/codec-interface/BaseFabricCodec.ts";
import type { TerminalCodec } from "@/codec-interface/interface.ts";

/**
 * Base class for a `TerminalCodec`: one whose essential state is already in the
 * domain of the wire format `Encoded`, so the walker passes it through
 * untouched. An instance belongs to that format alone.
 *
 * It adds nothing to {@link BaseFabricCodec} but its own identity, and the
 * identity is the point: `CodecRegistry` reads it to know that a state coming
 * out of here is the answer rather than more work.
 *
 * `Encoded` must be a wire format's own value type, and never `FabricValue`.
 * Nothing enforces that. `TerminalCodec<FabricValue>` and `NonterminalCodec`
 * are the same type, so a subclass declared at `FabricValue` satisfies the
 * nonterminal half of every signature while classifying as terminal at run
 * time, and its state would reach the wire unexpanded. A codec whose state is
 * made of fabric values extends {@link BaseNonterminalCodec}.
 */
export abstract class BaseTerminalCodec<Encoded>
  extends BaseFabricCodec<Encoded>
  implements TerminalCodec<Encoded> {
  // This space intentionally left blank.
}
