/**
 * This module previously contained the tree-walking `serialize()` and
 * `deserialize()` functions, plus `ByteTagCodec`. All of that machinery has
 * been folded into `JsonEncodingContext` as private methods. External callers
 * should use the `SerializationContext<string>` interface (encode/decode) or
 * the `JsonEncodingContext` class directly.
 *
 * This file is intentionally empty and retained only so the deno.json export
 * entry does not break downstream resolution. It will be removed in a future
 * cleanup pass.
 */
