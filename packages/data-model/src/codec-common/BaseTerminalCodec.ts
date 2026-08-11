import type { FabricValue } from "@/interface.ts";
import type { ReconstructionContext, TerminalCodec } from "./interface.ts";
import { BaseCodecDispatch } from "./BaseCodecDispatch.ts";

/**
 * Base class for `TerminalCodec` which provides commonly-needed functionality.
 * A subclass's state is already in the domain of the wire format `Encoded`, so
 * the instance belongs to that format alone.
 */
export abstract class BaseTerminalCodec<Encoded> extends BaseCodecDispatch
  implements TerminalCodec<Encoded> {
  /** @inheritDoc */
  abstract decode(
    typeTag: string,
    state: Encoded,
    context: ReconstructionContext,
  ): FabricValue;

  /** @inheritDoc */
  abstract encode(value: FabricValue): Encoded;
}
