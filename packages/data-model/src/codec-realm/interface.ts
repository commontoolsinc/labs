import type { WireFormat } from "@/codec-interface/interface.ts";
import { REALM_CODEC } from "@/codec-interface/interface.ts";

/**
 * The transport form of this format: a value that structured cloning carries
 * across a realm boundary without loss, and so what `RealmCodecEngine.encode()`
 * returns and `decode()` accepts.
 *
 * Unlike JSON's `JsonCodecValue`, this is not an intermediate tree awaiting a
 * further reduction to what actually crosses. Cloning takes this shape
 * directly, so the tree _is_ the wire, and the engine's `Encoded` and
 * `SerializedForm` are the same type.
 *
 * The union names what this format emits, which is narrower than everything
 * cloning accepts. Four arms are worth calling out:
 *
 * * `bigint` and `undefined` appear directly, as do `-0`, `NaN` and
 *   `±Infinity` under `number`. Cloning carries each as itself.
 * * `ArrayBuffer` appears, because bytes cross as bytes. This is the whole
 *   point of a second format: JSON has to represent a `FabricBytes` as
 *   base64url text, and a receiver that wants bytes back has to rebuild them.
 *   The two forms are not interchangeable. Bytes travel as a bare
 *   `ArrayBuffer` rather than as a view onto one, that being what
 *   `postMessage()` can *transfer*, so a caller assembling a transfer list
 *   finds the transferable object in the tree rather than having to reach
 *   through a view and reason about its offset. Both byte-carrying classes do
 *   this: a `FabricBytes` encodes to one directly, and a `FabricHash` to one
 *   beside its algorithm tag. A bare `Uint8Array` is therefore not a form this
 *   format emits, and `decodeValue()` refuses one.
 * * `RegExp` appears for the same reason, source and flags intact.
 * * `Map` is the tagged form (see {@link RealmTaggedValue}). An encoded value
 *   carries no envelope of its own: both ends of this format are the same
 *   engine from the same build, so there is nothing for a format tag to
 *   identify and no version for it to guard.
 *
 * `symbol` is absent: cloning refuses one outright, so this format registers
 * the shared `SymbolCodec` and a symbol crosses under a tag like any other
 * value a transport cannot carry directly.
 */
export type RealmCodecValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | ArrayBuffer
  | RegExp
  | readonly RealmCodecValue[]
  | RealmTaggedValue
  | { readonly [key: string]: RealmCodecValue };

/**
 * The tagged form: a single-entry `Map` binding a wire type tag to the encoded
 * state under it.
 *
 * A `Map` is what lets this format do without escaping entirely, where JSON
 * needs `/quote` and `/object` and a reserved-key rule to keep a tag apart
 * from user data. Two facts combine to make a tag unforgeable here. Cloning is
 * type-preserving, so a plain object arrives as a plain object and can never
 * present itself as a `Map`. And a native `Map` is not a `FabricValue`, so one
 * cannot appear in the payload being encoded to begin with. Every `Map` in an
 * encoded tree is therefore this engine's own work.
 *
 * The cost of the choice is that an encoded value is no longer inspectable
 * with JSON tooling, a `Map` having no literal syntax and no `JSON.stringify`
 * rendering.
 */
export type RealmTaggedValue = ReadonlyMap<string, RealmCodecValue>;

/**
 * The realm-crossing wire format, for a `CodecRegistry` to be built over.
 * Pairs the transport type with the symbol a `FabricPrimitive` binds its realm
 * codec under.
 */
export const REALM_FORMAT: WireFormat<RealmCodecValue> = Object.freeze({
  codecSymbol: REALM_CODEC,
});
