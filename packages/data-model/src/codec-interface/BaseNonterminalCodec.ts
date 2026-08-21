import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "./BaseFabricCodec.ts";
import type { NonterminalCodec } from "./interface.ts";

/**
 * Base class for a `NonterminalCodec`: one whose essential state is made of
 * `FabricValue`s, which the walker encodes in turn. One instance serves every
 * wire format.
 *
 * It adds nothing to {@link BaseFabricCodec} but the `FabricValue` domain and
 * its own identity, and the identity is the point: `CodecRegistry` reads it to
 * know that a state coming out of here is more work rather than an answer.
 *
 * `State` is as {@link BaseFabricCodec} describes it, passed straight through,
 * and is bounded by `FabricValue` here for the same reason `Encoded` is fixed
 * to it: these are the states a walker will expand.
 */
export abstract class BaseNonterminalCodec<
  State extends FabricValue = FabricValue,
> extends BaseFabricCodec<FabricValue, State> implements NonterminalCodec {
  // This space intentionally left blank.
}
