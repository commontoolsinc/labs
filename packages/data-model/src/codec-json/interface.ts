/**
 * JSON-compatible wire format value. This is the intermediate tree
 * representation used during serialization tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 *
 * Deep-frozen invariant: every wire tree that *enters deserialization* is
 * deep-frozen. This is enforced at the two construction sites that feed
 * `deserialize()` -- `decode()` and `fromBytes()`, unified in
 * `#parseWireText()` -- and is what lets `unwrapTag()` / the `/quote` arm
 * hand back extracted sub-trees directly (see their contracts). The transient
 * trees built on the *serialize* side are not covered by this invariant: they
 * are `JSON.stringify`-ed and discarded by `encode()` / `encodeToBytes()` and
 * never reach a caller. (The serialize-side `/quote` form happens to be
 * deep-frozen as a side effect of `unquote()`'s recursive rebuild, but no
 * other serialize output is, and none needs to be.)
 */
export type JsonWireValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonWireValue[]
  | { readonly [key: string]: JsonWireValue };
