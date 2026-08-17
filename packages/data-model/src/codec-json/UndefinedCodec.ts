import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "./interface.ts";
import type { DecodeContext } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";

/**
 * Codec for `undefined`. Encodes to the `Undefined@1` tag with `null` state.
 * `undefined` has no corresponding class, so there is no `uniqueHandledClass`;
 * matching is by `canEncode()`. See Section 1.4.1 of the formal spec.
 */
export class UndefinedCodec extends BaseTerminalCodec<JsonCodecValue> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.Undefined, undefined);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return value === undefined;
  }

  /** @inheritDoc */
  encode(_value: FabricValue): JsonCodecValue {
    return null;
  }

  /** @inheritDoc */
  decode(
    typeTag: string,
    state: JsonCodecValue,
    _context: DecodeContext,
  ): FabricValue {
    if (state !== null) {
      throw new Error(
        `\`${typeTag}\`: expected \`null\` state, got \`${typeof state}\``,
      );
    }
    return undefined;
  }
}
