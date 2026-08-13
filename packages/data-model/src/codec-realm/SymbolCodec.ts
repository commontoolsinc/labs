import type { Constructor } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { ReconstructionContext } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import type { RealmCodecValue } from "./interface.ts";

/**
 * Codec for registry-interned symbols. Encodes the registry key as a string,
 * and decodes with `Symbol.for()`.
 *
 * This format carries `bigint`, `undefined` and the special numbers as
 * themselves, so a symbol is the one JavaScript primitive it has to encode at
 * all: structured cloning refuses one outright, interned or not.
 *
 * Unique symbols (`Symbol(desc)`, where `Symbol.keyFor()` returns `undefined`)
 * have no portable representation; `canEncode()` returns `false` for them,
 * which routes them to the registry's "unhandled value" path rather than
 * silently coercing one to a registry symbol.
 *
 * `Symbol` is a non-`new`-able pseudo-constructor, so it is cast to
 * `Constructor` (a "white lie") to seed the class fast-path; `canEncode()`
 * confirms via `typeof`.
 *
 * TODO(danfuzz): Settle what the far side is promised. `Symbol.for()`
 * reconstructs the identical symbol only where the two sides share a global
 * symbol registry, and a decode landing in a realm with a registry of its own
 * produces a distinct symbol with the same key. JSON never faces this, its
 * decode happening wherever it happens with no claim about identity.
 */
export class SymbolCodec extends BaseTerminalCodec<RealmCodecValue> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.Symbol, Symbol as unknown as Constructor);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
  }

  /** @inheritDoc */
  encode(value: symbol): RealmCodecValue {
    // `canEncode()` already verified the symbol has a registry key.
    return Symbol.keyFor(value)!;
  }

  /**
   * @inheritDoc
   *
   * Reports a bad state by throwing rather than by returning a
   * `ProblematicValue`. The two are equivalent to a caller -- the engine
   * settles them against `lenient` -- so the choice is only about what can be
   * expressed, and a `ProblematicValue` holds a `FabricValue` where this
   * format's states need not be one.
   */
  decode(
    typeTag: string,
    state: RealmCodecValue,
    _context: ReconstructionContext,
  ): FabricValue {
    if (typeof state !== "string") {
      throw new Error(
        `\`${typeTag}\`: expected string state, got ${typeof state}`,
      );
    }

    return Symbol.for(state);
  }
}
