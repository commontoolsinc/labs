import type { Constructor } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { ReconstructionContext } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { ProblematicValue } from "./ProblematicValue.ts";

/**
 * Codec for registry-interned symbols, for any format whose encoded type
 * admits a `string`. Encodes the registry key; decodes with `Symbol.for()`.
 *
 * It is generic over the encoded type and lives beside the shared machinery
 * because nothing about it is any one format's business. A symbol's portable
 * content is its registry key, which is a string in every format that has
 * strings, so both the encoding and its refusals are the same wherever it is
 * registered.
 *
 * **What crosses is internedness**, and that is the whole of the promise: a
 * decoded symbol is interned under the key the encoded one was interned under,
 * which is as interned as a symbol on the far side can be. Whether it is the
 * *same* symbol is a fact about how the two sides are related rather than
 * about this codec: `Symbol.for()` reaches one registry per agent, so two
 * realms sharing an agent agree and a dedicated worker does not, and neither
 * arrangement is something an encoding can promise.
 *
 * Unique symbols (`Symbol(desc)`, where `Symbol.keyFor()` returns `undefined`)
 * have no portable representation -- there is no key to carry -- so
 * `canEncode()` returns `false` for them, which routes them to the registry's
 * "unhandled value" path instead of coercing one into a registry symbol
 * wearing its description.
 *
 * `Symbol` is a non-`new`-able pseudo-constructor, so it is cast to
 * `Constructor` (a "white lie") to seed the class fast-path; `canEncode()`
 * confirms via `typeof`.
 */
export class SymbolCodec<
  Encoded extends (string extends Encoded ? unknown : never),
> extends BaseTerminalCodec<Encoded> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.Symbol, Symbol as unknown as Constructor);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
  }

  /**
   * @inheritDoc
   *
   * The cast is unavoidable but not unguarded. TypeScript will not prove a
   * `string` assignable to a bare type parameter inside a body, whatever the
   * parameter is constrained to; what the constraint on the class does instead
   * is make the cast safe by construction, since no caller can instantiate
   * this at an `Encoded` that a registry key would not fit.
   */
  encode(value: symbol): Encoded {
    // `canEncode()` already verified the symbol has a registry key.
    return Symbol.keyFor(value)! as Encoded;
  }

  /** @inheritDoc */
  decode(
    typeTag: string,
    state: Encoded,
    _context: ReconstructionContext,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        typeTag,
        state,
        `Symbol: expected string state, got ${typeof state}`,
      );
    }

    return Symbol.for(state);
  }
}
