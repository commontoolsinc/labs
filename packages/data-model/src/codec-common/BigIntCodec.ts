import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
} from "@commonfabric/utils/bigint";
import type { Constructor } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for `bigint`. Encodes to the `BigInt@1` tag with an unpadded base64
 * string encoding the bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/BigInt@1": "<base64>" }`.
 *
 * The byte encoding is the same one used by the hash (Section 3.7 of the
 * byte-level spec): minimal two's-complement big-endian, with sign extension
 * as needed.
 *
 * `BigInt` is a non-`new`-able pseudo-constructor, so the class fast path uses
 * a local type that carries both its callable shape and the constructor slot
 * the registry uses for lookup.
 */
type BigIntPseudoConstructor = typeof BigInt & Constructor;
const BIGINT_PSEUDO_CONSTRUCTOR = BigInt as BigIntPseudoConstructor;

export class BigIntCodec extends BaseFabricCodec {
  constructor() {
    super(CODEC_TYPE_TAGS.BigInt, BIGINT_PSEUDO_CONSTRUCTOR);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "bigint";
  }

  /** @inheritDoc */
  encode(value: bigint): FabricValue {
    return toUnpaddedBase64url(bigintToMinimalTwosComplement(value));
  }

  /** @inheritDoc */
  decode(
    typeTag: string,
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        typeTag,
        state,
        `bigint: expected string state, got ${typeof state}`,
      );
    }
    try {
      return bigintFromMinimalTwosComplement(fromBase64url(state));
    } catch {
      return new ProblematicValue(
        typeTag,
        state,
        `bigint: invalid base64: ${state}`,
      );
    }
  }
}
