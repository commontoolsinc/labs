import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for `FabricRegExp`. Encodes the essential state
 * `{ source, flags, flavor }` under the `RegExp@1` tag. Wire format:
 * `{ "/RegExp@1": { "flags": "<flags>", "flavor": "<flavor>", "source": "<source>" } }`.
 * Matches by `instanceof`.
 */
export class RegExpHandler extends BaseFabricCodec {
  constructor() {
    super(WIRE_TYPE_TAGS.RegExp, FabricRegExp);
  }

  /** @inheritDoc */
  encode(value: FabricRegExp): FabricValue {
    return {
      source: value.source,
      flags: value.flags,
      flavor: value.flavor,
    };
  }

  /** @inheritDoc */
  decode(
    wireTypeTag: string,
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      return new ProblematicValue(
        wireTypeTag,
        state,
        `RegExp: expected object state, got ${typeof state}`,
      );
    }
    const s = state as Record<string, unknown>;
    const flavor = (s.flavor as string) ?? "es2025";
    const source = (s.source as string) ?? "";
    const flags = (s.flags as string) ?? "";
    try {
      return new FabricRegExp(flavor, source, flags);
    } catch (e) {
      return new ProblematicValue(
        wireTypeTag,
        state,
        `RegExp: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
