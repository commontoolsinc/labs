/**
 * Canonical type tags for the `/<Type>@<Version>` wire format. Collected in a
 * single frozen object so that use sites are type-checked for valid tag
 * reference, and literal strings don't end up bit-rotting inadvertently.
 *
 * Constant names are un-versioned as a baseline. If and when we need to support
 * multiple versions of a type, the current one stays unmarked and old versions
 * get a `V1` suffix (or similar).
 *
 * See Section 5.2 of the formal spec.
 */
export const TAGS = Object.freeze(
  {
    // -- Instance types (deserialized via class registry) --
    Error: "Error@1",
    Map: "Map@1",
    Set: "Set@1",
    Date: "Date@1",
    Bytes: "Bytes@1",

    // -- Primitive type handlers --
    BigInt: "BigInt@1",
    Undefined: "Undefined@1",

    // -- Structural / meta tags (serialization format) --
    quote: "quote",
    hole: "hole",
    object: "object",
  } as const,
);
