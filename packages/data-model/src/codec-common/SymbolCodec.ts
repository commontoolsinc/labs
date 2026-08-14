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
 * A format supplies `keyAsEncoded` rather than this class casting a `string`
 * into `Encoded`. That is the one step a type parameter cannot justify from
 * inside -- TypeScript will not prove a `string` assignable to a bare
 * parameter, and no `extends` clause can even exclude the parameter being
 * `never`, `never` being assignable to everything. Handed in from the outside
 * it is checked where it is provable, and a format with no `string` arm cannot
 * supply it.
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
export class SymbolCodec<Encoded> extends BaseTerminalCodec<Encoded> {
  /** The value of {@link #keyAsEncoded}, supplied by the registering format. */
  readonly #keyAsEncoded: (key: string) => Encoded & string;

  /**
   * Constructs an instance.
   *
   * @param keyAsEncoded - How this format holds a registry key. A format that
   *   has a `string` arm writes `(key) => key`; one that has none cannot write
   *   this at all, which is the point.
   *
   *   The result is `Encoded & string` rather than `Encoded`, so that what is
   *   handed back is still a string. `decode()` accepts only a string, and a
   *   format free to wrap the key in something its union also admits could
   *   emit state its own decoder refuses.
   */
  constructor(keyAsEncoded: (key: string) => Encoded & string) {
    super(CODEC_TYPE_TAGS.Symbol, Symbol as unknown as Constructor);

    this.#keyAsEncoded = keyAsEncoded;
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
  }

  /** @inheritDoc */
  encode(value: symbol): Encoded {
    // `canEncode()` already verified the symbol has a registry key.
    return this.#keyAsEncoded(Symbol.keyFor(value)!);
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
